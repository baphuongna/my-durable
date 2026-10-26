/**
 * Windows bug chain, platform-agnostic: CI is Linux and a Windows path cannot
 * be spawned here, so these tests pin the CONTRACT instead —
 *   1. gitPath/gitPathFor: argv paths go out forward-slashed on win32
 *   2. windowsHide: every child process is born hidden (no console flash)
 *   3. negative cache: a failing path costs ONE spawn per TTL, not one per poll
 *   4. non-repo cache: a plain folder's `repo:false` costs ONE spawn per TTL
 *   5. single-flight: N concurrent status calls for a path share ONE spawn
 *
 * `node:child_process`'s ESM namespace is not redefinable (mock.method throws
 * "Cannot redefine property: execFile"), so the module exposes an explicit
 * seam: setGitExecForTests().
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { execFile, execFileSync } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  gitPath,
  gitPathFor,
  gitStatus,
  git,
  gh,
  GIT_EXEC_OPTS,
  GH_EXEC_OPTS,
  setGitExecForTests,
  clearGitStatusCache,
  cacheKey,
  markDirty,
} from "../src/git.js";

const sh = (cmd: string, args: string[], cwd?: string) => execFileSync(cmd, args, { cwd, encoding: "utf8" });

function repo() {
  const root = mkdtempSync(join(tmpdir(), "dpi-git-win-"));
  sh("git", ["init", "-b", "main"], root);
  sh("git", ["config", "user.email", "t@t"], root);
  sh("git", ["config", "user.name", "t"], root);
  return root;
}

/** Run `fn` with process.platform pretending to be `platform`. */
async function withPlatform<T>(platform: NodeJS.Platform, fn: () => Promise<T> | T): Promise<T> {
  const original = process.platform;
  Object.defineProperty(process, "platform", { value: platform, configurable: true });
  try {
    return await fn();
  } finally {
    Object.defineProperty(process, "platform", { value: original, configurable: true });
  }
}

interface Captured {
  file: string;
  args: string[];
  opts: Record<string, unknown>;
}
type ExecCb = (error: Error | null, stdout: string, stderr: string) => void;
type FakeExec = (file: string, args: string[], opts: Record<string, unknown>, cb: ExecCb) => unknown;

const asExecFile = (fake: FakeExec) => fake as unknown as typeof execFile;

/** Install a seam that records every spawn and answers via `reply`. */
function captureSpawns(reply: (c: Captured) => { stdout?: string; stderr?: string; error?: Error } = () => ({})): Captured[] {
  const calls: Captured[] = [];
  setGitExecForTests(
    asExecFile((file, args, opts, cb) => {
      const c = { file, args, opts };
      calls.push(c);
      const r = reply(c);
      // Answer on a later tick, like a real spawn — single-flight needs the gap.
      setTimeout(() => cb(r.error ?? null, r.stdout ?? "", r.stderr ?? ""), 5);
      return { on() {}, kill() {} };
    }),
  );
  return calls;
}

const restore = () => setGitExecForTests();

/** Install a seam that delegates to the REAL execFile once `ok()` turns true,
 *  and answers with a fixed failure before that. */
function failThenReal(ok: () => boolean, stderr: string): { calls: () => number } {
  const real = execFile as unknown as FakeExec;
  let n = 0;
  setGitExecForTests(
    asExecFile((file, args, opts, cb) => {
      n++;
      if (ok()) return real(file, args, opts, cb);
      setTimeout(() => cb(Object.assign(new Error("Command failed"), { code: 128 }), "", stderr), 5);
      return { on() {}, kill() {} };
    }),
  );
  return { calls: () => n };
}

// ---------------------------------------------------------------- 1. gitPath

test("gitPathFor: win32 backslashes become forward slashes (msys argv layer)", () => {
  assert.equal(gitPathFor("D:\\source\\reconcile-backend-v2", "win32"), "D:/source/reconcile-backend-v2");
  assert.equal(gitPathFor("C:\\a\\b\\c", "win32"), "C:/a/b/c");
  // Already forward-slashed: unchanged, never doubled.
  assert.equal(gitPathFor("D:/source/repo", "win32"), "D:/source/repo");
  // Spaces survive untouched (argv is not a shell string).
  assert.equal(gitPathFor("C:\\Program Files\\My Repo", "win32"), "C:/Program Files/My Repo");
  // UNC shares too.
  assert.equal(gitPathFor("\\\\server\\share\\repo", "win32"), "//server/share/repo");
});

