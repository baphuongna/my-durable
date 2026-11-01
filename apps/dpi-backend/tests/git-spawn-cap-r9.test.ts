/**
 * run-9 B (status-batch spawn fan-out): POST /v1/git/status-batch with 50
 * paths used to fan out into ~650 CONCURRENT git children (2 guard spawns +
 * 11 parallel data spawns per path, every path in one Promise.all) — and the
 * UIs poll, so overlapping batches could stampede the process table. The fix
 * is a process-wide spawn budget in git.ts: every git() spawn takes a slot
 * from ONE semaphore; callers beyond the budget QUEUE (never fail) and start
 * the moment a slot frees. This test drives the real route with the exec seam
 * (setGitExecForTests) counting live spawns: peak concurrency must stay
 * <= GIT_SPAWN_BUDGET while EVERY path still resolves a full status.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { createServer, type Server } from "node:http";
import { execFile } from "node:child_process";
import { mkdirSync, rmSync } from "node:fs";
import { join } from "node:path";
import express from "express";
import { Store } from "../src/store.js";
import { bearerAuth } from "../src/auth.js";
import { errorMiddleware } from "../src/errors.js";
import { v1 } from "../src/routes.js";
import { newToken, tempStore } from "./helpers.js";
import { setGitExecForTests, clearGitStatusCache, GIT_SPAWN_BUDGET } from "../src/git.js";

type ExecCb = (error: Error | null, stdout: string, stderr: string) => void;
type FakeExec = (file: string, args: string[], opts: Record<string, unknown>, cb: ExecCb) => unknown;
const asExecFile = (fake: FakeExec) => fake as unknown as typeof execFile;

const PATHS = 50;

test("status-batch: 50 paths stay under the process-wide git spawn budget", async () => {
  const t = await tempStore();
  const token = newToken();
  const store = await Store.open({ ...t.options, name: "git-spawn-cap-r9" });
  // 50 plain dirs under the start dir — the fake git below makes each one a
  // "repo", so no real git init is needed (the spawn shape is what matters).
  const dirs = Array.from({ length: PATHS }, (_, i) => join(t.work, `repo-${String(i).padStart(2, "0")}`));
  for (const d of dirs) mkdirSync(d, { recursive: true });

  /** Answers every subcommand gitStatus() asks for, argv-keyed. Unknown
   *  calls FAIL loudly so a new spawn site shows up as a red test, not a
   *  silent wrong answer. */
  const reply = (args: string[]): { stdout: string } | { fail: string } => {
    const p = args[1] ?? ".";
    const sub = args.slice(2).join(" ");
    if (sub === "rev-parse --show-toplevel") return { stdout: p };
    if (sub === "rev-parse --absolute-git-dir") return { stdout: `${p}/.git` };
    if (sub === "rev-parse --git-dir") return { stdout: ".git" };
    if (sub === "rev-parse -q --verify MERGE_HEAD") return { fail: "exit 1: no merge in progress" };
    if (sub === "branch --show-current") return { stdout: "main" };
    if (sub === "log -1 --pretty=%h%x09%s") return { stdout: "deadbee\tfake subject" };
    if (sub === "--no-optional-locks status --porcelain=v1 -z -b") return { stdout: "## main...origin/main" };
    if (sub === "worktree list --porcelain") return { stdout: `worktree ${p}\nHEAD 0123456789abcdef\nbranch refs/heads/main\n` };
    if (sub.startsWith("for-each-ref")) return { stdout: "main\torigin/main\t1" };
    if (sub.startsWith("--no-optional-locks diff --numstat")) return { stdout: "" };
    if (sub === "var GIT_AUTHOR_IDENT") return { stdout: "Test User <t@example.test> 1730000000 +0000" };
    if (sub === "remote get-url origin") return { stdout: "" };
    return { fail: `git-spawn-cap-r9 fake does not know: git ${sub}` };
  };

  const live = { now: 0, peak: 0, total: 0 };
  setGitExecForTests(
    asExecFile((_file, args, _opts, cb) => {
      live.total++;
      live.now++;
      if (live.now > live.peak) live.peak = live.now;
      // Answer on a later tick, like a real spawn — a synchronous fake would
      // hide the fan-out (peak would always read 1).
      setTimeout(() => {
        live.now--;
        const r = reply(args);
        if ("fail" in r) cb(Object.assign(new Error(r.fail), { code: 1 }), "", r.fail);
        else cb(null, r.stdout, "");
      }, 1 + Math.floor(Math.random() * 3));
      return { on() {}, kill() {} };
    }),
  );
  clearGitStatusCache();

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
      body: JSON.stringify({ paths: dirs }),
    });
    const text = await res.text();
    assert.equal(res.status, 200, `the batch must answer 200: ${text}`);
    const map = JSON.parse(text) as Record<string, { repo?: boolean; branch?: string; error?: string }>;
    assert.equal(Object.keys(map).length, PATHS, "every requested path answers");
    for (const [p, s] of Object.entries(map))
      assert.equal(s.repo, true, `path ${p} still resolves a full status (${s.error ?? "no error"})`);
    assert.equal(map[dirs[0]!]?.branch, "main", "statuses are parsed answers, not stubs");
    // THE invariant: at no instant did more than GIT_SPAWN_BUDGET git
    // children run process-wide.
    assert.ok(
      live.peak <= GIT_SPAWN_BUDGET,
      `peak concurrent git spawns was ${live.peak} — must stay <= budget ${GIT_SPAWN_BUDGET}`,
    );
    // The budget was actually exercised: the batch spawned far MORE in total
    // than the budget allows at once, so queuing (never skipping) carried it.
    assert.ok(live.total > GIT_SPAWN_BUDGET, `${live.total} spawns total — the semaphore had work to queue`);
    assert.ok(live.peak >= 2, `peak ${live.peak} — spawns really did overlap`);
  } finally {
    setGitExecForTests(); // real execFile before store close/cleanup
    server.closeAllConnections();
    await new Promise<void>((r) => server.close(() => r()));
    await store.close().catch(() => {});
    rmSync(t.work, { recursive: true, force: true }); // also drops the watchers' dirs
    await t.cleanup();
  }
});
