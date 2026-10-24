import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { gitStatus, gitOp, gitStatusBatch, clearGitStatusCache } from "../src/git.ts";

const sh = (cmd: string, args: string[], opts: { cwd?: string } = {}) => execFileSync(cmd, args, { ...opts, encoding: "utf8" });

function repo(seed = true) {
  const root = mkdtempSync(join(tmpdir(), "dpi-git-"));
  sh("git", ["init", "-b", "main"], { cwd: root });
  sh("git", ["config", "user.email", "t@t"], { cwd: root });
  sh("git", ["config", "user.name", "t"], { cwd: root });
  if (seed) {
    writeFileSync(join(root, "a.txt"), "one\n");
    sh("git", ["add", "."], { cwd: root });
    sh("git", ["commit", "-m", "first"], { cwd: root });
  }
  return root;
}

test("gitStatus: changed FILES and local BRANCHES for pickers (IntelliJ-style commit)", async () => {
  const root = repo();
  writeFileSync(join(root, "a.txt"), "one\nCHANGED\n"); // modified
  writeFileSync(join(root, "new.txt"), "n\n"); // untracked
  const s = await gitStatus(root);
  assert.ok(s.files?.some((f) => f.path === "a.txt" && f.y === "M"), `files: ${JSON.stringify(s.files)}`);
  assert.ok(s.files?.some((f) => f.path === "new.txt" && f.x === "?" && f.y === "?"), "untracked file missing");
  assert.ok(s.branches?.some((b) => b.name === "main" && b.current), `branches: ${JSON.stringify(s.branches)}`);
  // staged-only commit via files list: stage one file, commit ONLY it
  writeFileSync(join(root, "b.txt"), "b\n");
  sh("git", ["add", "b.txt"], { cwd: root });
  const c = await gitOp(root, "commit", { message: "only b", files: ["b.txt"] });
  assert.match(c.text, /only b|b\.txt/);
  const after = await gitStatus(root);
  assert.ok(after.files?.some((f) => f.path === "a.txt"), "a.txt must survive a b-only commit");
  assert.ok(!after.files?.some((f) => f.path === "b.txt"), "b.txt committed but still listed");
  rmSync(root, { recursive: true, force: true });
});

test("gitStatusBatch: many paths, one call, map back", async () => {
  const a = repo();
  const b = repo();
  const nowhere = mkdtempSync(join(tmpdir(), "dpi-nogit2-"));
  const out = await gitStatusBatch([a, b, nowhere]);
  assert.equal(out[a]?.repo, true);
  assert.equal(out[b]?.repo, true);
  assert.equal(out[nowhere]?.repo, false);
  rmSync(a, { recursive: true, force: true });
  rmSync(b, { recursive: true, force: true });
  rmSync(nowhere, { recursive: true, force: true });
});

test("gitStatus: not a repo says so plainly", async () => {
  const dir = mkdtempSync(join(tmpdir(), "dpi-nogit-"));
  const s = await gitStatus(dir);
  assert.equal(s.repo, false);
  rmSync(dir, { recursive: true, force: true });
});

test("gitStatus: branch, head, clean counts on a fresh repo", async () => {
  const root = repo();
  const s = await gitStatus(root);
  assert.equal(s.repo, true);
  assert.equal(s.branch, "main");
  assert.equal(s.staged, 0);
  assert.equal(s.untracked, 0);
  assert.ok(s.head);
  assert.match(s.subject ?? "", /first/);
  assert.equal(s.worktrees?.length, 1);
  rmSync(root, { recursive: true, force: true });
});

test("gitStatus: staged/unstaged/untracked split and subfolder resolution", async () => {
  const root = repo();
  writeFileSync(join(root, "a.txt"), "one\ntwo\n"); // unstaged modification
  writeFileSync(join(root, "b.txt"), "new\n"); // untracked
  mkdirSync(join(root, "sub"));
  writeFileSync(join(root, "sub", "c.txt"), "x\n");
  sh("git", ["add", "sub/c.txt"], { cwd: root }); // staged new file
  const s = await gitStatus(join(root, "sub")); // inside a subfolder
  assert.equal(s.repo, true);
  assert.equal(s.root, root);
  assert.equal(s.staged, 1);
  assert.equal(s.unstaged, 1);
  assert.equal(s.untracked, 1);
  rmSync(root, { recursive: true, force: true });
});

test("gitStatus: a linked worktree is recognized as one", async () => {
  const root = repo();
  const wt = join(root, "..", `dpi-wt-linked-${Date.now()}`);
  sh("git", ["worktree", "add", wt, "-b", "wt-branch"], { cwd: root });
  const s = await gitStatus(wt);
  assert.equal(s.repo, true);
  assert.equal(s.branch, "wt-branch");
  assert.equal(s.worktreeOf, root);
  assert.equal(s.worktrees?.length, 2);
  sh("git", ["worktree", "remove", "--force", wt], { cwd: root });
  rmSync(root, { recursive: true, force: true });
  rmSync(wt, { recursive: true, force: true });
});