test("gitPathFor: POSIX is a no-op", () => {
  assert.equal(gitPathFor("/home/x/y", "linux"), "/home/x/y");
  assert.equal(gitPathFor("/home/x/y", "darwin"), "/home/x/y");
  // A backslash is a LEGAL filename character on POSIX — must not be rewritten.
  assert.equal(gitPathFor("/home/x/we\\ird", "linux"), "/home/x/we\\ird");
});

test("gitPath: follows the running platform", async () => {
  await withPlatform("win32", () => assert.equal(gitPath("D:\\source\\repo"), "D:/source/repo"));
  assert.equal(gitPath("/home/x/y"), "/home/x/y"); // back on the real platform
});

// ------------------------------------------------------------- 2. windowsHide

test("GIT_EXEC_OPTS / GH_EXEC_OPTS: windowsHide is on, buffers preserved", () => {
  const g = GIT_EXEC_OPTS(15_000);
  assert.equal(g.windowsHide, true);
  assert.equal(g.timeout, 15_000);
  assert.equal(g.maxBuffer, 8 * 1024 * 1024);
  const h = GH_EXEC_OPTS("/tmp", 4_000);
  assert.equal(h.windowsHide, true);
  assert.equal(h.cwd, "/tmp");
  assert.equal(h.timeout, 4_000);
  assert.equal(h.maxBuffer, 4 * 1024 * 1024);
});

test("git()/gh(): real spawn options carry windowsHide:true", async () => {
  const calls = captureSpawns();
  try {
    await git(tmpdir(), ["--version"]);
    await gh(tmpdir(), ["--version"]);
  } finally {
    restore();
  }
  const [gitCall, ghCall] = calls;
  assert.equal(gitCall?.file, "git");
  assert.equal(gitCall?.opts.windowsHide, true, `git opts: ${JSON.stringify(gitCall?.opts)}`);
  assert.equal(ghCall?.file, "gh");
  assert.equal(ghCall?.opts.windowsHide, true, `gh opts: ${JSON.stringify(ghCall?.opts)}`);
  // gh resolves the repo from Node's cwd option — NOT from argv.
  assert.equal(ghCall?.opts.cwd, tmpdir());
  assert.ok(!ghCall?.args.includes(tmpdir()), "gh cwd must not be pushed into argv");
});

test("git(): the -C argument is forward-slashed on win32 (the reported bug)", async () => {
  const calls = captureSpawns();
  try {
    await withPlatform("win32", () => git("D:\\source\\reconcile-backend-v2", ["status"]));
  } finally {
    restore();
  }
  assert.deepEqual(calls[0]?.args, ["-C", "D:/source/reconcile-backend-v2", "status"]);
});

test("gitOp: -- path args (diff-file, worktree add/remove) are normalized too", async () => {
  const calls = captureSpawns((c) => {
    // Answer the ops that read stdout so gitOp does not throw on empty output.
    if (c.args.includes("rev-parse")) return { stdout: "D:/repo\n" };
    return {};
  });
  const { gitOp } = await import("../src/git.js");
  // worktree targets must satisfy node:path isAbsolute, which on THIS (Linux)
  // host means a leading "/" — so the target here is host-absolute but carries
  // backslashes, which is exactly what gitPath must rewrite on win32. (The
  // pure "C:\\work\\wt" → "C:/work/wt" case is covered by gitPathFor above.)
  try {
    await withPlatform("win32", async () => {
      await gitOp("D:\\repo", "diff-file", { target: "src\\a b\\c.ts" });
      await gitOp("D:\\repo", "worktree-add", { branch: "feat", target: "/tmp/work\\wt" });
      await gitOp("D:\\repo", "worktree-remove", { target: "/tmp/work\\wt" });
    });
  } finally {
    restore();
  }
  const diffFile = calls.find((c) => c.args.includes("diff"))!;
  assert.equal(diffFile.args.at(-1), "src/a b/c.ts");
  const adds = calls.filter((c) => c.args.includes("add") && c.args.includes("worktree"));
  assert.ok(adds.some((c) => c.args.includes("/tmp/work/wt")), `worktree-add target: ${JSON.stringify(adds.map((c) => c.args))}`);
  const removes = calls.filter((c) => c.args.includes("remove"));
  assert.ok(removes.some((c) => c.args.includes("/tmp/work/wt")), `worktree-remove target: ${JSON.stringify(removes.map((c) => c.args))}`);
  // And the -C path itself, once per call.
  assert.ok(calls.every((c) => c.args[0] === "-C" && c.args[1] === "D:/repo"));
});

