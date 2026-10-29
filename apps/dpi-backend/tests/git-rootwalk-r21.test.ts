/**
 * run-7 D1: git repo discovery WALKS UP from a contained path — a start dir
 * that is a slice of a bigger repo made gitStatus disclose the whole
 * out-of-sandbox repo (root, files[], branches, worktrees, remoteUrl) and op
 * "ignore" even WRITE .gitignore at the foreign root. The store-installed
 * repo-root guard must clamp status to repo-presence-only and refuse the write.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { createServer, type Server } from "node:http";
import { execFileSync } from "node:child_process";
import { mkdirSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import express from "express";
import { Store } from "../src/store.js";
import { bearerAuth } from "../src/auth.js";
import { errorMiddleware } from "../src/errors.js";
import { v1 } from "../src/routes.js";
import { newToken } from "./helpers.js";

const sh = (args: string[], cwd: string) => execFileSync("git", args, { cwd, encoding: "utf8" });

test("status from a contained slice must not disclose the enclosing repo (run-7 D1)", async () => {
  const root = join(tmpdir(), `dpi-rootwalk-${Date.now()}`);
  const R = join(root, "repo");
  mkdirSync(R, { recursive: true });
  sh(["init", "-b", "main", "-q"], R);
  sh(["config", "user.email", "t@t"], R);
  sh(["config", "user.name", "t"], R);
  writeFileSync(join(R, "committed.txt"), "ok\n");
  sh(["add", "."], R);
  sh(["commit", "-m", "base", "-q"], R);
  const secret = "secret-untracked-at-root.txt";
  writeFileSync(join(R, secret), "top-secret\n"); // out-of-sandbox dirt at the repo ROOT
  const slice = join(R, "slice");
  mkdirSync(slice);

  const token = newToken();
  const store = await Store.open({ dataDir: join(root, "data"), startDirs: [slice], name: "rootwalk-box", provider: "faux" });
  const app = express();
  app.use("/v1", bearerAuth(token), express.json({ limit: "256kb" }), v1(store));
  app.use(errorMiddleware);
  const server: Server = createServer(app);
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", () => r()));
  const base = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
  const api = (path: string, init: RequestInit = {}) =>
    fetch(`${base}${path}`, { ...init, headers: { authorization: `Bearer ${token}`, "content-type": "application/json", ...(init.headers ?? {}) } });
  try {
    const res = await api(`/v1/git/status?path=${encodeURIComponent(slice)}`);
    assert.equal(res.status, 200);
    const s = (await res.json()) as { repo: boolean; root?: string; files?: { path: string }[] };
    assert.equal(s.repo, true, "repo presence is still reported");
    assert.equal(s.root, undefined, "the out-of-sandbox root must not be disclosed");
    assert.equal((s.files ?? []).some((f) => f.path.includes(secret)), false, "out-of-sandbox dirt must not leak");
    // write-side: op ignore targets the repo root — must be refused
    const ig = await api("/v1/git", { method: "POST", body: JSON.stringify({ op: "ignore", path: slice, lines: ["build/"] }) });
    assert.equal(ig.status, 400, "ignore at a foreign repo root must be refused");
  } finally {
    server.closeAllConnections();
    await new Promise<void>((r) => server.close(() => r()));
    await store.close().catch(() => {});
    rmSync(root, { recursive: true, force: true });
  }
});
