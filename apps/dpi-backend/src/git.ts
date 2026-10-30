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

/** Same, for the `-- <paths...>` lists (stage/discard/commit/unstage/resolve).
 *  run-8 U2: NUL/empty are refused for EVERY files-bearing op (commit-only
 *  before) — with -z parsing the returned spellings are exact bytes, so the
 *  parity check is load-bearing. */
const gitPaths = (paths: string[]): string[] =>
  paths.map((p) => {
    if (typeof p !== "string" || p.includes("\0") || p === "") throw Error("bad file path");
    return gitPath(p);
  });

/** Child-process options, exported so a test can assert the Windows console
 *  window stays hidden: a daemon that polls git must never flash a terminal. */
/**
 * R17 (run-3 h1 hardening): git/gh children run -C agent-writable repos where
 * hooks/config are plantable. The daemon's process.env carries DPI_TOKEN
 * (loadEnvFile) which shellEnv deliberately strips from agent processes —
 * mirror that allowlist here so the token (and any future backend.env secret)
 * never rides into repo-controlled hook environments.
 */
const CHILD_ENV_ALLOWLIST = ["PATH", "HOME", "USER", "SHELL", "TMPDIR", "LANG", "TERM", "GIT_SSH_COMMAND", "SSH_AUTH_SOCK"];
// execFile `env` REPLACES the whole environment, and on win32 git/gh resolve
// home (USERPROFILE chain), config (APPDATA), temp (TEMP/TMP) and TLS
// (SystemRoot) from these — without them commit identity and gh auth break.
// git-for-windows resolves a commit identity from getpwuid(), which its compat
// layer fills from USERNAME/USERDOMAIN and gethostname()→COMPUTERNAME. Leaving
// those out made every device-side git call see "Author identity unknown" while
// the same repo committed fine in a terminal (live report) — the identity was
// there, the environment was not. They are not secrets; they are the account.
const WIN32_CHILD_ENV_ALLOWLIST = [
  ...CHILD_ENV_ALLOWLIST,
  "USERNAME", "USERDOMAIN", "LOGNAME", "COMPUTERNAME", "WINDIR",
  "SYSTEMROOT", "SYSTEMDRIVE", "COMSPEC", "PATHEXT",
  "TEMP", "TMP", "USERPROFILE", "HOMEDRIVE", "HOMEPATH",
  "APPDATA", "LOCALAPPDATA", "PROGRAMFILES", "PROGRAMDATA",
];
export const childEnvKeys = (): string[] =>
  process.platform === "win32" ? WIN32_CHILD_ENV_ALLOWLIST : CHILD_ENV_ALLOWLIST;
export const childEnv = (): NodeJS.ProcessEnv => {
  const allow = process.platform === "win32" ? WIN32_CHILD_ENV_ALLOWLIST : CHILD_ENV_ALLOWLIST;
  return Object.fromEntries(allow.flatMap((k) => (process.env[k] ? [[k, process.env[k]]] : [])));
}
export interface RepoPin {
  gitDir: string;
  workTree: string;
}
/** run-7 cold-1 M3: pin the repo per request — GIT_DIR/GIT_WORK_TREE stop
 *  every spawn re-running .git discovery, so an in-sandbox racer flipping the
 *  .git file (gitdir redirect / core.worktree) between the guard's resolves
 *  and the data spawns cannot redirect the operation. */
export const GIT_EXEC_OPTS = (timeout: number, pin?: RepoPin) => ({
  timeout,
  maxBuffer: 8 * 1024 * 1024,
  windowsHide: true,
  env: { ...childEnv(), ...(pin ? { GIT_DIR: pin.gitDir, GIT_WORK_TREE: pin.workTree } : {}) } as ReturnType<typeof childEnv>,
});
export const GH_EXEC_OPTS = (cwd: string, timeout: number, pin?: RepoPin) => ({
  cwd,
  timeout,
  maxBuffer: 4 * 1024 * 1024,
  windowsHide: true,
  env: { ...childEnv(), ...(pin ? { GIT_DIR: pin.gitDir, GIT_WORK_TREE: pin.workTree } : {}) } as ReturnType<typeof childEnv>,
});

/** Test seam for counting/driving spawns: `node:child_process`'s ESM namespace
 *  is not redefinable, so `mock.method` cannot reach `execFile`. Pass nothing
 *  to restore the real one. */