test("gitOp: `-- <files>` lists are normalized too (stage/commit/unstage)", async () => {
  const calls = captureSpawns((c) => (c.args.includes("rev-parse") ? { stdout: "D:/repo\n" } : {}));
  const { gitOp } = await import("../src/git.js");
  try {
    await withPlatform("win32", async () => {
      await gitOp("D:\\repo", "stage", { files: ["src\\a.ts", "dir\\b c.ts"] });
      await gitOp("D:\\repo", "unstage", { files: ["src\\a.ts"] });
      await gitOp("D:\\repo", "commit", { message: "m", files: ["src\\a.ts"] });
    });
  } finally {
    restore();
  }
  const after = (marker: string) => calls.find((c) => c.args.includes(marker))!.args.slice(calls.find((c) => c.args.includes(marker))!.args.indexOf("--") + 1);
  assert.deepEqual(after("add"), ["src/a.ts", "dir/b c.ts"]);
  assert.deepEqual(after("reset"), ["src/a.ts"]);
  assert.deepEqual(after("commit"), ["src/a.ts"]);
});

// ---------------------------------------------------------- 3. negative cache

test("gitStatus: a failure is cached (STATUS_FAIL_TTL) — no spawn storm, message preserved", async () => {
  clearGitStatusCache();
  const dir = mkdtempSync(join(tmpdir(), "dpi-git-broken-"));
  const boom = () => ({ error: Object.assign(new Error("Command failed"), { code: 128 }), stderr: "fatal: cannot change to 'D:source?econcile-backend-v2'" });
  const calls = captureSpawns(boom);
  try {
    // 1st: spawns, rejects with the REAL stderr (never flattened to repo:false).
    const first = await gitStatus(dir).then(
      () => assert.fail("must reject"),
      (e: Error) => e,
    );
    assert.match(first.message, /cannot change to/);
    const afterFirst = calls.length;
    assert.ok(afterFirst >= 1, "first call must reach git");

    // 2nd within the fail TTL: same error, ZERO new spawns.
    const second = await gitStatus(dir).then(
      () => assert.fail("must reject"),
      (e: Error) => e,
    );
    assert.equal(second.message, first.message, "the UI must see the same error text");
    assert.equal(calls.length, afterFirst, `no spawn allowed inside the fail TTL, got ${calls.length - afterFirst}`);

    // 3rd after the TTL: git is tried again.
    const later = await gitStatus(dir, Date.now() + 16_000).then(
      () => assert.fail("must reject"),
      (e: Error) => e,
    );
    assert.match(later.message, /cannot change to/);
    assert.ok(calls.length > afterFirst, "an expired failure must be retried");
  } finally {
    restore();
    clearGitStatusCache();
    rmSync(dir, { recursive: true, force: true });
  }
});

test("gitStatus: a later SUCCESS clears the cached failure", async () => {
  clearGitStatusCache();
  const root = repo();
  let healthy = false;
  const spy = failThenReal(() => healthy, "fatal: permission denied");
  try {
    await assert.rejects(() => gitStatus(root), /git failed on the device: fatal: permission denied/);
    const afterFail = spy.calls();
    // Inside the fail TTL: served from the cache, no spawn.
    await assert.rejects(() => gitStatus(root), /permission denied/);
    assert.equal(spy.calls(), afterFail, "cached failure must not spawn");
    // Past the TTL, git is healthy again → the retry succeeds…
    healthy = true;
    const ok = await gitStatus(root, Date.now() + 16_000);
    assert.equal(ok.repo, true);
    // …and success wiped the failure entry: at t+6s the SUCCESS cache (5s TTL)
    // is stale but the FAIL entry (15s TTL) would still be fresh if it had
    // survived — so a resolved answer here proves the failure was cleared.
    const again = await gitStatus(root, Date.now() + 6_000);
    assert.equal(again.repo, true);
  } finally {
    restore();
    clearGitStatusCache();
    rmSync(root, { recursive: true, force: true });
  }
});

// ------------------------------------------- 4. non-repo answers are cached
// A plain (non-git) folder is the COMMON case for sessions, and "not a
// repository" is a legitimate answer — it must cost one spawn per TTL, not one
// per UI poll tick (each spawn flashes a console window on Windows).
const NOT_A_REPO = "fatal: not a git repository (or any of the parent directories): .git";
const notARepo = () => ({ error: Object.assign(new Error("Command failed"), { code: 128 }), stderr: NOT_A_REPO });
/** Comfortably past STATUS_TTL (5s), like the fail-cache tests use 16s for 15s. */
const pastStatusTtl = () => Date.now() + 6_000;

