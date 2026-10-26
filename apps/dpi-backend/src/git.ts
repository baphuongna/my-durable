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
import { appendFile } from "node:fs/promises";
import { watch, type FSWatcher } from "node:fs";
import { dirname, isAbsolute, join } from "node:path";

const GIT_TIMEOUT = 15_000;
/** `git status` on a big Windows checkout (AV scanning, node_modules) can
 *  honestly take 20s+ — measured live on the operator's repo. */
const GIT_SLOW_TIMEOUT = 45_000;
/** Same-path status within this window returns the cached answer — the UIs
 *  poll, and a 20s status must not restart on every poll tick. */
const STATUS_TTL = 5_000;
/** A FAILED status is cached too, but briefly: without this, a repo git cannot
 *  reach re-spawned git on every UI poll tick (935 failures in one user log).
 *  Short enough that a fixed path (git installed, drive mounted) recovers on
 *  its own; long enough that a poll storm costs one spawn. */
const STATUS_FAIL_TTL = 15_000;
const statusCache = new Map<string, { at: number; s: GitStatus }>();
const statusFailCache = new Map<string, { at: number; msg: string }>();
/** One in-flight status per path: N UI clients polling the same repos through
 *  /git/status-batch must share ONE git spawn, not N. */
const statusInFlight = new Map<string, Promise<GitStatus>>();

/** Paths as git ARGV: Git-for-Windows' msys layer mangles backslashes inside
 *  argv (`D:\source\x` arrives as `D:source?x` → "cannot change to"), while
 *  the very same path with forward slashes works. Pure — no fs, no resolution. */
export function gitPathFor(p: string, platform: NodeJS.Platform): string {
  return platform === "win32" ? p.replace(/\\/g, "/") : p;
}

/** `gitPathFor` against THIS platform — the form every argv path must take. */
export const gitPath = (p: string): string => gitPathFor(p, process.platform);

/**
 * Cache-map key for a repo path: ONE entry per repo, not per spelling. Like
 * `gitPathFor` it forward-slashes on win32, plus trailing-slash strip and case
 * fold — `D:\\x`, `d:/x/` and `D:/x` are the same repo, and the status caches,
 * the single-flight map and markDirty only dedupe if every spelling lands on
 * the same key. NOT for argv (case must survive there) — cache maps only.
 */
export function cacheKey(p: string, platform: NodeJS.Platform = process.platform): string {
  const slashed = platform === "win32" ? p.replace(/\\/g, "/") : p;
  const trimmed = slashed.length > 1 ? slashed.replace(/\/+$/, "") : slashed;
  return platform === "win32" ? trimmed.toLowerCase() : trimmed;
}

/** Same, for the `-- <paths...>` lists (stage/discard/commit/unstage/resolve). */
const gitPaths = (paths: string[]): string[] => paths.map(gitPath);

/** Child-process options, exported so a test can assert the Windows console
 *  window stays hidden: a daemon that polls git must never flash a terminal. */
export const GIT_EXEC_OPTS = (timeout: number) => ({ timeout, maxBuffer: 8 * 1024 * 1024, windowsHide: true });
export const GH_EXEC_OPTS = (cwd: string, timeout: number) => ({ cwd, timeout, maxBuffer: 4 * 1024 * 1024, windowsHide: true });

/** Test seam for counting/driving spawns: `node:child_process`'s ESM namespace
 *  is not redefinable, so `mock.method` cannot reach `execFile`. Pass nothing
 *  to restore the real one. */
let execFileImpl: typeof execFile = execFile;
export function setGitExecForTests(fn?: typeof execFile) {
  execFileImpl = fn ?? execFile;
}

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
    // `-C` is ARGV, so the path goes out forward-slashed (see gitPath).
    execFileImpl("git", ["-C", gitPath(cwd), ...args], GIT_EXEC_OPTS(timeout), (error, stdout, stderr) => {
      if (error) fail(Error(String(stderr || stdout || error.message).trim().slice(0, 400)));
      // git chats on stderr for worktree add/switch/fetch — keep both.
      else ok(`${String(stdout)}${String(stdout) && String(stderr) ? "\n" : ""}${String(stderr)}`);
    });
  });
}

/** One GitHub CLI call — PRs, checks and comments are forge territory and gh
 *  is the least-token-ceremony way to reach them from a device. Same no-shell
 *  rule: argv only, plain text back. */