let execFileImpl: typeof execFile = execFile;
export function setGitExecForTests(fn?: typeof execFile) {
  execFileImpl = fn ?? execFile;
}

/** Forges the panel can speak to. Only GitHub has a CLI we drive; the rest
 *  are link-first (the operator opens the MR/PR page), because `gh` is
 *  GitHub-only and a GitLab origin silently produced empty PR lists. */
export type Forge = "github" | "gitlab" | "bitbucket" | "other";

export interface ParsedRemote {
  host: string;
  /** Everything after the host, without a trailing .git or leading slash. */
  path: string;
  forge: Forge;
  webUrl: string;
}

/** Parse ANY git origin spelling into host + path + browser URL.
 *  Handles `git@host:ns/repo.git`, `ssh://git@host:2222/ns/repo.git`,
 *  `https://user:token@host/ns/sub/repo.git`, and path-only remotes (which
 *  have no browser). GitLab namespaces nest arbitrarily — never slice to two. */
export function parseRemote(url?: string): ParsedRemote | undefined {
  const raw = (url ?? "").trim();
  if (!raw) return undefined;
  let host = "";
  let path = "";
  const scp = raw.match(/^(?:[A-Za-z0-9._~-]+@)?([^/:]+):(?!\/\/)(.+)$/); // git@host:ns/repo
  if (scp && !/^[A-Za-z]:[\\/]/.test(raw)) {
    host = scp[1]!;
    path = scp[2]!;
  } else if (/^[A-Za-z][A-Za-z0-9+.-]*:\/\//.test(raw)) {
    try {
      const u = new URL(raw);
      host = u.hostname;
      path = u.pathname.replace(/^\/+/, "");
    } catch {
      return undefined;
    }
  } else {
    return undefined; // a filesystem remote (/srv/git/x.git, ..\repo) has no browser
  }
  path = path.replace(/\/+$/, "").replace(/\.git$/, "");
  if (!host || !path) return undefined;
  const h = host.toLowerCase();
  const forge: Forge = h === "github.com" || h.endsWith(".github.com") || /(^|\.)github\./.test(h)
    ? "github"
    : /gitlab/.test(h) || /(^|\.)gitlab\./.test(h)
      ? "gitlab"
      : /bitbucket/.test(h)
        ? "bitbucket"
        : "other";
  const scheme = /^http:\/\//.test(raw) ? "http" : "https";
  return { host, path, forge, webUrl: `${scheme}://${host}/${path}` };
}

/** The browser URL that starts a new merge/pull request for `branch` into
 *  `base` on this forge — the only cross-forge action that needs no CLI. */