test("gitStatus: a non-repo directory is cached — 5 sequential calls → 1 spawn", async () => {
  clearGitStatusCache();
  const dir = mkdtempSync(join(tmpdir(), "dpi-git-plain-"));
  const calls = captureSpawns(notARepo);
  try {
    const all = [];
    for (let i = 0; i < 5; i++) all.push(await gitStatus(dir));
    assert.equal(calls.length, 1, `spawns: ${calls.length} (expected 1 — repo:false must be cached)`);
    for (const s of all) assert.equal(s.repo, false);
    // Same answer object for every caller, and nothing cached as a FAILURE.
    assert.equal(new Set(all).size, 1, "all callers must get the SAME cached answer");
  } finally {
    restore();
    clearGitStatusCache();
    rmSync(dir, { recursive: true, force: true });
  }
});

test("gitStatus: the non-repo answer expires after STATUS_TTL", async () => {
  clearGitStatusCache();
  const dir = mkdtempSync(join(tmpdir(), "dpi-git-plain-ttl-"));
  const calls = captureSpawns(notARepo);
  try {
    assert.equal((await gitStatus(dir)).repo, false);
    assert.equal(calls.length, 1);
    // Aged past STATUS_TTL → git is asked again (the cache is not permanent).
    assert.equal((await gitStatus(dir, pastStatusTtl())).repo, false);
    assert.equal(calls.length, 2, `spawns: ${calls.length} (expected 2 after the TTL)`);
  } finally {
    restore();
    clearGitStatusCache();
    rmSync(dir, { recursive: true, force: true });
  }
});

test("gitStatus: a directory that BECOMES a repo is picked up after the TTL", async () => {
  clearGitStatusCache();
  const dir = mkdtempSync(join(tmpdir(), "dpi-git-becomes-"));
  try {
    // Real git: a bare tmp dir is genuinely not a repository.
    assert.equal((await gitStatus(dir)).repo, false);
    // …and the cached repo:false is served without asking git again.
    assert.equal((await gitStatus(dir)).repo, false);

    sh("git", ["init", "-b", "main"], dir);
    // Inside the TTL the old answer stands (that is the documented trade-off);
    // a plain dir has no fs watcher, so the TTL is the recovery path.
    assert.equal((await gitStatus(dir)).repo, false, "still cached inside the TTL");
    // Past the TTL the new repo shows up with no restart.
    const fresh = await gitStatus(dir, pastStatusTtl());
    assert.equal(fresh.repo, true);
    assert.equal(fresh.root, dir);
  } finally {
    clearGitStatusCache();
    rmSync(dir, { recursive: true, force: true });
  }
});

// ------------------------------------------------------------ 5. single-flight

test("gitStatus: 5 concurrent calls for one path share ONE spawn and one answer", async () => {
  clearGitStatusCache();
  const root = repo();
  const real = execFile as unknown as FakeExec;
  let revParse = 0;
  setGitExecForTests(
    asExecFile((file, args, opts, cb) => {
      // argv is ["-C", <path>, "rev-parse", "--show-toplevel", ...]
      if (args[0] === "-C" && args[2] === "rev-parse" && args[3] === "--show-toplevel") revParse++;
      return real(file, args, opts, cb);
    }),
  );
  try {
    const all = await Promise.all([1, 2, 3, 4, 5].map(() => gitStatus(root)));
    assert.equal(revParse, 1, `rev-parse spawns: ${revParse} (expected 1)`);
    for (const s of all) {
      assert.equal(s.repo, true);
      assert.equal(s.root, root);
    }
    assert.equal(new Set(all).size, 1, "all waiters must get the SAME resolved object");
  } finally {
    restore();
    clearGitStatusCache();
    rmSync(root, { recursive: true, force: true });
  }
});

test("gitStatus: a shared in-flight FAILURE rejects for every waiter, one spawn", async () => {
  clearGitStatusCache();
  const dir = mkdtempSync(join(tmpdir(), "dpi-git-shared-fail-"));
  let spawns = 0;
  setGitExecForTests(
    asExecFile((_file, _args, _opts, cb) => {
      spawns++;
      setTimeout(() => cb(Object.assign(new Error("x"), { code: 128 }), "", "fatal: permission denied"), 5);
      return { on() {}, kill() {} };
    }),
  );
  try {
    const results = await Promise.allSettled([1, 2, 3, 4, 5].map(() => gitStatus(dir)));
    assert.equal(spawns, 1, `spawns: ${spawns} (expected 1)`);
    assert.equal(results.filter((r) => r.status === "rejected").length, 5);
  } finally {
    restore();
    clearGitStatusCache();
    rmSync(dir, { recursive: true, force: true });
  }
});

