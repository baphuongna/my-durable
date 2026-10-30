/**
 * Audit run-1 MEDIUM — worktree-target containment: POST /v1/git
 * op=worktree-add|worktree-remove forwarded body.target raw into gitOp, whose
 * only check was isAbsolute() — planting/deleting full checkouts at any
 * absolute path outside the operator's start dirs. The fix routes the target
 * through store.containedPath() at the same choke point as every other fs
 * path on the route.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { createServer, type Server } from "node:http";
import { execFileSync } from "node:child_process";
import { mkdtempSync, existsSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import express from "express";
import { Store } from "../src/store.js";
import { bearerAuth } from "../src/auth.js";
import { errorMiddleware } from "../src/errors.js";
import { v1 } from "../src/routes.js";
import { newToken, tempStore } from "./helpers.js";

const sh = (cmd: string, args: string[], opts: { cwd?: string } = {}) =>
  execFileSync(cmd, args, { ...opts, encoding: "utf8" });

async function backend() {
  const t = await tempStore();
  const token = newToken();
  const store = await Store.open({ ...t.options, name: "git-contain-box" });
  const app = express();
  app.use("/v1", bearerAuth(token), express.json({ limit: "256kb" }), v1(store));
  app.use(errorMiddleware);
  const server = createServer(app);
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", () => r()));
  const base = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
  const api = (path: string, init: RequestInit = {}) =>
    fetch(`${base}${path}`, {
      ...init,
      headers: { authorization: `Bearer ${token}`, "content-type": "application/json", ...(init.headers ?? {}) },
    });
  const close = async () => {
    server.closeAllConnections();
    await new Promise<void>((r) => server.close(() => r()));
    await store.close().catch(() => {});
    await t.cleanup();
  };
  return { t, api, close };
}

test("worktree-add/remove targets must live under a start dir (audit run-1)", async () => {
  const b = await backend();
  try {
    // A real repo inside the first start dir.
    const root = join(b.t.work, "repo");
    sh("git", ["init", "-b", "main", root]);
    sh("git", ["config", "user.email", "t@t"], { cwd: root });
    sh("git", ["config", "user.name", "t"], { cwd: root });
    execFileSync("git", ["commit", "--allow-empty", "-m", "first"], { cwd: root, encoding: "utf8" });

    // OUTSIDE every start dir: the plant must be refused before any git spawn.
    const outside = join(mkdtempSync(join(tmpdir(), "dpi-outside-")), "wt");
    let res = await b.api("/v1/git", {
      method: "POST",
      body: JSON.stringify({ op: "worktree-add", path: root, branch: "feat", target: outside }),
    });
    assert.equal(res.status, 400);
    assert.match((await res.json()).error.message, /path must live under a start dir/);
    assert.equal(existsSync(outside), false, "nothing may be planted outside the start dirs");

    // Remove of an outside target is refused on the same choke point.
    res = await b.api("/v1/git", {
      method: "POST",
      body: JSON.stringify({ op: "worktree-remove", path: root, target: outside }),
    });
    assert.equal(res.status, 400);
    assert.match((await res.json()).error.message, /path must live under a start dir/);

    // INSIDE a start dir: the operation still works (round trip).
    const inside = join(b.t.work, "wt-inside");
    res = await b.api("/v1/git", {
      method: "POST",
      body: JSON.stringify({ op: "worktree-add", path: root, branch: "feat", target: inside }),
    });
    assert.equal(res.status, 200);
    assert.equal(existsSync(join(inside, ".git")), true, "worktree created inside the start dir");
    res = await b.api("/v1/git", {
      method: "POST",
      body: JSON.stringify({ op: "worktree-remove", path: root, target: inside }),
    });
    assert.equal(res.status, 200);
    assert.equal(existsSync(inside), false, "worktree removed");

    rmSync(root, { recursive: true, force: true });
  } finally {
    await b.close();
  }
});

test("run-8 (live): a session's own folder stays served after DPI_START_DIRS is narrowed; anything else is still refused", async () => {
  const { tempStore } = await import("./helpers.js");
  const t = await tempStore();
  try {
    // 1. Session created while the folder WAS a start dir (the laptop's case).
    const wide = { ...t.options, startDirs: [t.work, join(t.root, "other")] };
    const mkdir = (await import("node:fs/promises")).mkdir;
    await mkdir(join(t.root, "other"), { recursive: true });
    const s1 = await Store.open(wide);
    const row = await s1.create({ name: "legacy", cwd: join(t.root, "other"), model: { provider: "faux", modelId: "echo" } });
    await s1.close();

    // 2. Reopen with the start-dir list NARROWED to work only.
    const s2 = await t.open();
    const served = await s2.containedPath(join(t.root, "other"));
    assert.equal(served, await (await import("node:fs/promises")).realpath(join(t.root, "other")), "the session folder is still served");
    const nested = await s2.containedPath(join(t.root, "other", "sub"));
    assert.ok(nested.endsWith("sub"), "children of a session folder are served too");

    // 3. A folder that never hosted a session is still refused.
    await mkdir(join(t.root, "elsewhere"), { recursive: true });
    await assert.rejects(() => s2.containedPath(join(t.root, "elsewhere")), /start dir/);

    // 4. Creating a NEW session outside the start dirs is still refused.
    await assert.rejects(
      () => s2.create({ name: "nope", cwd: join(t.root, "elsewhere"), model: { provider: "faux", modelId: "echo" } }),
      /start dir/,
    );

    // 5. deviceInfo reports the same set the enforcer uses.
    const info = s2.deviceInfo();
    assert.ok(Array.isArray(info.gitDirs) && info.gitDirs.some((d) => d.includes("other")), `gitDirs carries the session folder: ${JSON.stringify(info.gitDirs)}`);
    assert.equal(row.cwd.includes("other"), true);
    await s2.close();
  } finally {
    await t.cleanup();
  }
});
