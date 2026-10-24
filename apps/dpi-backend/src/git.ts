/**
 * Device-side git, spoken with the porcelain plumbing — no shell, ever.
 * execFile("git", [...]) with whitelisted subcommands and hand-built args;
 * paths are passed as args, never interpolated into a command string.
 *
 * GET  /v1/git/status?path=<dir>  branch, ahead/behind, dirty counts, worktrees
 * POST /v1/git                    { path, op, ...op args } → text or structured
 *   ops: diff, log, fetch, pull, switch, branch, commit, worktree-list,
 *         worktree-add, worktree-remove
 */
import { execFile } from "node:child_process";
import { dirname, isAbsolute } from "node:path";

const GIT_TIMEOUT = 15_000;

/** One git call; rejects on non-zero exit with stderr in the message. */
export function git(cwd: string, args: string[]): Promise<string> {
  return new Promise((ok, fail) => {
    execFile("git", ["-C", cwd, ...args], { timeout: GIT_TIMEOUT, maxBuffer: 8 * 1024 * 1024 }, (error, stdout, stderr) => {
      if (error) fail(Error(String(stderr || stdout || error.message).trim().slice(0, 400)));
      // git chats on stderr for worktree add/switch/fetch — keep both.
      else ok(`${String(stdout)}${String(stdout) && String(stderr) ? "\n" : ""}${String(stderr)}`);
    });
  });
}

const count = (s: string, re: RegExp) => (s.match(re) ?? []).length;

export interface GitStatus {
  repo: boolean;
  root?: string;
  branch?: string;
  detached?: boolean;
  upstream?: string;
  ahead?: number;
  behind?: number;
  staged?: number;
  unstaged?: number;
  untracked?: number;
  head?: string;
  subject?: string;
  worktreeOf?: string;
  worktrees?: { path: string; branch: string | null; head: string }[];
}

/** Structured status for a folder: everything the UIs show, one call. */
export async function gitStatus(path: string): Promise<GitStatus> {
  const out: GitStatus = { repo: false };
  try {
    const root = (await git(path, ["rev-parse", "--show-toplevel"])).trim();
    out.repo = true;
    out.root = root;
    const branch = await git(path, ["branch", "--show-current"]);
    out.branch = branch.trim() || undefined;
    out.detached = !out.branch;
    const headLine = (await git(path, ["log", "-1", "--pretty=%h%x09%s"])).trim();
    if (headLine) {
      const [h, ...rest] = headLine.split("\t");
      out.head = h;
      out.subject = rest.join("\t").slice(0, 120) || undefined;
    }
    const status = await git(path, ["status", "--porcelain=v1", "-b"]);
    const lines = status.split("\n");
    const head2 = lines[0] ?? "";
    // "## main...origin/main [ahead 2, behind 1]" — split by hand: a lazy \S+?
    // ate the branch down to one letter.
    const info = head2.replace(/^## /, "");
    const [branchPart, bracket] = info.split(/\s+\[/);
    const [local, upstream] = branchPart.trim().split("...");
    if (local) out.branch = local === "HEAD" || local === "HEAD (no branch)" ? out.branch : local;
    if (upstream) {
      out.upstream = upstream;
      const ab = bracket?.replace(/\]$/, "") ?? "";
      out.ahead = Number(ab.match(/ahead (\d+)/)?.[1] ?? 0);
      out.behind = Number(ab.match(/behind (\d+)/)?.[1] ?? 0);
    }
    // Per line — a ^-anchored regex on the joined blob only ever sees line 1.
    const body = lines.slice(1).filter(Boolean);
    out.staged = count(body.join("\n"), /^[MADRC]/gm);
    out.unstaged = count(body.join("\n"), /^ [MD]/gm);
    out.untracked = count(body.join("\n"), /^\?\?/gm);
    // Is this folder itself a linked worktree (not the main checkout)?
    // In a linked worktree --git-dir is "<main>/.git/worktrees/<name>";
    // the main checkout is the .git's parent.
    const gitDir = (await git(path, ["rev-parse", "--git-dir"])).trim();
    if (gitDir.includes("/worktrees/")) out.worktreeOf = dirname(gitDir.split("/worktrees/")[0]!);
    const wl = await git(path, ["worktree", "list", "--porcelain"]);
    out.worktrees = wl
      .split("\n\n")
      .map((b) => b.trim())
      .filter(Boolean)
      .map((b) => {
        const g = (k: string) => b.split("\n").find((l) => l.startsWith(k + " "))?.slice(k.length + 1) ?? null;
        return { path: g("worktree") ?? "", branch: g("branch")?.replace("refs/heads/", "") ?? null, head: g("HEAD")?.slice(0, 8) ?? "" };
      })
      .filter((w) => w.path);
  } catch {
    /* not a repo, or git missing — the empty { repo: false } is the answer */
  }
  return out;
}

export type GitOp =
  | "diff"
  | "log"
  | "fetch"
  | "pull"
  | "switch"
  | "branch"
  | "commit"
  | "worktree-list"
  | "worktree-add"
  | "worktree-remove";

/** Plain string an arg may never contain — we build argv ourselves anyway. */
const safeRef = (s: string) => /^[\w./@+-]+$/.test(s) && !s.includes("..");

/** Run one whitelisted git operation. Every arg is ours; callers only pick names. */
export async function gitOp(
  path: string,
  op: GitOp,
  opts: { ref?: string; message?: string; target?: string; branch?: string } = {},
): Promise<{ text: string }> {
  const { ref, message, target, branch } = opts;
  switch (op) {
    case "diff":
      return { text: await git(path, ["--no-pager", "diff", ...(ref && safeRef(ref) ? [ref] : [])]) };
    case "log":
      return { text: (await git(path, ["--no-pager", "log", "--oneline", "-n", "30", ...(ref && safeRef(ref) ? [ref] : [])])).trimEnd() };
    case "fetch":
      return { text: (await git(path, ["fetch", "--all", "--prune"])).trim() || "fetched" };
    case "pull":
      return { text: (await git(path, ["pull", "--ff-only"])).trim() || "up to date" };
    case "branch":
      return { text: (await git(path, ["--no-pager", "branch", "-vv"])).trimEnd() };
    case "switch": {
      if (!ref || !safeRef(ref)) throw Error("switch needs a branch name (letters, digits, ./-_)");
      return { text: (await git(path, ["switch", ref])).trim() };
    }
    case "commit": {
      const msg = (message ?? "").trim();
      if (!msg) throw Error("commit needs a message");
      return { text: (await git(path, ["commit", "-am", msg])).split("\n")[0]?.trim() ?? "committed" };
    }
    case "worktree-list":
      return { text: (await git(path, ["--no-pager", "worktree", "list"])).trimEnd() };
    case "worktree-add": {
      // branch = create a NEW branch for the worktree; ref = check out an
      // existing one. Both validated the same strict way — never a shell.
      if (!target || !isAbsolute(target)) throw Error("worktree-add needs an absolute target path");
      if (branch) {
        if (!safeRef(branch)) throw Error("worktree-add branch name is invalid (letters, digits, ./-_)");
        return { text: (await git(path, ["worktree", "add", "-b", branch, target])).trim() };
      }
      if (!ref || !safeRef(ref)) throw Error("worktree-add needs a branch (new) or ref (existing)");
      return { text: (await git(path, ["worktree", "add", target, ref])).trim() };
    }
    case "worktree-remove": {
      if (!target || !isAbsolute(target)) throw Error("worktree-remove needs an absolute path");
      return { text: (await git(path, ["worktree", "remove", target])).trim() || `removed ${target}` };
    }
  }
}