test("gitOp: diff, log, commit, branch — plain text out", async () => {
  const root = repo();
  writeFileSync(join(root, "a.txt"), "one\nCHANGED\n");
  const diff = await gitOp(root, "diff");
  assert.match(diff.text, /CHANGED/);
  const log = await gitOp(root, "log");
  assert.match(log.text, /first/);
  const commit = await gitOp(root, "commit", { message: "second" });
  assert.match(commit.text, /second/);
  const branches = await gitOp(root, "branch");
  assert.match(branches.text, /main/);
  rmSync(root, { recursive: true, force: true });
});

test("gitOp: switch/refs are validated — no shell ever gets them", async () => {
  const root = repo();
  await assert.rejects(() => gitOp(root, "switch", { ref: "main; rm -rf /" }), /needs a branch name/);
  await assert.rejects(() => gitOp(root, "commit", {}), /needs a message/);
  await assert.rejects(() => gitOp(root, "worktree-add", { ref: "x", target: "relative/path" }), /absolute/);
  rmSync(root, { recursive: true, force: true });
});

test("gitOp: worktree add/list/remove round trip", async () => {
  const root = repo();
  const wt = join(root, "..", `dpi-wt-op-${Date.now()}`);
  const added = await gitOp(root, "worktree-add", { branch: "feat", target: wt });
  assert.match(added.text, /feat|worktree|Preparing/i);
  const list = await gitOp(root, "worktree-list");
  assert.match(list.text, /dpi-wt-op/);
  const removed = await gitOp(root, "worktree-remove", { target: wt });
  assert.match(removed.text, /removed/i);
  rmSync(root, { recursive: true, force: true });
});

test("gitStatus: ±n line counts from numstat (staged uses cached, worktree uses HEAD diff)", async () => {
  const root = repo();
  writeFileSync(join(root, "a.txt"), "one\ntwo\nthree\n"); // +2 lines unstaged
  writeFileSync(join(root, "new.txt"), "n1\nn2\n");
  sh("git", ["add", "new.txt"], { cwd: root }); // staged +2
  const s = await gitStatus(root);
  const mod = s.files?.find((f) => f.path === "a.txt");
  assert.equal(mod?.a, 2, `a.txt additions: ${JSON.stringify(mod)}`);
  const staged = s.files?.find((f) => f.path === "new.txt");
  assert.equal(staged?.a, 2, `new.txt staged additions: ${JSON.stringify(staged)}`);
  rmSync(root, { recursive: true, force: true });
});

test("gitStatus: identity + merge/conflict state (banner + abort)", async () => {
  const root = repo();
  const s = await gitStatus(root);
  assert.equal(s.identity?.name, "t");
  assert.equal(s.identity?.email, "t@t");
  assert.equal(s.merge, false);
  // manufacture a conflict: divergent branches then merge
  sh("git", ["checkout", "-b", "side"], { cwd: root });
  writeFileSync(join(root, "a.txt"), "side\n");
  sh("git", ["commit", "-am", "side change"], { cwd: root });
  sh("git", ["checkout", "main"], { cwd: root });
  writeFileSync(join(root, "a.txt"), "main\n");
  sh("git", ["commit", "-am", "main change"], { cwd: root });
  let conflicted = false;
  try {
    sh("git", ["merge", "side"], { cwd: root });
  } catch {
    conflicted = true;
  }
  assert.ok(conflicted, "merge must conflict for this test");
  clearGitStatusCache();
  const mid = await gitStatus(root);
  assert.equal(mid.merge, true);
  assert.ok((mid.conflicts ?? 0) >= 1, `conflicts: ${mid.conflicts}`);
  const abort = await gitOp(root, "merge-abort");
  clearGitStatusCache();
  assert.match(abort.text, /abort/i);
  const after = await gitStatus(root);
  assert.equal(after.merge, false);
  rmSync(root, { recursive: true, force: true });
});

test("gitOp: unstage returns files to the worktree untouched", async () => {
  const root = repo();
  writeFileSync(join(root, "c.txt"), "cc\n");
  sh("git", ["add", "c.txt"], { cwd: root });
  clearGitStatusCache();
  let s = await gitStatus(root);
  assert.ok(s.files?.some((f) => f.path === "c.txt" && f.x === "A"));
  const r = await gitOp(root, "unstage", { files: ["c.txt"] });
  assert.match(r.text, /unstaged/i);
  clearGitStatusCache();
  s = await gitStatus(root);
  assert.ok(s.files?.some((f) => f.path === "c.txt" && f.x === "?" ), `c.txt should be untracked again: ${JSON.stringify(s.files)}`);
  rmSync(root, { recursive: true, force: true });
});