export function newChangeUrl(remote: ParsedRemote | undefined, branch: string, base?: string): string | undefined {
  if (!remote || !branch) return undefined;
  const br = encodeURIComponent(branch);
  const bs = base ? encodeURIComponent(base) : undefined;
  if (remote.forge === "github") return `${remote.webUrl}/compare/${bs ?? "main"}...${br}?expand=1`;
  if (remote.forge === "gitlab")
    return `${remote.webUrl}/-/merge_requests/new?merge_request%5Bsource_branch%5D=${br}${bs ? `&merge_request%5Btarget_branch%5D=${bs}` : ""}`;
  if (remote.forge === "bitbucket") return `${remote.webUrl}/pull-requests/new?source=${br}${bs ? `&dest=${bs}` : ""}`;
  return undefined; // unknown forge: the UI offers the plain repo link instead
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
export function git(cwd: string, args: string[], timeout = GIT_TIMEOUT, pin?: RepoPin): Promise<string> {
  return new Promise((ok, fail) => {
    // `-C` is ARGV, so the path goes out forward-slashed (see gitPath).
    execFileImpl("git", ["-C", gitPath(cwd), ...args], GIT_EXEC_OPTS(timeout, pin), (error, stdout, stderr) => {
      if (error) fail(Error(String(stderr || stdout || error.message).trim().slice(0, 400)));
      // git chats on stderr for worktree add/switch/fetch — keep both.
      else ok(`${String(stdout)}${String(stdout) && String(stderr) ? "\n" : ""}${String(stderr)}`);
    });
  });
}

/** One GitHub CLI call — PRs, checks and comments are forge territory and gh
 *  is the least-token-ceremony way to reach them from a device. Same no-shell
 *  rule: argv only, plain text back. */
export function gh(cwd: string, args: string[], timeout = GIT_TIMEOUT, pin?: RepoPin): Promise<string> {
  return new Promise((ok, fail) => {
    // gh resolves the repo from cwd (a --repo flag wants a slug, not a path).
    // cwd is a Node spawn option, not argv — Node handles Windows paths here.
    execFileImpl("gh", args, GH_EXEC_OPTS(cwd, timeout, pin), (error, stdout, stderr) => {
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
  /** The identity a commit would be authored with, as GIT resolves it. */
  identity?: { name?: string; email?: string };
  /** False ⇔ git itself would refuse to commit (no identity resolvable at all). */
  identityComplete?: boolean;
  /** Which forge the origin belongs to — the UI must not assume GitHub. */
  forge?: Forge;
  /** Browser URL of the repo on that forge ("" when origin is unparseable). */
  webUrl?: string;
  /** `origin` URL, parsed by the UI into an open-in-remote link. */
  remoteUrl?: string;
  /** Local branches for pickers — nobody should TYPE a name that exists. */
  branches?: { name: string; current?: boolean; upstream?: string }[];
}

/** One status for MANY paths — what a session list needs. The per-path cache
 *  keeps repeat polls cheap on big repos. */
export async function gitStatusBatch(paths: string[]): Promise<Record<string, GitStatus | { error: string }>> {
  const unique = [...new Set(paths.filter(Boolean))];
  // R21 (index 400s): one failing path (permissions, a git binary error, a
  // timeout on a huge checkout) used to reject the WHOLE batch — every
  // project's chip died with it. Settle each path separately: failures become
  // bounded `{error}` entries the FE caches instead of retry-hammering.
  const entries = await Promise.all(
    unique.map(async (p): Promise<[string, GitStatus | { error: string }]> => {
      try {
        return [p, await gitStatus(p)];
      } catch (e) {
        return [p, { error: String((e as Error)?.message ?? e).slice(0, 120) }];
      }
    }),
  );
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

/** R23 rule: confinement scopes the DEVICE REST surface only — git
 *  discovery must not WALK UP to an enclosing repo whose toplevel sits
 *  outside the start dirs (a remote viewer would read a repo the device
 *  never served). The absolute git dir is NOT confined: redirects and linked
 *  worktrees whose gitdir lives elsewhere are operator territory and are
 *  followed via the returned pin (the agent itself is unsandboxed by design). */
export async function resolveRepoPin(path: string): Promise<RepoPin | undefined> {
  if (!repoRootAllowed) return undefined;
  const [topLevel, gitDir] = await Promise.all([
    git(path, ["rev-parse", "--show-toplevel"]),
    git(path, ["rev-parse", "--absolute-git-dir"]),
  ]);
  const pin: RepoPin = { gitDir: gitDir.trim(), workTree: topLevel.trim() };
  // R23 (operator decision): durable-pi WRAPS pi/pi-durable — the agent is
  // unsandboxed by design (full user shell/fs), so the gitdir-redirect class
  // is not an escalation for it, and refusing gitdirs outside the start dirs
  // broke legitimate linked worktrees. Confinement now scopes only the DEVICE
  // REST surface: the walk-up case (git DISCOVERY adopts a toplevel outside
  // the start dirs) — a viewer must not read a repo the device never served.
  if (!(await repoRootAllowed(pin.workTree))) throw Error("repo root lives outside the start dirs");
  return pin;
}

// R21/run-7 D1: git's repo discovery WALKS UP from the contained request path —
// a start dir that is a slice of a bigger repo (monorepo, worktree-heavy
// checkout) made git adopt an OUT-of-sandbox repo root, disclosing repo-wide
// files/branches/worktrees/remoteUrl and (op "ignore") even WRITING .gitignore
// outside the start dirs. The store installs this guard; git.ts itself never
// learns the roots.
type RepoRootGuard = (root: string) => Promise<boolean>;
let repoRootAllowed: RepoRootGuard | undefined;
export function configureGitRootGuard(fn: RepoRootGuard | undefined) {
  repoRootAllowed = fn;
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
    // The discovered root is an ATTACKER-REACHABLE fact (any contained
    // subdirectory of a repo reaches it): clamp before anything repo-wide
    // runs — a REMOTE VIEWER must not read a repo the device never served.
    // R23: toplevel-only (the gitdir condition broke linked worktrees and
    // treated the unsandboxed local agent as a racer — see resolveRepoPin).
    // The pin rides GIT_DIR/GIT_WORK_TREE into every later spawn regardless.
    let pin: RepoPin | undefined;
    try {
      pin = await resolveRepoPin(path);
    } catch (e) {
      if (!String((e as Error).message).includes("start dirs")) throw e;
      out.repo = true; // repo presence only — no root, files, branches,
      // worktrees, remoteUrl, subject, identity; no watcher on foreign ground.
      statusCache.set(key, { at: Date.now(), s: out });
      statusFailCache.delete(key);
      return out;
    }
    const g = (args: string[], t?: number) => git(path, args, t, pin);
    const root = pin?.workTree ?? (await git(path, ["rev-parse", "--show-toplevel"])).trim();
    out.repo = true;
    out.root = root;
    // Everything after toplevel runs in PARALLEL — status is the long pole
    // (20s+ on big Windows checkouts) and must not wait for four fast calls.
    const [branchP, headP, statusP, gitDirP, wlP, branchesP, numWorkP, numIdxP, mergeP, identP, remoteP] = await Promise.allSettled([
      g(["branch", "--show-current"]),
      g(["log", "-1", "--pretty=%h%x09%s"]),
      g(["--no-optional-locks", "status", "--porcelain=v1", "-z", "-b"], GIT_SLOW_TIMEOUT),
      g(["rev-parse", "--git-dir"]),
      g(["worktree", "list", "--porcelain"], GIT_SLOW_TIMEOUT),
      g(["for-each-ref", "refs/heads", "--format=%(refname:short)%09%(upstream:short)%09%(if)%(HEAD)%(then)1%(else)0%(end)"]),
      g(["--no-optional-locks", "diff", "--numstat", "-z", "--no-renames"], GIT_SLOW_TIMEOUT),
      g(["--no-optional-locks", "diff", "--numstat", "-z", "--cached", "--no-renames"]),
      // MERGE_HEAD exists ⇔ a merge is waiting to be resolved.
      g(["rev-parse", "-q", "--verify", "MERGE_HEAD"]),
      // ONE authoritative probe: `git var GIT_AUTHOR_IDENT` is git's own
      // resolution — every config level, GIT_AUTHOR_*/EMAIL env, and the
      // getpwuid()/hostname fallback a plain commit would use. The old pair of
      // `git config user.name/user.email` reads only saw config FILES, so a
      // machine whose identity git derives (Windows account) was told to "set
      // user.name" although `git commit` there works.
      g(["var", "GIT_AUTHOR_IDENT"]),
      g(["remote", "get-url", "origin"]),
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
    // run-8 U2: parse the -z stream (NUL-delimited, NEVER C-quoted). The
    // v1 line form C-quotes control/backslash/non-ASCII names; stripping
    // only the outer quotes handed the ESCAPED spelling to the FE, and its
    // verbatim round-trip into stage/discard reported success while missing
    // the real file (leader-probed: "discarded 1 file(s)" with the
    // TAB-named file still modified).
    const records = status.split("\0").filter(Boolean);
    const head2 = records[0]?.startsWith("## ") ? records[0] : "";
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
    // Per record — NUL-delimited, so an embedded newline can never forge a
    // record boundary (the old line-form regex was per-line). A rename/copy
    // record is followed by its ORIGIN path as a separate record; that record
    // is status text too, so it must be dropped ONCE here — leaving it in made
    // the counters at the bottom count an old path that starts with M/A/U.
    const raw = records.filter((r) => !r.startsWith("## "));
    const body: string[] = [];
    for (let i = 0; i < raw.length; i++) {
      const rec = raw[i]!;
      body.push(rec);
      const x = rec[0] ?? " ";
      if ((x === "R" || x === "C") && i + 1 < raw.length) i++;
    }
    out.merge = mergeP.status === "fulfilled";
    out.conflicts = body.filter((r) => /^(UU|AA|DD|AU|UA|DU|UD)/.test(r)).length;
    // "Name <email> 1730000000 +0700" — the timestamp/tz tail is not identity.
    const identLine = identP.status === "fulfilled" ? identP.value.trim() : "";
    const identMatch = identLine.match(/^(.*?)\s*<([^>]*)>/);
    out.identity = {
      name: identMatch?.[1]?.trim() || undefined,
      email: identMatch?.[2]?.trim() || undefined,
    };
    // A commit would be REFUSED (not merely unconfigured) when git cannot
    // resolve an identity at all. That is the only case worth warning about.
    out.identityComplete = Boolean(identMatch?.[1]?.trim() && identMatch?.[2]?.trim());
    if (!out.identityComplete) delete out.identity;
    if (remoteP.status === "fulfilled") out.remoteUrl = remoteP.value.trim() || undefined;
    const parsed = parseRemote(out.remoteUrl);
    if (parsed) {
      out.forge = parsed.forge;
      out.webUrl = parsed.webUrl;
    }
    // ±n per file: worktree-vs-index numstat for unstaged paths, cached for staged.
    const numstat = (raw: string) => {
      const m = new Map<string, { a: number; d: number }>();
      // run-8 U2: -z is NUL-delimited and unquoted (renames disabled, so no
      // trailing original-path record). Paths may contain any byte but NUL.
      for (const rec of raw.split("\0")) {
        const mt = rec.match(/^(\d+|-)\t(\d+|-)\t([\s\S]+)$/);
        if (!mt) continue;
        m.set(mt[3]!, { a: mt[1] === "-" ? -1 : Number(mt[1]), d: mt[2] === "-" ? -1 : Number(mt[2]) });
      }
      return m;
    };
    const workNum = numstat(numWorkP.status === "fulfilled" ? numWorkP.value : "");
    const idxNum = numstat(numIdxP.status === "fulfilled" ? numIdxP.value : "");
    out.files = [];
    for (const l of body.slice(0, 500)) {
      const x = l[0] ?? " ";
      const y = l[1] ?? " ";
      const p = l.slice(3);
      const staged = x !== " " && x !== "?";
      const n = staged ? idxNum.get(p) : workNum.get(p);
      out.files.push({ path: p, x, y, ...(n ? { a: n.a, d: n.d } : {}) });
    }
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
    // run-8 U2: count PER RECORD — with -z a filename may contain a newline,
    // so the old joined-text ^-anchored regexes could be forged by a name.
    out.staged = body.filter((r) => /^[MADRC]/.test(r)).length;
    out.unstaged = body.filter((r) => /^ [MD]/.test(r)).length;
    out.untracked = body.filter((r) => /^\?\?/.test(r)).length;
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
// R16 (run-2 h6): a leading dash would turn the ref into a git OPTION
// (`push -u origin --mirror`); refuse the whole ref instead.
const safeRef = (s: string) => /^[\w./@+-]+$/.test(s) && !s.startsWith("-") && !s.includes("..");

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
  // R23: the TOPLEVEL must sit under the start dirs (gitdir redirects are
  // operator territory — see resolveRepoPin); the resolved pin rides
  // GIT_DIR/GIT_WORK_TREE into EVERY spawn below, so per-spawn .git discovery
  // never re-runs and the check cannot be raced.
  const pin = await resolveRepoPin(path);
  const g = (args: string[], t?: number) => git(path, args, t, pin);
  const ghP = (args: string[], t?: number) => gh(path, args, t, pin);
  switch (op) {
    case "diff":
      return { text: await g(["--no-pager", "diff", ...(ref && safeRef(ref) ? [ref] : [])]) };
    case "log":
      return { text: (await g(["--no-pager", "log", "--oneline", "-n", "30", ...(ref && safeRef(ref) ? [ref] : [])])).trimEnd() };
    case "log-list": {
      // IntelliJ's log window: hash, refs, author, date, subject — structured.
      // %p = parents — the swimlane graph is computed from these on the UI.
      // run-7 cold-2 M1: pinned like every other spawn — the bare git() here
      // re-ran .git discovery, reopening the TOCTOU M3 exists to close.
      const raw = await g(
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
      return { text: (await g(["fetch", "--all", "--prune"])).trim() || "fetched" };
    case "pull":
      // --ff-only stays the default; --rebase is an explicit opt-in the UI
      // offers only after a ff-only failure.
      return { text: (await g(["pull", ...(rebase ? ["--rebase"] : ["--ff-only"])])).trim() || "up to date" };
    case "branch":
      return { text: (await g(["--no-pager", "branch", "-vv"])).trimEnd() };
    case "switch": {
      if (!ref || !safeRef(ref)) throw Error("switch needs a branch name (letters, digits, ./-_)");
      // create:true = git switch -c — IntelliJ's "new branch" action.
      return { text: (await g(["switch", ...(create ? ["-c"] : []), ref])).trim() };
    }
    case "push": {
      if (setUpstream) {
        if (!ref || !safeRef(ref)) throw Error("push -u needs a branch name");
        return { text: (await g(["push", "-u", "origin", ref], GIT_SLOW_TIMEOUT)).trim() || `pushed, upstream set to origin/${ref}` };
      }
      return { text: (await g(["push"], GIT_SLOW_TIMEOUT)).trim() || "pushed (or nothing to push)" };
    }
    case "stage": {
      if (!files?.length) throw Error("stage needs files");
      return { text: (await g(["add", "--", ...gitPaths(files)])).trim() || `staged ${files.length} file(s)` };
    }
    case "discard": {
      // IntelliJ's Rollback: index AND worktree back to HEAD for these paths.
      if (!files?.length) throw Error("discard needs files");
      return { text: (await g(["checkout", "HEAD", "--", ...gitPaths(files)])).trim() || `discarded ${files.length} file(s)` };
    }
    case "diff-file": {
      if (!target) throw Error("diff-file needs a file path");
      return { text: (await g(["--no-pager", "diff", ...(staged ? ["--cached"] : []), "HEAD", "--", gitPath(target)])).trim() || "no diff" };
    }
    case "stash-push":
      return { text: (await g(["stash", "push", ...(message ? ["-m", message] : [])])).trim() || "stashed" };
    case "stash-pop":
      return { text: (await g(["stash", "pop"])).trim() || "stash popped" };
    case "unstage": {
      // IntelliJ's Unstage: index only, worktree keeps its changes.
      if (!files?.length) throw Error("unstage needs files");
      try {
        return { text: (await g(["reset", "-q", "HEAD", "--", ...gitPaths(files)])).trim() || `unstaged ${files.length} file(s)` };
      } catch {
        // unborn branch: HEAD does not resolve yet — reset against the empty tree.
        return { text: (await g(["reset", "-q", "--", ...gitPaths(files)])).trim() || `unstaged ${files.length} file(s)` };
      }
    }
    case "compare": {
      // ahead/behind vs ANY ref, not just the upstream (orca git-bridge).
      if (!ref || !safeRef(ref)) throw Error("compare needs a branch name");
      const raw = await g(["rev-list", "--left-right", "--count", `${ref}...HEAD`]);
      const [behind = "0", ahead = "0"] = raw.trim().split(/\s+/);
      return { text: `${Number(ahead)} ahead, ${Number(behind)} behind of ${ref}`, ahead: Number(ahead), behind: Number(behind) };
    }
    case "merge-abort":
      try {
        return { text: (await g(["merge", "--abort"])).trim() || "merge aborted" };
      } catch {
        return { text: (await g(["rebase", "--abort"])).trim() || "rebase aborted" };
      }
    case "show-files": {
      // What one commit touched — the log row expander.
      if (!target || !/^[0-9a-f]{4,40}$/.test(target)) throw Error("show-files needs a commit hash");
      const raw = await g(["--no-pager", "show", "--name-status", "--pretty=format:", "--no-renames", "-m", "--first-parent", target]);
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
      const root = pin?.workTree ?? (await g(["rev-parse", "--show-toplevel"])).trim();
      await appendFile(join(root, ".gitignore"), `\n${lines.join("\n")}\n`, "utf8");
      return { text: `added to .gitignore: ${lines.join(", ")}` };
    }
    case "checkpoint": {
      // A named ref of HEAD — the rewind target. Never touches the worktree.
      if (!name || !/^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/.test(name)) throw Error("checkpoint needs a name (letters, digits, ._-)");
      const refname = `refs/dpi/checkpoints/${name}`;
      await g(["update-ref", refname, "HEAD"]);
      return { text: `checkpoint ${name} saved` };
    }
    case "checkpoints": {
      const raw = await g([
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
      const sha = (await g(["rev-parse", "--verify", refname])).trim();
      return { text: (await g(["reset", "--hard", sha])).trim().split("\n")[0] ?? `rewound to ${name}` };
    }
    case "resolve": {
      // orca's conflicts section, one click: pick a side, stage the result.
      if (side !== "ours" && side !== "theirs") throw Error("resolve needs side=ours|theirs");
      if (!files?.length) throw Error("resolve needs files");
      await g(["checkout", `--${side}`, "--", ...gitPaths(files)]);
      return { text: (await g(["add", "--", ...gitPaths(files)])).trim() || `resolved ${files.length} file(s) with --${side}` };
    }
    case "submodule-update":
      return { text: (await g(["submodule", "update", "--init", "--recursive"], GIT_SLOW_TIMEOUT)).trim() || "submodules up to date" };
    case "pr-create": {
      // gh pr create — title from message, head = current branch. gh owns auth.
      const title = (message ?? "").trim();
      if (!title) throw Error("pr-create needs a title (message)");
      const args = ["pr", "create", "--title", title.slice(0, 200), "--body", (body ?? title).slice(0, 4000)];
      if (ref && safeRef(ref)) args.push("--base", ref);
      return { text: (await ghP(args, GIT_SLOW_TIMEOUT)).trim() }; // run-7 cold-2 M2: pinned like its pr-* siblings
    }
    case "pr-list": {
      const raw = await ghP(["pr", "list", "--limit", "20", "--json", "number,title,state,isDraft,headRefName,url"]);
      const list = JSON.parse(raw || "[]") as { number: number; title: string; state: string; isDraft: boolean; headRefName: string; url: string }[];
      return {
        text: "",
        prs: list.map((r) => ({ n: r.number, title: r.title, state: r.state, draft: r.isDraft, branch: r.headRefName, url: r.url })),
      };
    }
    case "pr-merge": {
      if (!n || !Number.isInteger(n)) throw Error("pr-merge needs a PR number");
      return { text: (await ghP(["pr", "merge", String(n), method === "merge" ? "--merge" : "--squash"], GIT_SLOW_TIMEOUT)).trim() || `PR #${n} merged` };
    }
    case "pr-checks": {
      if (!n || !Number.isInteger(n)) throw Error("pr-checks needs a PR number");
      return { text: (await ghP(["pr", "checks", String(n)], GIT_SLOW_TIMEOUT)).trim() || "no checks reported" };
    }
    case "pr-comment": {
      if (!n || !Number.isInteger(n)) throw Error("pr-comment needs a PR number");
      const text = (body ?? "").trim();
      if (!text) throw Error("pr-comment needs a body");
      return { text: (await ghP(["pr", "comment", String(n), "--body", text.slice(0, 4000)])).trim() };
    }
    case "commit": {
      const msg = (message ?? "").trim();
      if (!msg) throw Error("commit needs a message");
      // IntelliJ-style: chosen files only, when the caller picked some.
      if (files?.length) {
        for (const f of files) if (f.includes("\0") || f === "") throw Error("bad file path");
        return { text: (await g(["commit", "-m", msg, "--", ...gitPaths(files)])).split("\n")[0]?.trim() ?? "committed" };
      }
      return { text: (await g(["commit", "-am", msg])).split("\n")[0]?.trim() ?? "committed" };
    }
    case "worktree-list":
      return { text: (await g(["--no-pager", "worktree", "list"])).trimEnd() };
    case "worktree-add": {
      // branch = create a NEW branch for the worktree; ref = check out an
      // existing one. Both validated the same strict way — never a shell.
      if (!target || !isAbsolute(target)) throw Error("worktree-add needs an absolute target path");
      if (branch) {
        if (!safeRef(branch)) throw Error("worktree-add branch name is invalid (letters, digits, ./-_)");
        return { text: (await g(["worktree", "add", "-b", branch, gitPath(target)])).trim() };
      }
      if (!ref || !safeRef(ref)) throw Error("worktree-add needs a branch (new) or ref (existing)");
      return { text: (await g(["worktree", "add", gitPath(target), ref])).trim() };
    }
    case "worktree-remove": {
      if (!target || !isAbsolute(target)) throw Error("worktree-remove needs an absolute path");
      return { text: (await g(["worktree", "remove", gitPath(target)])).trim() || `removed ${target}` };
    }
  }
}