// ------------------------------------------------------------ 6. cache keys
// Round-4 win-compat: ONE cache entry per repo, not per spelling. `d:/repo`,
// `D:/repo/` and `D:\repo` must share a single key (and a single in-flight
// spawn), and a watcher dirty-mark must find the entry under ANY spelling.

test("cacheKey: one key per repo spelling — slashes, trailing slash, case", () => {
  assert.equal(cacheKey("D:\\source\\repo", "win32"), "d:/source/repo");
  assert.equal(cacheKey("d:/source/repo/", "win32"), "d:/source/repo");
  assert.equal(cacheKey("D:/SOURCE/Repo", "win32"), "d:/source/repo");
  // Root edge cases survive: "/" stays "/", UNC shares keep their double slash.
  assert.equal(cacheKey("/", "win32"), "/");
  assert.equal(cacheKey("//server/share/", "win32"), "//server/share");
  // POSIX: byte-identical — case matters and a backslash is a legal filename char.
  assert.equal(cacheKey("/home/x/Repo", "linux"), "/home/x/Repo");
  assert.equal(cacheKey("/home/x/re\\po", "linux"), "/home/x/re\\po");
  assert.equal(cacheKey("/tmp/x/", "linux"), "/tmp/x");
});

test("cacheKey vs gitPathFor: cache keys fold case on win32, argv paths never do", () => {
  // argv must preserve case (git reads the real filesystem); the CACHE must not.
  assert.equal(gitPathFor("D:/Source/Repo", "win32"), "D:/Source/Repo");
  assert.equal(cacheKey("D:/Source/Repo", "win32"), "d:/source/repo");
});

test("gitStatus: d:/repo, D:/repo/ and D:\\repo land on ONE entry — one spawn", async () => {
  clearGitStatusCache();
  let revParse = 0;
  const calls = captureSpawns((c) => {
    if (c.args.includes("--show-toplevel")) {
      revParse++;
      return { stdout: "d:/repo\n" };
    }
    return {};
  });
  try {
    const all = await withPlatform("win32", () =>
      Promise.all([gitStatus("d:/repo"), gitStatus("D:/repo/"), gitStatus("D:\\repo")]),
    );
    assert.equal(revParse, 1, `rev-parse spawns: ${revParse} (expected 1 — the three spellings share one entry)`);
    for (const s of all) assert.equal(s.repo, true);
    // A fourth spelling inside the TTL is served from the SAME entry: no spawn.
    await withPlatform("win32", () => gitStatus("D:/REPO"));
    assert.equal(revParse, 1, "a case-only respelling must hit the cached entry");
    assert.ok(calls.length >= 13, "the one statusOnce should have made its git calls");
  } finally {
    restore();
    clearGitStatusCache();
  }
});

test("markDirty: 'D:\\repo' invalidates the entry cached as 'd:/repo' — siblings survive", async () => {
  clearGitStatusCache();
  let revParse = 0;
  captureSpawns((c) => {
    if (c.args.includes("--show-toplevel")) {
      revParse++;
      return { stdout: "d:/repo\n" };
    }
    return {};
  });
  try {
    await withPlatform("win32", () => gitStatus("d:/repo"));
    await withPlatform("win32", () => gitStatus("d:/repo-other"));
    assert.equal(revParse, 2, "two distinct repos, two spawns");
    // Same TTL window: both answers are cached, no new spawns (a trailing
    // slash and a case-only respelling hit the same entries).
    await withPlatform("win32", () => gitStatus("D:/repo/"));
    await withPlatform("win32", () => gitStatus("d:/repo-other"));
    assert.equal(revParse, 2);
    // The watcher reports the root the way GIT prints it on Windows
    // (backslashes, real case): the canonical mark must still find the entry,
    // and must not touch the sibling prefix `d:/repo-other`.
    await withPlatform("win32", () => markDirty("D:\\repo"));
    await withPlatform("win32", () => gitStatus("d:/repo"));
    assert.equal(revParse, 3, "markDirty must have invalidated the cached status");
    await withPlatform("win32", () => gitStatus("d:/repo-other"));
    assert.equal(revParse, 3, "the sibling d:/repo-other must still be cached");
  } finally {
    restore();
    clearGitStatusCache();
  }
});
