/**
 * R15 (run-2 h6): containedPath must judge not-yet-existing paths by their
 * deepest EXISTING ancestor — a worktree-add target spelled under an
 * in-start-dir symlink pointing OUTSIDE the start dirs used to pass the old
 * lexical prefix check (the branch every worktree-add takes, since git
 * requires the target not to exist), handing git a checkout path that escapes
 * the operator's sandbox (leader probe: `git worktree add` follows the symlink
 * and lands the checkout outside).
 * Level: integration, loopback http, scratch dirs only.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { createServer, type Server } from "node:http";
import { execFileSync } from "node:child_process";
import { existsSync, mkdtempSync, rmSync, symlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import express from "express";
import { Store } from "../src/store.js";
import { bearerAuth } from "../src/auth.js";
import { errorMiddleware } from "../src/errors.js";
import { v1 } from "../src/routes.js";
import { newToken, tempStore } from "./helpers.js";

async function backend() {
  const t = await tempStore();
  const token = newToken();
  const store = await Store.open({ ...t.options, name: "symlink-contain-box" });
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
  return { t, store, api, close };
}

test("R15 h6: worktree target under an escaping symlink is refused (no lexical pass)", async () => {
  const b = await backend();
  const vault = mkdtempSync(join(tmpdir(), "dpi-vault-"));
  try {
    const repo = join(b.t.work, "repo");
    execFileSync("git", ["init", "-b", "main", repo], { encoding: "utf8" });
    execFileSync("git", ["-C", repo, "config", "user.email", "t@t"], { encoding: "utf8" });
    execFileSync("git", ["-C", repo, "config", "user.name", "t"], { encoding: "utf8" });
    execFileSync("git", ["-C", repo, "commit", "--allow-empty", "-m", "x"], { encoding: "utf8" });
    // The escaping symlink: inside the start dir, pointing at the outside vault.
    symlinkSync(vault, join(repo, "link"));

    // The attack: worktree target spelled under the symlink (must not exist —
    // git's own requirement), lexically "inside" the start dir.
    const res = await b.api("/v1/git", {
      method: "POST",
      body: JSON.stringify({ op: "worktree-add", path: repo, ref: "HEAD", target: join(repo, "link", "wt") }),
    });
    assert.equal(res.status, 400, "escaping worktree target must be refused");
    assert.equal(existsSync(join(vault, "wt")), false, "nothing may land in the vault");

    // Control: a plain in-start-dir target still works.
    const res2 = await b.api("/v1/git", {
      method: "POST",
      body: JSON.stringify({ op: "worktree-add", path: repo, ref: "HEAD", target: join(b.t.work, "wt-ok") }),
    });
    assert.equal(res2.status, 200, "plain worktree target must still be allowed");
    assert.equal(existsSync(join(b.t.work, "wt-ok")), true);

    // Unit level: containedPath itself now rejects the symlink-spelled
    // not-yet-existing path (the old lexical fallback returned it as-is).
    await assert.rejects(() => b.store.containedPath(join(repo, "link", "wt2")), /path must live under a start dir/);
    // And a DEEP not-yet-existing chain (>64 missing components) under the
    // same symlink must fail CLOSED — the first fix's iteration cap silently
    // fell back to the lexical spelling (cold review P1-2).
    const deep = join(repo, "link", ...Array<string>(70).fill("d"));
    await assert.rejects(() => b.store.containedPath(deep), /path must live under a start dir/);
    // And a genuinely new path INSIDE the start dir still resolves.
    const inside = await b.store.containedPath(join(b.t.work, "brand-new-dir", "sub"));
    assert.equal(inside, join(b.t.work, "brand-new-dir", "sub"));
  } finally {
    await b.close();
    rmSync(vault, { recursive: true, force: true });
  }
});
