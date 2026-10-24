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
/** `git status` on a big Windows checkout (AV scanning, node_modules) can
 *  honestly take 20s+ — measured live on the operator's repo. */
const GIT_SLOW_TIMEOUT = 45_000;
/** Same-path status within this window returns the cached answer — the UIs
 *  poll, and a 20s status must not restart on every poll tick. */
const STATUS_TTL = 5_000;
const statusCache = new Map<string, { at: number; s: GitStatus }>();

/** The ONE stderr that legitimately means "no repo here" — anything else
 *  (git missing, permission, timeout) is a failure we must not flatten into
 *  repo:false. Reported live: a Windows daemon without git on PATH showed
 *  "Not a git repository" under a real repo. */
export function isNotARepoError(e: unknown): boolean {
  const msg = String((e as Error)?.message ?? e);
  return /not a git repository/i.test(msg) || /does not have any commits yet/i.test(msg);
}

/** One git call; rejects on non-zero exit with stderr in the message. */
export function git(cwd: string, args: string[], timeout = GIT_TIMEOUT): Promise<string> {
  return new Promise((ok, fail) => {
    execFile("git", ["-C", cwd, ...args], { timeout, maxBuffer: 8 * 1024 * 1024 }, (error, stdout, stderr) => {
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
  /** Changed files (porcelain XY + path), capped — the IntelliJ-style commit
   *  dialog checks exactly these. */
  files?: { path: string; x: string; y: string }[];
  /** Local branches for pickers — nobody should TYPE a name that exists. */
  branches?: { name: string; current?: boolean; upstream?: string }[];
}

/** One status for MANY paths — what a session list needs. The per-path cache
 *  keeps repeat polls cheap on big repos. */
export async function gitStatusBatch(paths: string[]): Promise<Record<string, GitStatus>> {
  const unique = [...new Set(paths.filter(Boolean))];
  const entries = await Promise.all(unique.map(async (p) => [p, await gitStatus(p)] as const));
  return Object.fromEntries(entries);
}

/** Structured status for a folder: everything the UIs show, one call. */
export async function gitStatus(path: string): Promise<GitStatus> {
  const cached = statusCache.get(path);
  if (cached && Date.now() - cached.at < STATUS_TTL) return cached.s;
  const out: GitStatus = { repo: false };
  try {
    // Reach git at all before trusting any "empty" answer: git missing from
    // the daemon's PATH (seen on a Windows Startup-launched device) must NOT
    // read as "not a repository" under a real repo.
    const root = (await git(path, ["rev-parse", "--show-toplevel"])).trim();
    out.repo = true;
    out.root = root;
    // Everything after toplevel runs in PARALLEL — status is the long pole
    // (20s+ on big Windows checkouts) and must not wait for four fast calls.
    const [branchP, headP, statusP, gitDirP, wlP, branchesP] = await Promise.allSettled([
      git(path, ["branch", "--show-current"]),
      git(path, ["log", "-1", "--pretty=%h%x09%s"]),
      git(path, ["--no-optional-locks", "status", "--porcelain=v1", "-b"], GIT_SLOW_TIMEOUT),
      git(path, ["rev-parse", "--git-dir"]),
      git(path, ["worktree", "list", "--porcelain"], GIT_SLOW_TIMEOUT),
      git(path, ["for-each-ref", "refs/heads", "--format=%(refname:short)%09%(upstream:short)%09%(if)%(HEAD)%(then)1%(else)0%(end)"]),
    ]);
    const branch = branchP.status === "fulfilled" ? branchP.value : "";
    out.branch = branch.trim() || undefined;
    out.detached = !out.branch;
    const headLine = headP.status === "fulfilled" ? headP.value.trim() : "";
    if (headLine) {
      const [h, ...rest] = headLine.split("\t");
      out.head = h;
      out.subject = rest.join("\t").slice(0, 120) || undefined;
    }
    if (statusP.status === "rejected") throw statusP.reason;
    const status = statusP.value;
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
    out.files = body.slice(0, 500).map((l) => ({
      path: l.slice(3).replace(/^"|"$/g, ""),
      x: l[0] ?? " ",
      y: l[1] ?? " ",
    }));
    if (branchesP.status === "fulfilled")
      out.branches = branchesP.value
        .split("\n")
        .filter(Boolean)
        .slice(0, 300)
        .map((l) => {
          const [name, upstream, head] = l.split("\t");
          return { name: name ?? "", current: head === "1", upstream: upstream || undefined };
        })
        .filter((b) => b.name);
    out.staged = count(body.join("\n"), /^[MADRC]/gm);
    out.unstaged = count(body.join("\n"), /^ [MD]/gm);
    out.untracked = count(body.join("\n"), /^\?\?/gm);
    // In a linked worktree --git-dir is "<main>/.git/worktrees/<name>";
    // the main checkout is the .git's parent.
    const gitDir = (gitDirP.status === "fulfilled" ? gitDirP.value : "").trim();
    if (gitDir.includes("/worktrees/") || gitDir.includes("\\worktrees\\"))
      out.worktreeOf = dirname(gitDir.split(/[/\\]worktrees[/\\]/)[0]!);
    if (wlP.status === "rejected") throw wlP.reason;
    const wl = wlP.value;
    statusCache.set(path, { at: Date.now(), s: out });
    out.worktrees = wl
      .split("\n\n")
      .map((b) => b.trim())
      .filter(Boolean)
      .map((b) => {
        const g = (k: string) => b.split("\n").find((l) => l.startsWith(k + " "))?.slice(k.length + 1) ?? null;
        return { path: g("worktree") ?? "", branch: g("branch")?.replace("refs/heads/", "") ?? null, head: g("HEAD")?.slice(0, 8) ?? "" };
      })
      .filter((w) => w.path);
  } catch (e) {
    // Only a GENUINE "not a git repository" is repo:false. Anything else —
    // git not found, EACCES, timeout — is a real failure the UIs must show.
    if (!isNotARepoError(e)) throw new Error(`git failed on the device: ${(e as Error).message.slice(0, 160)}`);
  }
  return out;
}

export type GitOp =
  | "diff"
  | "log"
  | "log-list"
  | "fetch"
  | "pull"
  | "switch"
  | "branch"
  | "commit"
  | "worktree-list"
  | "worktree-add"
  | "worktree-remove"
  | "push"
  | "stage"
  | "discard"
  | "diff-file"
  | "stash-push"
  | "stash-pop";

/** Plain string an arg may never contain — we build argv ourselves anyway. */
const safeRef = (s: string) => /^[\w./@+-]+$/.test(s) && !s.includes("..");

/** Run one whitelisted git operation. Every arg is ours; callers only pick names. */
export async function gitOp(
  path: string,
  op: GitOp,
  opts: {
    ref?: string;
    message?: string;
    target?: string;
    branch?: string;
    files?: string[];
    create?: boolean;
    staged?: boolean;
  } = {},
): Promise<{ text: string; commits?: { hash: string; refs: string; author: string; date: string; subject: string }[] }> {
  const { ref, message, target, branch, files, create, staged } = opts;
  switch (op) {
    case "diff":
      return { text: await git(path, ["--no-pager", "diff", ...(ref && safeRef(ref) ? [ref] : [])]) };
    case "log":
      return { text: (await git(path, ["--no-pager", "log", "--oneline", "-n", "30", ...(ref && safeRef(ref) ? [ref] : [])])).trimEnd() };
    case "log-list": {
      // IntelliJ's log window: hash, refs, author, date, subject — structured.
      const raw = await git(
        path,
        ["--no-pager", "log", "-n", "50", "--date=short", "--pretty=format:%h%x1f%D%x1f%an%x1f%ad%x1f%s"],
      );
      return {
        text: "",
        commits: raw
          .split("\n")
          .filter(Boolean)
          .map((l) => {
            const [hash, refs, author, date, subject] = l.split("\x1f");
            return { hash: hash ?? "", refs: refs ?? "", author: author ?? "", date: date ?? "", subject: subject ?? "" };
          }),
      };
    }
    case "fetch":
      return { text: (await git(path, ["fetch", "--all", "--prune"])).trim() || "fetched" };
    case "pull":
      return { text: (await git(path, ["pull", "--ff-only"])).trim() || "up to date" };
    case "branch":
      return { text: (await git(path, ["--no-pager", "branch", "-vv"])).trimEnd() };
    case "switch": {
      if (!ref || !safeRef(ref)) throw Error("switch needs a branch name (letters, digits, ./-_)");
      // create:true = git switch -c — IntelliJ's "new branch" action.
      return { text: (await git(path, ["switch", ...(create ? ["-c"] : []), ref])).trim() };
    }
    case "push":
      return { text: (await git(path, ["push"], GIT_SLOW_TIMEOUT)).trim() || "pushed (or nothing to push)" };
    case "stage": {
      if (!files?.length) throw Error("stage needs files");
      return { text: (await git(path, ["add", "--", ...files])).trim() || `staged ${files.length} file(s)` };
    }
    case "discard": {
      // IntelliJ's Rollback: index AND worktree back to HEAD for these paths.
      if (!files?.length) throw Error("discard needs files");
      return { text: (await git(path, ["checkout", "HEAD", "--", ...files])).trim() || `discarded ${files.length} file(s)` };
    }
    case "diff-file": {
      if (!target) throw Error("diff-file needs a file path");
      return { text: (await git(path, ["--no-pager", "diff", ...(staged ? ["--cached"] : []), "HEAD", "--", target])).trim() || "no diff" };
    }
    case "stash-push":
      return { text: (await git(path, ["stash", "push", ...(message ? ["-m", message] : [])])).trim() || "stashed" };
    case "stash-pop":
      return { text: (await git(path, ["stash", "pop"])).trim() || "stash popped" };
    case "commit": {
      const msg = (message ?? "").trim();
      if (!msg) throw Error("commit needs a message");
      // IntelliJ-style: chosen files only, when the caller picked some.
      if (files?.length) {
        for (const f of files) if (f.includes("\0") || f === "") throw Error("bad file path");
        return { text: (await git(path, ["commit", "-m", msg, "--", ...files])).split("\n")[0]?.trim() ?? "committed" };
      }
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