test("gitOp: compare = ahead/behind vs ANY ref, not just upstream", async () => {
  const root = repo();
  sh("git", ["branch", "base"], { cwd: root });
  writeFileSync(join(root, "x.txt"), "x\n");
  sh("git", ["add", "."], { cwd: root });
  sh("git", ["commit", "-m", "ahead one"], { cwd: root });
  const r = await gitOp(root, "compare", { ref: "base" });
  assert.equal(r.ahead, 1);
  assert.equal(r.behind, 0);
  await assert.rejects(() => gitOp(root, "compare", { ref: "main; rm -rf /" }), /needs a branch name/);
  rmSync(root, { recursive: true, force: true });
});

test("gitOp: show-files lists one commit's changed files (log row expander)", async () => {
  const root = repo();
  writeFileSync(join(root, "y.txt"), "y\n");
  sh("git", ["add", "."], { cwd: root });
  sh("git", ["commit", "-m", "add y"], { cwd: root });
  const hash = sh("git", ["rev-parse", "--short", "HEAD"], { cwd: root }).trim();
  const r = await gitOp(root, "show-files", { target: hash });
  assert.ok(r.changed?.some((c) => c.path === "y.txt" && c.status === "A"), JSON.stringify(r.changed));
  await assert.rejects(() => gitOp(root, "show-files", { target: "HEAD; rm -rf /" }), /commit hash/);
  rmSync(root, { recursive: true, force: true });
});

test("gitOp: log-list carries parents (swimlane graph input)", async () => {
  const root = repo();
  sh("git", ["commit", "--allow-empty", "-m", "second"], { cwd: root });
  const r = await gitOp(root, "log-list");
  const first = r.commits?.[0];
  assert.ok(first?.parents?.length === 1, `parents: ${JSON.stringify(first)}`);
  rmSync(root, { recursive: true, force: true });
});

test("gitOp: ignore appends to the repo's .gitignore and nothing else", async () => {
  const root = repo();
  const r = await gitOp(root, "ignore", { lines: ["*.log", "build/"] });
  assert.match(r.text, /\.gitignore/);
  const gi = (await import("node:fs")).readFileSync(join(root, ".gitignore"), "utf8");
  assert.match(gi, /\*\.log/);
  assert.match(gi, /build\//);
  writeFileSync(join(root, "x.log"), "noise");
  const s = await gitStatus(root);
  assert.ok(!s.files?.some((f) => f.path === "x.log"), "ignored file still listed");
  await assert.rejects(() => gitOp(root, "ignore", { lines: ["a\nb"] }), /bad ignore pattern/);
  rmSync(root, { recursive: true, force: true });
});

test("gitOp: checkpoint → checkpoints → rewind round trip (refs only, then hard reset)", async () => {
  const root = repo();
  const saved = await gitOp(root, "checkpoint", { name: "before-mess" });
  assert.match(saved.text, /before-mess/);
  writeFileSync(join(root, "a.txt"), "wrecked\n");
  sh("git", ["commit", "-am", "wreck it"], { cwd: root });
  const list = await gitOp(root, "checkpoints");
  assert.ok(list.checkpoints?.some((c) => c.name === "before-mess"), JSON.stringify(list.checkpoints));
  const rewound = await gitOp(root, "rewind", { name: "before-mess" });
  assert.match(rewound.text, /main|HEAD/i);
  clearGitStatusCache();
  const s = await gitStatus(root);
  assert.match(s.subject ?? "", /first/);
  await assert.rejects(() => gitOp(root, "rewind", { name: "../../evil" }), /checkpoint name/);
  rmSync(root, { recursive: true, force: true });
});

test("gitOp: push -u opt-in passes the branch; pull --rebase is an explicit flag", async () => {
  // no remote: both must fail with git's own error, not ours — argv shape check via error text
  const root = repo();
  await assert.rejects(() => gitOp(root, "push", { setUpstream: true, ref: "main" }), /origin|remote/i);
  await assert.rejects(() => gitOp(root, "pull", { rebase: true }), /origin|remote|upstream|reference/i);
  rmSync(root, { recursive: true, force: true });
});

test("gitOp: PR ops validate before any gh call", async () => {
  const root = repo();
  await assert.rejects(() => gitOp(root, "pr-create", {}), /needs a title/);
  await assert.rejects(() => gitOp(root, "pr-merge", { n: 1.5 }), /PR number/);
  await assert.rejects(() => gitOp(root, "pr-comment", { n: 3 }), /needs a body/);
  await assert.rejects(() => gitOp(root, "pr-checks", {}), /PR number/);
  rmSync(root, { recursive: true, force: true });
});
