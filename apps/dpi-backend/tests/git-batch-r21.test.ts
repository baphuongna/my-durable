/**
 * R21 (index 400s): POST /v1/git/status-batch with a project root left over
 * from OTHER start dirs (device restarted with a narrower sandbox — exactly
 * the Windows laptop case: startDirs C:\Users\..\dpi-work, project
 * D:\source\reconcile-backend-v2) used to reject the WHOLE batch from
 * Promise.all, so every project's chip died and the FE re-sent the doomed
 * request every stale window. The batch must settle per path: foreign roots
 * answer a bounded {error} entry keyed by the path AS SENT, contained repos
 * keep their real status.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { createServer, type Server } from "node:http";
import { execFileSync } from "node:child_process";
import { mkdirSync, rmSync } from "node:fs";
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

test("status-batch: one foreign path must not kill the batch (R21)", async () => {
  const t = await tempStore();
  const token = newToken();
  const store = await Store.open({ ...t.options, name: "git-batch-r21" });
  // a real repo INSIDE the start dir + a foreign dir OUTSIDE it
  const repo = join(t.work, "repo");
  mkdirSync(repo, { recursive: true });
  sh("git", ["init", "-b", "main", "-q"], { cwd: repo });
  sh("git", ["config", "user.email", "t@t"], { cwd: repo });
  sh("git", ["config", "user.name", "t"], { cwd: repo });
  const foreign = join(t.root, "outside", "reconcile-backend-v2");
  const app = express();
  app.use("/v1", bearerAuth(token), express.json({ limit: "256kb" }), v1(store));
  app.use(errorMiddleware);
  const server: Server = createServer(app);
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", () => r()));
  const base = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
  try {
    const res = await fetch(`${base}/v1/git/status-batch`, {
      method: "POST",
      headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
      body: JSON.stringify({ paths: [repo, foreign] }),
    });
    const text = await res.text();
    assert.equal(res.status, 200, `the batch survives a foreign path: ${text}`);
    const map = JSON.parse(text) as Record<string, { repo?: boolean; error?: string }>;
    assert.equal(map[repo]?.repo, true, "the contained repo still reports status");
    assert.match(map[foreign]?.error ?? "", /start dir/, "the foreign path answers a bounded error entry");
    assert.deepEqual(Object.keys(map).sort(), [repo, foreign].sort(), "entries are keyed by the path AS SENT");
  } finally {
    server.closeAllConnections();
    await new Promise<void>((r) => server.close(() => r()));
    await store.close().catch(() => {});
    rmSync(repo, { recursive: true, force: true });
    await t.cleanup();
  }
});
