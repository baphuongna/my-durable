import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { gitStatus, gitOp, gitStatusBatch } from "../src/git.ts";

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