export function gh(cwd: string, args: string[], timeout = GIT_TIMEOUT): Promise<string> {
  return new Promise((ok, fail) => {
    // gh resolves the repo from cwd (a --repo flag wants a slug, not a path).
    // cwd is a Node spawn option, not argv — Node handles Windows paths here.
    execFileImpl("gh", args, GH_EXEC_OPTS(cwd, timeout), (error, stdout, stderr) => {
      if (error) fail(Error(String(stderr || stdout || error.message).trim().slice(0, 400)));
      else ok(String(stdout));
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
   *  dialog checks exactly these. ±n line counts come from numstat (-1 = binary). */
  files?: { path: string; x: string; y: string; a?: number; d?: number }[];
  /** A merge (with conflicts) is in progress — the banner + abort action. */
  merge?: boolean;
  /** Unmerged paths (UU/AA/DD/AU/UA/DU/UD). */
  conflicts?: number;
  /** Commit identity from config — warn before committing without one. */
  identity?: { name?: string; email?: string };
  /** `origin` URL, parsed by the UI into an open-in-remote link. */
  remoteUrl?: string;
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

// ------------------------------------------------------------ fs watcher
// The checklist's fs-auto-refresh, device side: watch the repos the UIs
// actually look at, drop their cached status the moment files change, and
// record a dirty mark the tree carries to every connected client.
const dirty: { root: string; at: number }[] = [];
const watchers = new Map<string, { w: FSWatcher; timer: NodeJS.Timeout | null; used: number }>();
const MAX_WATCHERS = 16;
let dirtyListener: (() => void) | undefined;

/** Who to poke when a watched repo changes (the store re-announces its tree). */
export function onGitDirty(cb: () => void) {
  dirtyListener = cb;
}

/** Recent dirty marks for DeviceTree — pruned to the last 10 minutes. */
export function gitDirtyMarks(): { root: string; at: number }[] {
  const cutoff = Date.now() - 10 * 60_000;
  while (dirty.length && dirty[0]!.at < cutoff) dirty.shift();
  return dirty.slice(-10);
}

/**
 * Drop every cached status at or under this repo root (the fs watcher's dirty
 * mark; exported as a test seam like clearGitStatusCache). The comparisons run
 * on canonical `cacheKey`s, so a root git printed as `D:\repo` invalidates an
 * entry cached as `d:/repo` — and `d:/repo-other` survives untouched.
 */
export function markDirty(root: string) {
  const now = Date.now();
  const key = cacheKey(root);
  for (const [p] of statusCache) if (p === key || p.startsWith(key + "/")) statusCache.delete(p);
  // A repo whose files change must get a fresh ATTEMPT, failures included.
  for (const [p] of statusFailCache) if (p === key || p.startsWith(key + "/")) statusFailCache.delete(p);
  dirty.push({ root, at: now });
  dirtyListener?.();
}

/** Watch one repo root (LRU, capped) — recursive where the platform allows. */
function ensureWatcher(root: string) {
  const hit = watchers.get(root);
  if (hit) {
    hit.used = Date.now();
    return;
  }
  if (watchers.size >= MAX_WATCHERS) {
    let oldest = "";
    let oldestAt = Infinity;
    for (const [p, w] of watchers) if (w.used < oldestAt) ((oldest = p), (oldestAt = w.used));
    if (oldest) {
      watchers.get(oldest)?.w.close();
      watchers.delete(oldest);
    }
  }
  let w: FSWatcher;
  try {
    w = watch(root, { recursive: true }, () => {});
  } catch {
    try {
      w = watch(root, () => {});
    } catch {
      return; // unwatchable (network fs, perms): the UIs keep explicit refresh
    }
  }
  const entry = { w, timer: null as NodeJS.Timeout | null, used: Date.now() };
  entry.w.on("change", () => {
    if (entry.timer) clearTimeout(entry.timer);
    entry.timer = setTimeout(() => {
      entry.timer = null;
      markDirty(root);
    }, 1200);
  });
  entry.w.on("error", () => {
    watchers.delete(root);
    try {
      w.close();
    } catch {}
  });
  watchers.set(root, entry);
}

/** Test hook: the TTL cache would serve a pre-mutation answer. */
export function clearGitStatusCache() {
  statusCache.clear();
  statusFailCache.clear();
}

/** Structured status for a folder: everything the UIs show, one call.
 *  `now` is injectable so a test can age the caches without sleeping. */
export async function gitStatus(path: string, now = Date.now()): Promise<GitStatus> {
  // One key per repo, not per spelling: `D:\\x`, `d:/x/` and `D:/x` land on
  // the SAME entry (cacheKey), so single-flight dedupes every spelling.
  const key = cacheKey(path);
  const cached = statusCache.get(key);
  if (cached && now - cached.at < STATUS_TTL) return cached.s;
  const failed = statusFailCache.get(key);
  // Same error text as the original failure — the UI still shows WHY.
  if (failed && now - failed.at < STATUS_FAIL_TTL) throw new Error(failed.msg);
  const running = statusInFlight.get(key);
  if (running) return running;
  const p = statusOnce(path, key).finally(() => {
    if (statusInFlight.get(key) === p) statusInFlight.delete(key);
  });
  statusInFlight.set(key, p);
  return p;
}

async function statusOnce(path: string, key: string): Promise<GitStatus> {
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
    const [branchP, headP, statusP, gitDirP, wlP, branchesP, numWorkP, numIdxP, mergeP, nameP, emailP, remoteP] = await Promise.allSettled([
      git(path, ["branch", "--show-current"]),
      git(path, ["log", "-1", "--pretty=%h%x09%s"]),
      git(path, ["--no-optional-locks", "status", "--porcelain=v1", "-b"], GIT_SLOW_TIMEOUT),
      git(path, ["rev-parse", "--git-dir"]),
      git(path, ["worktree", "list", "--porcelain"], GIT_SLOW_TIMEOUT),
      git(path, ["for-each-ref", "refs/heads", "--format=%(refname:short)%09%(upstream:short)%09%(if)%(HEAD)%(then)1%(else)0%(end)"]),
      git(path, ["--no-optional-locks", "diff", "--numstat", "--no-renames"], GIT_SLOW_TIMEOUT),
      git(path, ["--no-optional-locks", "diff", "--numstat", "--cached", "--no-renames"]),
      // MERGE_HEAD exists ⇔ a merge is waiting to be resolved.
      git(path, ["rev-parse", "-q", "--verify", "MERGE_HEAD"]),
      git(path, ["config", "user.name"]),
      git(path, ["config", "user.email"]),
      git(path, ["remote", "get-url", "origin"]),
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
    out.merge = mergeP.status === "fulfilled";
    out.conflicts = count(body.join("\n"), /^(UU|AA|DD|AU|UA|DU|UD)/gm);
    out.identity = {
      name: nameP.status === "fulfilled" ? nameP.value.trim() || undefined : undefined,
      email: emailP.status === "fulfilled" ? emailP.value.trim() || undefined : undefined,
    };
    if (remoteP.status === "fulfilled") out.remoteUrl = remoteP.value.trim() || undefined;
    // ±n per file: worktree-vs-index numstat for unstaged paths, cached for staged.
    const numstat = (raw: string) => {
      const m = new Map<string, { a: number; d: number }>();
      for (const l of raw.split("\n")) {
        const mt = l.match(/^(\d+|-)\t(\d+|-)\t(.+)$/);
        if (!mt) continue;
        m.set(mt[3]!, { a: mt[1] === "-" ? -1 : Number(mt[1]), d: mt[2] === "-" ? -1 : Number(mt[2]) });
      }
      return m;
    };
    const workNum = numstat(numWorkP.status === "fulfilled" ? numWorkP.value : "");
    const idxNum = numstat(numIdxP.status === "fulfilled" ? numIdxP.value : "");
    out.files = body.slice(0, 500).map((l) => {
      const p = l.slice(3).replace(/^"|"$/g, "");
      const staged = l[0] !== " " && l[0] !== "?";
      const n = staged ? idxNum.get(p) : workNum.get(p);
      return { path: p, x: l[0] ?? " ", y: l[1] ?? " ", ...(n ? { a: n.a, d: n.d } : {}) };
    });
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
    // The UI looked at this repo: keep an eye on it so status never goes stale
    // silently (checklist fs-auto-refresh, device side).
    ensureWatcher(root);
    const wl = wlP.value;
    statusCache.set(key, { at: Date.now(), s: out });
    statusFailCache.delete(key);
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
    if (!isNotARepoError(e)) {
      const msg = `git failed on the device: ${(e as Error).message.slice(0, 160)}`;
      // Cache the FAILURE (briefly): the UIs poll, and a path git cannot reach
      // must cost one spawn per TTL, not one per tick.
      const at = Date.now();
      for (const [k, v] of statusFailCache) if (at - v.at >= STATUS_FAIL_TTL) statusFailCache.delete(k);
      statusFailCache.set(key, { at, msg });
      throw new Error(msg);
    }
    // "Not a repository" is an ANSWER, not a failure: cache it exactly like a
    // success (STATUS_TTL). Without this, every UI poll tick re-spawned git for
    // a plain folder — and on Windows each spawn flashes a console window, the
    // "spam terminal" symptom. Sessions routinely live in non-git folders, so
    // this is the common path. Deliberately NOT in statusFailCache: nothing
    // throws here, so the 15s fail TTL must not apply.
    //
    // Recovery when the folder BECOMES a repo: a plain dir has no fs watcher
    // (ensureWatcher runs on the success path only), so markDirty is
    // unreachable for it — the 5s TTL IS the recovery path: `git init` shows
    // up within STATUS_TTL. Do not add a watcher for it.
    // Keyed by the normalized gitPath key, so markDirty/clearGitStatusCache
    // (which clear statusCache by that key) invalidate it too.
    statusCache.set(key, { at: Date.now(), s: out });
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
  | "stash-pop"
  | "unstage"
  | "compare"
  | "merge-abort"
  | "show-files"
  | "ignore"
  | "checkpoint"
  | "checkpoints"
  | "rewind"
  | "resolve"
  | "submodule-update"
  | "pr-create"
  | "pr-list"
  | "pr-merge"
  | "pr-checks"
  | "pr-comment";

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
    /** pull: opt in to --rebase when --ff-only would fail. */
    rebase?: boolean;
    /** push: set upstream (-u origin <ref>). */
    setUpstream?: boolean;
    /** checkpoint name. */
    name?: string;
    /** ignore: pattern lines to append to .gitignore. */
    lines?: string[];
    /** resolve: which side of a conflict wins, per file. */
    side?: "ours" | "theirs";
    /** pr: merge method + comment body + PR number. */
    method?: "squash" | "merge";
    body?: string;
    n?: number;
  } = {},
): Promise<{
  text: string;
  commits?: { hash: string; refs: string; author: string; date: string; subject: string; parents: string[] }[];
  ahead?: number;
  behind?: number;
  changed?: { status: string; path: string }[];
  checkpoints?: { name: string; hash: string; date: string; subject: string }[];
  prs?: { n: number; title: string; state: string; draft: boolean; branch: string; url: string }[];
}> {
  const { ref, message, target, branch, files, create, staged, rebase, setUpstream, name, lines, method, body, n, side } = opts;
  switch (op) {
    case "diff":
      return { text: await git(path, ["--no-pager", "diff", ...(ref && safeRef(ref) ? [ref] : [])]) };
    case "log":
      return { text: (await git(path, ["--no-pager", "log", "--oneline", "-n", "30", ...(ref && safeRef(ref) ? [ref] : [])])).trimEnd() };
    case "log-list": {
      // IntelliJ's log window: hash, refs, author, date, subject — structured.
      // %p = parents — the swimlane graph is computed from these on the UI.
      const raw = await git(
        path,
        ["--no-pager", "log", "-n", "50", "--date=short", "--pretty=format:%h%x1f%D%x1f%an%x1f%ad%x1f%s%x1f%p"],
      );
      return {
        text: "",
        commits: raw
          .split("\n")
          .filter(Boolean)
          .map((l) => {
            const [hash, refs, author, date, subject, parents] = l.split("\x1f");
            return {
              hash: hash ?? "",
              refs: refs ?? "",
              author: author ?? "",
              date: date ?? "",
              subject: subject ?? "",
              parents: (parents ?? "").split(" ").filter(Boolean),
            };
          }),
      };
    }
    case "fetch":
      return { text: (await git(path, ["fetch", "--all", "--prune"])).trim() || "fetched" };
    case "pull":
      // --ff-only stays the default; --rebase is an explicit opt-in the UI
      // offers only after a ff-only failure.
      return { text: (await git(path, ["pull", ...(rebase ? ["--rebase"] : ["--ff-only"])])).trim() || "up to date" };
    case "branch":
      return { text: (await git(path, ["--no-pager", "branch", "-vv"])).trimEnd() };
    case "switch": {
      if (!ref || !safeRef(ref)) throw Error("switch needs a branch name (letters, digits, ./-_)");
      // create:true = git switch -c — IntelliJ's "new branch" action.
      return { text: (await git(path, ["switch", ...(create ? ["-c"] : []), ref])).trim() };
    }
    case "push": {
      if (setUpstream) {
        if (!ref || !safeRef(ref)) throw Error("push -u needs a branch name");
        return { text: (await git(path, ["push", "-u", "origin", ref], GIT_SLOW_TIMEOUT)).trim() || `pushed, upstream set to origin/${ref}` };
      }
      return { text: (await git(path, ["push"], GIT_SLOW_TIMEOUT)).trim() || "pushed (or nothing to push)" };
    }
    case "stage": {
      if (!files?.length) throw Error("stage needs files");
      return { text: (await git(path, ["add", "--", ...gitPaths(files)])).trim() || `staged ${files.length} file(s)` };
    }
    case "discard": {
      // IntelliJ's Rollback: index AND worktree back to HEAD for these paths.
      if (!files?.length) throw Error("discard needs files");
      return { text: (await git(path, ["checkout", "HEAD", "--", ...gitPaths(files)])).trim() || `discarded ${files.length} file(s)` };
    }
    case "diff-file": {
      if (!target) throw Error("diff-file needs a file path");
      return { text: (await git(path, ["--no-pager", "diff", ...(staged ? ["--cached"] : []), "HEAD", "--", gitPath(target)])).trim() || "no diff" };
    }
    case "stash-push":
      return { text: (await git(path, ["stash", "push", ...(message ? ["-m", message] : [])])).trim() || "stashed" };
    case "stash-pop":
      return { text: (await git(path, ["stash", "pop"])).trim() || "stash popped" };
    case "unstage": {
      // IntelliJ's Unstage: index only, worktree keeps its changes.
      if (!files?.length) throw Error("unstage needs files");
      try {
        return { text: (await git(path, ["reset", "-q", "HEAD", "--", ...gitPaths(files)])).trim() || `unstaged ${files.length} file(s)` };
      } catch {
        // unborn branch: HEAD does not resolve yet — reset against the empty tree.
        return { text: (await git(path, ["reset", "-q", "--", ...gitPaths(files)])).trim() || `unstaged ${files.length} file(s)` };
      }
    }
    case "compare": {
      // ahead/behind vs ANY ref, not just the upstream (orca git-bridge).
      if (!ref || !safeRef(ref)) throw Error("compare needs a branch name");
      const raw = await git(path, ["rev-list", "--left-right", "--count", `${ref}...HEAD`]);
      const [behind = "0", ahead = "0"] = raw.trim().split(/\s+/);
      return { text: `${Number(ahead)} ahead, ${Number(behind)} behind of ${ref}`, ahead: Number(ahead), behind: Number(behind) };
    }
    case "merge-abort":
      try {
        return { text: (await git(path, ["merge", "--abort"])).trim() || "merge aborted" };
      } catch {
        return { text: (await git(path, ["rebase", "--abort"])).trim() || "rebase aborted" };
      }
    case "show-files": {
      // What one commit touched — the log row expander.
      if (!target || !/^[0-9a-f]{4,40}$/.test(target)) throw Error("show-files needs a commit hash");
      const raw = await git(path, ["--no-pager", "show", "--name-status", "--pretty=format:", "--no-renames", "-m", "--first-parent", target]);
      return {
        text: "",
        changed: raw
          .split("\n")
          .map((l) => l.trim())
          .filter(Boolean)
          .slice(0, 200)
          .map((l) => {
            const [status, p] = l.split(/\t/);
            return { status: status ?? "", path: p ?? l };
          }),
      };
    }
    case "ignore": {
      // Appends to the repo's OWN .gitignore — root comes from git, not the caller.
      if (!lines?.length) throw Error("ignore needs pattern lines");
      if (lines.length > 50) throw Error("ignore takes at most 50 lines");
      for (const l of lines) if (!l.trim() || l.length > 200 || /[\n\r\0]/.test(l)) throw Error("bad ignore pattern");
      const root = (await git(path, ["rev-parse", "--show-toplevel"])).trim();
      await appendFile(join(root, ".gitignore"), `\n${lines.join("\n")}\n`, "utf8");
      return { text: `added to .gitignore: ${lines.join(", ")}` };
    }
    case "checkpoint": {
      // A named ref of HEAD — the rewind target. Never touches the worktree.
      if (!name || !/^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/.test(name)) throw Error("checkpoint needs a name (letters, digits, ._-)");
      const refname = `refs/dpi/checkpoints/${name}`;
      await git(path, ["update-ref", refname, "HEAD"]);
      return { text: `checkpoint ${name} saved` };
    }
    case "checkpoints": {
      const raw = await git(path, [
        "--no-pager", "for-each-ref", "refs/dpi/checkpoints",
        "--format=%(refname:strip=3)%09%(objectname:short)%09%(committerdate:short)%09%(contents:subject)",
      ]);
      return {
        text: "",
        checkpoints: raw
          .split("\n")
          .filter(Boolean)
          .slice(0, 50)
          .map((l) => {
            const [full, hash, date, subject] = l.split("\t");
            return { name: full ?? "", hash: hash ?? "", date: date ?? "", subject: (subject ?? "").slice(0, 80) };
          }),
      };
    }
    case "rewind": {
      // reset --hard to one of OUR checkpoint refs only — never an arbitrary ref.
      if (!name || !/^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/.test(name)) throw Error("rewind needs a checkpoint name");
      const refname = `refs/dpi/checkpoints/${name}`;
      const sha = (await git(path, ["rev-parse", "--verify", refname])).trim();
      return { text: (await git(path, ["reset", "--hard", sha])).trim().split("\n")[0] ?? `rewound to ${name}` };
    }
    case "resolve": {
      // orca's conflicts section, one click: pick a side, stage the result.
      if (side !== "ours" && side !== "theirs") throw Error("resolve needs side=ours|theirs");
      if (!files?.length) throw Error("resolve needs files");
      await git(path, ["checkout", `--${side}`, "--", ...gitPaths(files)]);
      return { text: (await git(path, ["add", "--", ...gitPaths(files)])).trim() || `resolved ${files.length} file(s) with --${side}` };
    }
    case "submodule-update":
      return { text: (await git(path, ["submodule", "update", "--init", "--recursive"], GIT_SLOW_TIMEOUT)).trim() || "submodules up to date" };
    case "pr-create": {
      // gh pr create — title from message, head = current branch. gh owns auth.
      const title = (message ?? "").trim();
      if (!title) throw Error("pr-create needs a title (message)");
      const args = ["pr", "create", "--title", title.slice(0, 200), "--body", (body ?? title).slice(0, 4000)];
      if (ref && safeRef(ref)) args.push("--base", ref);
      return { text: (await gh(path, args, GIT_SLOW_TIMEOUT)).trim() };
    }
    case "pr-list": {
      const raw = await gh(path, ["pr", "list", "--limit", "20", "--json", "number,title,state,isDraft,headRefName,url"]);
      const list = JSON.parse(raw || "[]") as { number: number; title: string; state: string; isDraft: boolean; headRefName: string; url: string }[];
      return {
        text: "",
        prs: list.map((r) => ({ n: r.number, title: r.title, state: r.state, draft: r.isDraft, branch: r.headRefName, url: r.url })),
      };
    }
    case "pr-merge": {
      if (!n || !Number.isInteger(n)) throw Error("pr-merge needs a PR number");
      return { text: (await gh(path, ["pr", "merge", String(n), method === "merge" ? "--merge" : "--squash"], GIT_SLOW_TIMEOUT)).trim() || `PR #${n} merged` };
    }
    case "pr-checks": {
      if (!n || !Number.isInteger(n)) throw Error("pr-checks needs a PR number");
      return { text: (await gh(path, ["pr", "checks", String(n)], GIT_SLOW_TIMEOUT)).trim() || "no checks reported" };
    }
    case "pr-comment": {
      if (!n || !Number.isInteger(n)) throw Error("pr-comment needs a PR number");
      const text = (body ?? "").trim();
      if (!text) throw Error("pr-comment needs a body");
      return { text: (await gh(path, ["pr", "comment", String(n), "--body", text.slice(0, 4000)])).trim() };
    }
    case "commit": {
      const msg = (message ?? "").trim();
      if (!msg) throw Error("commit needs a message");
      // IntelliJ-style: chosen files only, when the caller picked some.
      if (files?.length) {
        for (const f of files) if (f.includes("\0") || f === "") throw Error("bad file path");
        return { text: (await git(path, ["commit", "-m", msg, "--", ...gitPaths(files)])).split("\n")[0]?.trim() ?? "committed" };
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
        return { text: (await git(path, ["worktree", "add", "-b", branch, gitPath(target)])).trim() };
      }
      if (!ref || !safeRef(ref)) throw Error("worktree-add needs a branch (new) or ref (existing)");
      return { text: (await git(path, ["worktree", "add", gitPath(target), ref])).trim() };
    }
    case "worktree-remove": {
      if (!target || !isAbsolute(target)) throw Error("worktree-remove needs an absolute path");
      return { text: (await git(path, ["worktree", "remove", gitPath(target)])).trim() || `removed ${target}` };
    }
  }
}
