import { SharedState } from "./shared-state.js";
import type { StateChange } from "../../dpi-sdk/src/app-state.js";
import type {
  AgentDetail,
  AgentExtensions,
  AgentRef,
  AgentSummary,
  CreateSessionBody,
  DeviceInfo,
  DeviceTree,
  DirListing,
  InboxItem,
  ModelInfo,
  Page,
  SendResult,
  DeviceUsageReport,
  ModelProbe,
  NotifySinkView,
  ProjectPatchBody,
  SchedulePatchBody,
  ScheduleView,
  SessionSearchMatch,
  SessionSearchResult,
  SessionSummary,
  TaskNode,
  TaskOutcome,
  ThinkingLevel,
  UsageTotals,
  WhenBusy,
  WireEntry,
} from "../../dpi-sdk/src/api.js";
import {
  compactionFits,
  DEFAULT_COMPACTION,
  defaultCompaction,
  THINKING_LEVELS,
  type CompactionSettings,
} from "../../dpi-sdk/src/api.js";
import {
  lastAssistantText,
  messageText,
  sumUsage,
  toMarkdown,
  toTranscript,
  type UsageSummary,
} from "../../dpi-sdk/src/transcript.js";
import { ApiFault, invalid, isStorageBusy, isUnreadableStorage, notFound, storageBusyFault } from "./errors.js";
import { git, gitDirtyMarks, gitStatus, onGitDirty } from "./git.js";
import { DatabaseSync } from "node:sqlite";
import { mkdir, readdir, realpath, rename as renamePath, stat } from "node:fs/promises";
import { deviceVitals, type DeviceVitals } from "./vitals.js";
import { ProjectRegistry, type ProjectRecord } from "./projects.js";
import { EnvFileEditor, type EnvFileView } from "./env-vars.js";
import { KeepAwake } from "./awake.js";
import { TelegramBridge, defaultTelegramIo, type TelegramBroker } from "./telegram.js";
import {
  GraphRegistry,
  readyTasks,
  topoOrder,
  type GraphRecord,
  type GraphRunRecord,
  type GraphTask,
} from "./graphs.js";
import {
  MAX_SCHEDULE_NAME_LENGTH,
  ScheduleRegistry,
  normaliseCwd,
  type ScheduleCreateInput,
  type ScheduleRecord,
} from "./schedules.js";
import {
  listArchived,
  findBundle,
  archivedTranscript,
  restoreArchive,
  writeArchiveManifest,
  type ArchivedView,
} from "./archived.js";
import { NotifySinks, type DeliveryResult, type SinkInput, type SinkRecord } from "./notify-sinks.js";
import { zipSync, EXPORT_RAW_LIMIT_BYTES, type ZipEntry } from "./zip.js";
import { salvageFailureNote, salvageSessionDb } from "./salvage.js";
import { mkdirSync, writeFileSync, readFileSync, unlinkSync, readdirSync, renameSync, statSync } from "node:fs";
import { lstat } from "node:fs/promises";
import { ensurePrivateDir } from "../../dpi-sdk/src/node/private-dir.js";
import { join, dirname, relative, resolve, sep } from "node:path";
import { homedir, hostname, platform } from "node:os";
import { randomUUID } from "node:crypto";
import { createRequire } from "node:module";
import { BACKGROUND_CONTEXT as ctx, withAbortSignal } from "@earendil-works/chord/context";
import { createModels } from "@earendil-works/pi-ai/models";
import { openrouterProvider } from "@earendil-works/pi-ai/providers/openrouter";
import { builtinProviders } from "@earendil-works/pi-ai/providers/all";
import {
  loadPiConfig,
  piAuthView as piAuthViewExport,
  readPiAuth,
  readPiModelsJson,
  writePiApiKey,
  removePiApiKey as removePiApiKeyFn,
  piAgentDir,
  type PiAuthEntry,
} from "./pi-config.js";
import { curatedModels, defaultModelId } from "./model-catalog.js";
import { fauxModels, installFaux } from "./faux.js";
import {
  Harness,
  createRegistry,
  InboxDoc,
  type Conversation,
  type ConversationId,
  type ConversationRecord,
  type EntryId,
  type TaskId,
  type SubmissionId,
  type ModelRef,
  type ToolRegistration,
} from "@earendil-works/pi-durable";
import { CodingTools } from "@earendil-works/pi-durable/tools";
import { NodeExecutionEnv } from "@earendil-works/pi-durable/env/node";
import { openNodeSqliteStorage } from "@earendil-works/pi-durable/storage/sqlite/node";
import { createPlayground, Workspace, type SpawnSession } from "./extensions.js";
import { createJobs, JobRuns, JOB_DEFS, jobDef, resolveJobInput, type Jobs } from "./jobs.js";
import { ADDON_INFO, createAddons, PROMPTS, PromptChecklist, type Addons } from "./addons.js";
import { JOB_RUNS_DOC } from "../../dpi-sdk/src/jobs.js";

// The Durable version this device runs, read from the installed artifact so an upgrade cannot leave a stale
// literal here. `/v1/device` reports it; the hub's monitor compares apiVersion separately.
export const DURABLE_VERSION = (() => {
  try {
    return (createRequire(import.meta.url)("@earendil-works/pi-durable/package.json") as { version: string }).version;
  } catch {
    return "unknown";
  }
})();

/**
 * The my-durable build this device runs. `DURABLE_VERSION` above is the
 * pi-durable library; this is the package a human updates with `dpi update`, and
 * the one a UI compares against the hub's own version.
 */
export const PACKAGE_VERSION = (() => {
  let dir = import.meta.dirname;
  for (let i = 0; i < 8; i += 1) {
    try {
      const pkg = JSON.parse(readFileSync(join(dir, "package.json"), "utf8")) as { name?: string; version?: string };
      if (pkg.name === "my-durable" && pkg.version) return pkg.version;
    } catch {
      /* keep walking */
    }
    dir = join(dir, "..");
  }
  return "unknown";
})();

/** Tools that create, update or delete: shell, files, App State, job runs, sessions, pages and subagents. */
export const WRITE_TOOLS = new Set([
  "bash",
  "write",
  "edit",
  "update_state",
  "run_durable_job",
  "ping_on_call_engineer",
  "subagent",
  "start_session",
]);

export type SessionRow = {
  id: string;
  name: string;
  cwd: string;
  dbPath: string;
  createdAt: number;
  model: string;
  provider: string;
};

export interface StoreOptions {
  dataDir: string;
  startDirs: string[];
  name: string;
  provider: "openrouter" | "faux";
  /** The env file the daemon booted from (config.ts's `envFile`); backs the env UI. */
  envFile?: string;
  /** Bot token for the Telegram chat bridge; absent = the bridge stays idle. */
  telegramToken?: string;
  /** R8 schedule-runner budgets, injectable so tests can exercise a wedged
   *  dispatch in milliseconds instead of minutes. Defaults: dispatch 60 s,
   *  settle cap 120 s, tick 30 s. */
  scheduleDispatchTimeoutMs?: number;
  scheduleSettleCapMs?: number;
  scheduleTickMs?: number;
}

/** Agent documents a client may read or stream, by kind. */
/** apps/dpi-backend/src → the checkout root. */
const CODE_DIR = resolve(import.meta.dirname, "../../..");

/** Session search result cap: one screen of matches, not a transcript dump. */
const SEARCH_LIMIT = 50;

/** Scheduler granularity. Schedules are minute-granular, so 30 s is enough and
 *  the timer is unref'd: it never holds the process open. */
const SCHEDULE_TICK_MS = 30_000;

/** Bound on one dispatch's SUBMISSION phase (create + agent resolve + submit —
 *  the cwd realpath walk that wedges on a soft-dead mount lives here, R8 2.2).
 *  A dispatch that outlives the bound is recorded `timeout` and the in-flight
 *  slot is RELEASED: the abandoned attempt may still land its session later
 *  (documented at-least-once cost), but no single wedged cwd may halt the loop.
 *  The intent marker already stamped lastRunAt, so the next slot is a full
 *  interval out — a timeout cannot cause a same-instant refire. */
const SCHEDULE_DISPATCH_TIMEOUT_MS = 60_000;

/** Bound on waiting for the session turn to settle after submit (R8 2.3): the
 *  outcome comes from the turn, not from the enqueue, but a stuck provider must
 *  not hold the schedule's slot forever. Past the cap the run is recorded
 *  `timeout` — an explicit intermediate outcome, never a green "ok". */
const SCHEDULE_SETTLE_CAP_MS = 120_000;

/** R9 2.1: schedule registry persists (markRun) run OUTSIDE the dispatch
 *  deadline — a hung dataDir fs would hold the in-flight guard forever
 *  (Run-now 409s indefinitely, due-skips forever). Every markRun await is
 *  bounded by this cap; the write itself is fire-and-forget-safe (the registry
 *  queue still completes it if the fs recovers, and markRun is idempotent per
 *  run), so a timed-out persist only loses the CRASH-safety record, never the guard. */
const SCHEDULE_REGISTRY_IO_MS = 10_000;

/**
 * Race `work` against a wall-clock budget. The loser is NOT cancelled: a create
 * that timed out may still complete later (its session shows up in the tree);
 * that is the documented at-least-once behaviour of the schedule dispatch.
 * The catch-offshoot exists only so a loser that rejects after the race can
 * never become an unhandled rejection.
 */
async function deadline<T>(work: Promise<T>, ms: number, message: string): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new ApiFault("timeout", message)), ms);
    timer.unref?.();
  });
  work.catch(() => undefined);
  try {
    return await Promise.race([work, timeout]);
  } finally {
    clearTimeout(timer);
  }
}

/** Starting point for a per-model usage accumulator. */
const ZERO_USAGE: UsageSummary = {
  tokens: 0,
  cost: 0,
  input: 0,
  output: 0,
  cacheRead: 0,
  cacheWrite: 0,
  inputCost: 0,
  outputCost: 0,
  cacheReadCost: 0,
  cacheWriteCost: 0,
};

/** A bundle for a session whose store is closed (archived or restarting) still exports its record. */
const NOT_OPENED_README = [
  "This bundle was exported while the session's store was closed.",
  "",
  "It contains manifest.json and session.json only. Start the device and re-export",
  "from the running session to include per-agent transcripts and configs.",
  "",
].join("\n");

/** Catalog schema version of the sessions catalog. The ladder in `prepareCatalog` owns upgrades;
 * a HIGHER version than this build knows refuses cleanly (pi-durable's migrations behavior).
 * Version 1: the R5 baseline — provider column mandatory, version row stamped in meta. */
const CATALOG_SCHEMA_VERSION = 1;

/** "My session #1" → "my-session-1" for the download name. */
function slugName(input: string): string {
  const slug = input
    .normalize("NFKD")
    .replace(/[^\w.-]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 60)
    .toLowerCase();
  return slug || "session";
}

const AGENT_DOCS = { [JOB_RUNS_DOC]: JobRuns, "demo.workspace": Workspace } as const;
export const AGENT_DOC_KINDS = Object.keys(AGENT_DOCS);
export const DEVICE_DOC_KINDS = ["app.shared-state"];

export function lockFile(path: string) {
  mkdirSync(dirname(path), { recursive: true });
  const take = () => writeFileSync(path, String(process.pid), { flag: "wx", mode: 0o600 });
  try {
    take();
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== "EEXIST") throw err;
    const pid = Number(readFileSync(path, "utf8"));
    let alive = false;
    try {
      process.kill(pid, 0);
      alive = true;
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code !== "ESRCH") alive = true;
    }
    if (alive && pid !== process.pid) throw new DeviceAlreadyRunningError(pid, path);
    unlinkSync(path);
    take();
  }
  return () => {
    try {
      if (readFileSync(path, "utf8") === String(process.pid)) unlinkSync(path);
    } catch {}
  };
}

/**
 * A second device on one home (R5 finding 7): the catalog lock is held by a live process.
 * Typed so `Store.open` can turn it into a clean exit instead of an uncaught exception
 * and a crash report that tells the operator to file an issue.
 */
export class DeviceAlreadyRunningError extends Error {
  constructor(
    readonly pid: number,
    readonly path: string,
  ) {
    super(`Database already owned by process ${pid}: ${path}`);
    this.name = "DeviceAlreadyRunningError";
  }
}

type Opened = { harness: Harness; unlock: () => void; unsubscribe: () => void; jobs: Jobs; addons: Addons };
type Resolved = { row: SessionRow; h: Harness; c: Conversation };

/**
 * Is `cwd` the project root `root` itself, or inside it? Pure and
 * platform-injected (the gitPathFor convention): on win32 backslashes and
 * forward slashes compare equal and drive/path case is folded, while POSIX
 * stays byte-identical (a backslash is a legal filename character there).
 * Trailing slashes are normalized on both sides, and the prefix match is
 * boundary-checked, so `D:/src/repo-other` is NOT under `D:/src/repo`.
 */
export function pathsUnder(root: string, cwd: string, platform: NodeJS.Platform = process.platform): boolean {
  const norm = (p: string): string => {
    const slashed = platform === "win32" ? p.replace(/\\/g, "/") : p;
    const trimmed = slashed.length > 1 ? slashed.replace(/\/+$/, "") : slashed;
    return platform === "win32" ? trimmed.toLowerCase() : trimmed;
  };
  const base = norm(root);
  const path = norm(cwd);
  return path === base || path.startsWith(`${base}/`);
}

/**
 * Bounded, secret-free description of the error that failed a Session. It names the error class only: never the
 * cause message, so no SQL values, tokens or transcript can reach a REST error message. The library reports the
 * full cause through the Harness `onReport` (server-side) for diagnostics.
 */
/**
 * Turn a provider's error text into something a picker can act on. Rate limits
 * are the case worth naming: the model works, you just have to wait.
 */
export function classifyProviderError(text: string): Pick<ModelProbe, "status" | "retryAfterMs"> {
  const value = text ?? "";
  const retry = /retry[- ]after[:\s]*(\d+)/iu.exec(value) ?? /(\d+)\s*(?:seconds|s)\b/iu.exec(value);
  const retryAfterMs = retry ? Number(retry[1]) * 1000 : undefined;
  if (/429|rate.?limit|too many requests|quota exceeded|overloaded/iu.test(value))
    return { status: "rate_limited", ...(retryAfterMs ? { retryAfterMs } : {}) };
  if (/401|403|unauthori[sz]ed|invalid api key|authentication|api key/i.test(value))
    return { status: "auth" };
  if (/404|model not found|no such model|unknown model|does not exist/i.test(value))
    return { status: "missing" };
  return { status: "error" };
}

function sessionFailureMessage(error: unknown): string {
  const kind = (error instanceof Error && error.name ? error.name : "unknown").replace(/[^A-Za-z0-9_]/g, "").slice(0, 40);
  return `Session failed and is unavailable (${kind || "unknown"}); reconnect after it is reopened`;
}

const encodeCursor = (cursor: unknown) =>
  cursor === undefined ? undefined : Buffer.from(JSON.stringify(cursor)).toString("base64url");
const decodeCursor = (cursor?: string) => {
  if (!cursor) return undefined;
  try {
    return JSON.parse(Buffer.from(cursor, "base64url").toString("utf8"));
  } catch {
    throw invalid("Invalid cursor");
  }
};

/**
 * One name rule for Store.create and Store.rename, matching a schedule's name
 * (`MAX_SCHEDULE_NAME_LENGTH`): a display name, not a description — the old
 * create-side slice(0,100) silently swallowed a 10k paste where rename threw.
 *
 * "search" (ANY casing) is reserved: GET /v1/sessions/search is a literal
 * route ahead of /sessions/:s, and resolveSession matches names
 * case-insensitively, so a session named Search/search/SEARCH is unreachable
 * through the name every client naturally types (TUI `client.session(name)`).
 */
const RESERVED_SESSION_NAME = "search";
function assertSessionName(name: string): string {
  const trimmed = name.trim();
  if (trimmed.length > MAX_SCHEDULE_NAME_LENGTH)
    throw invalid(`name is ${trimmed.length} characters; the limit is ${MAX_SCHEDULE_NAME_LENGTH}`);
  if (trimmed.toLowerCase() === RESERVED_SESSION_NAME) throw invalid(`"${trimmed}" is a reserved session name`);
  // Control characters never belong in a display name: reject rather than
  // store verbatim (a newline) or silently truncate at a NUL. One rule for
  // create AND rename — the old create path accepted \u0007 etc. and then
  // dead-ended at a rename that refused what it had already stored.
  if (/[\u0000-\u001f\u007f]/.test(trimmed)) throw invalid("name must not contain control characters");
  return trimmed;
}

export class Store {
  /** pi's credentials + custom providers on THIS machine (auth.json / models.json). */
  readonly pi = loadPiConfig();
  readonly models = createModels({ credentials: this.pi.credentials });
  readonly opened = new Map<string, Opened>();
  readonly errors = new Map<string, string>();
  readonly catalog: DatabaseSync;
  readonly startedAt = Date.now();
  shared!: SharedState;
  /** Projects (Wave 2): a registry of roots with labels, grouped by the cwd a
   *  session starts in. Opened with the store so routes never see a half state. */
  projects!: ProjectRegistry;
  /** Schedules (Wave 2): the device owns the clock, the hub only displays it. */
  schedules!: ScheduleRegistry;
  /** Outbound notifications (webhook/ntfy). Delivery never throws into a turn. */
  sinks!: NotifySinks;
  /** The daemon's env file, behind the guarded editor (secrets masked, managed keys refused). */
  readonly env: EnvFileEditor;
  /** Keep-awake (Wave 3): holds the OS awake while any session is busy. */
  readonly awake = new KeepAwake();
  private awakeTimer?: ReturnType<typeof setTimeout>;
  /** Telegram chat bridge (Wave 3): bound chats talk to sessions. */
  telegram?: TelegramBridge;
  /** Task-graphs (Wave 3): a DAG of prompt-tasks, each run as a fresh session. */
  graphs!: GraphRegistry;
  /** Public read-only use: the crash snapshot lists ids mid-run. */
  graphRunsInFlight = new Set<string>();
  uid!: string;
  modelList: ModelInfo[] = [];
  private unlockCatalog: () => void;
  private unlockShared?: () => void;
  private listeners = new Set<() => void>();
  /** Saved thresholds per session; null when the session uses the defaults for its model. */
  private compactions = new Map<string, Partial<CompactionSettings> | null>();
  /** Task labels never change once known: tool names of pi.tool tasks, job titles of job runs. */
  private taskLabels = new Map<string, { label?: string; callId?: string }>();

  get catalogPath() {
    return join(this.options.dataDir, "catalog.sqlite");
  }
  get sharedStatePath() {
    return join(this.options.dataDir, "app-state.sqlite");
  }
  get sessionsDir() {
    return join(this.options.dataDir, "sessions");
  }
  get archiveDir() {
    return join(this.options.dataDir, "archive");
  }
  get projectsPath() {
    return join(this.options.dataDir, "projects.json");
  }
  get schedulesPath() {
    return join(this.options.dataDir, "schedules.json");
  }
  get notifyPath() {
    return join(this.options.dataDir, "notify.json");
  }
  get telegramPath() {
    return join(this.options.dataDir, "telegram.json");
  }
  get graphsPath() {
    return join(this.options.dataDir, "graphs.json");
  }
  get name() {
    return this.options.name;
  }
  get startDirs() {
    return this.options.startDirs;
  }

  private constructor(readonly options: StoreOptions) {
    // dataDir defaults to <home>/backend, so its parent is the config.ts home
    // when the caller did not name an env file explicitly.
    this.env = new EnvFileEditor(options.envFile ?? join(dirname(options.dataDir), "backend.env"));
    if (options.provider === "faux") installFaux(this.models);
    else {
      // The device is pi: register EVERY built-in provider (the same registry
      // the pi CLI uses), then keep OpenRouter narrowed to the curated list.
      // Credentials arrive through pi's own files via the credential store;
      // env keys still work through each provider.
      for (const provider of builtinProviders()) this.models.setProvider(provider);
      for (const provider of this.pi.customProviders) this.models.setProvider(provider);
      const provider = openrouterProvider();
      const catalog = provider.getModels();
      for (const model of curatedModels)
        if (!catalog.some((m) => m.id === model.id)) throw Error(`OpenRouter catalog missing ${model.id}`);
      this.models.setProvider({
        ...provider,
        getModels: () => catalog.filter((m) => curatedModels.some((c) => c.id === m.id)),
      });
    }
    ensurePrivateDir(options.dataDir);
    this.unlockCatalog = lockFile(`${this.catalogPath}.lock`);
    this.catalog = this.openCatalog();
    const uid = this.catalog.prepare("SELECT value FROM meta WHERE key='device_uid'").get() as
      | { value: string }
      | undefined;
    this.uid = uid?.value ?? randomUUID();
    if (!uid) this.catalog.prepare("INSERT INTO meta(key,value) VALUES('device_uid',?)").run(this.uid);
    this.catalog.prepare("DELETE FROM requests WHERE createdAt < ?").run(Date.now() - 24 * 3600_000);
  }

  // --------------------------------------- catalog: open, migrate, recover

  /**
   * Open the catalog with migration and corruption recovery (R5 findings 3+4).
   *
   * An unreadable catalog file used to crash-loop the whole device on every boot
   * (all sessions and the tunnel down) — the JSON registries move corrupt files
   * aside (`.corrupt-<ts>`) and rebuild, but the catalog got nothing. Now the same
   * quarantine applies, a fresh catalog boots, and session rows are re-seeded from
   * the sessions/ directory (per-session best-effort; a session whose db fails to
   * open keeps its row with the failure message the boot loop records).
   */
  private openCatalog(): DatabaseSync {
    try {
      return this.prepareCatalog(new DatabaseSync(this.catalogPath));
    } catch (e) {
      // Anything else (a future schema version, a held lock) is NOT a corrupt file —
      // a future version must refuse cleanly, never be quarantined away.
      if (!isUnreadableStorage(e)) throw e;
      this.quarantineCatalog();
      const db = this.prepareCatalog(new DatabaseSync(this.catalogPath));
      // Pass the handle: `this.catalog` is still undefined here (our caller is
      // the `this.catalog = this.openCatalog()` assignment) — reading it from
      // inside reseed was an uncaught TypeError that crashed the boot AFTER
      // the quarantine warning (the R5 test caught exactly that sequence).
      this.reseedCatalog(db);
      return db;
    }
  }

  /** Run the base DDL, then the schema-version check and the known-old-shape ladder. */
  private prepareCatalog(db: DatabaseSync): DatabaseSync {
    // WAL alone still fsyncs the WAL on EVERY commit (synchronous defaults to FULL);
    // NORMAL only fsyncs at checkpoints — R8 measured catalog commits at 7ms p50
    // under FULL vs 0.11ms under NORMAL on this box (scripts/bench-store.mjs,
    // control.commit phases). The per-session transcript DBs already run
    // NORMAL via pi-durable's openNodeSqliteStorage; this makes the catalog match.
    db.exec(`PRAGMA journal_mode=WAL;
      PRAGMA synchronous=NORMAL;
      CREATE TABLE IF NOT EXISTS sessions(id TEXT PRIMARY KEY,name TEXT NOT NULL,cwd TEXT NOT NULL,dbPath TEXT NOT NULL UNIQUE,createdAt INTEGER NOT NULL,model TEXT NOT NULL,provider TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS conversation_names(sessionId TEXT NOT NULL,conversationId INTEGER NOT NULL,name TEXT NOT NULL,PRIMARY KEY(sessionId,conversationId));
      CREATE TABLE IF NOT EXISTS meta(key TEXT PRIMARY KEY,value TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS requests(key TEXT PRIMARY KEY,route TEXT NOT NULL,status INTEGER NOT NULL,body TEXT NOT NULL,createdAt INTEGER NOT NULL);
      CREATE TABLE IF NOT EXISTS session_spawns(key TEXT PRIMARY KEY,sessionId TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS session_compaction(sessionId TEXT PRIMARY KEY,settings TEXT NOT NULL);`);
    const row = db.prepare("SELECT value FROM meta WHERE key='catalog_schema_version'").get() as
      | { value: string }
      | undefined;
    if (row) {
      const version = Number(row.value);
      if (Number.isFinite(version) && version > CATALOG_SCHEMA_VERSION) {
        db.close();
        // pi-durable's migrations refusal, mirrored: clean bounded message, never a silent attempt.
        throw Error(
          `Catalog schema version ${version} is newer than supported version ${CATALOG_SCHEMA_VERSION}; upgrade my-durable to open this device home`,
        );
      }
      return db;
    }
    // Pre-versioning catalog (every device before R5): run the ladder for known-old
    // shapes, then stamp the version. A device already at the current shape just gets stamped.
    const columns = new Set(
      (db.prepare("PRAGMA table_info(sessions)").all() as { name: string }[]).map((c) => c.name),
    );
    if (!columns.has("provider")) {
      db.exec("ALTER TABLE sessions ADD COLUMN provider TEXT NOT NULL DEFAULT ''");
      process.emitWarning("catalog: migrated sessions table to schema version 1 (added provider)");
    }
    db.prepare("INSERT INTO meta(key,value) VALUES('catalog_schema_version',?)").run(String(CATALOG_SCHEMA_VERSION));
    return db;
  }

  /** Rename an unreadable catalog out of the way instead of deleting it: it is the only copy of that data. */
  private quarantineCatalog(): string {
    const aside = `${this.catalogPath}.corrupt-${Date.now()}`;
    for (const suffix of ["", "-wal", "-shm"] as const) {
      try {
        renameSync(`${this.catalogPath}${suffix}`, `${aside}${suffix}`);
      } catch {}
    }
    process.emitWarning(`catalog.sqlite was unreadable; kept it as ${aside} and rebuilt a fresh catalog`);
    return aside;
  }

  /**
   * Re-seed session rows from sessions/ after a catalog quarantine. The catalog is the
   * only place names/cwds/models live, so rows come back with best-effort identity:
   * a placeholder name, the first start dir as cwd, the device default model, and the
   * file mtime as createdAt. openAgent corrects model/provider from the session's own
   * committed storage at boot; a session whose db fails to open keeps its row with the
   * boot loop's failure message. Names are placeholders — the transcript is intact.
   */
  private reseedCatalog(db: DatabaseSync): void {
    let entries;
    try {
      entries = readdirSync(this.sessionsDir, { withFileTypes: true });
    } catch {
      return;
    }
    const insert = db.prepare(
      "INSERT OR IGNORE INTO sessions(id,name,cwd,dbPath,createdAt,model,provider) VALUES(?,?,?,?,?,?,?)",
    );
    const fallback = this.defaultModelRef();
    for (const entry of entries) {
      if (!entry.isDirectory() || !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(entry.name))
        continue;
      const dbPath = join(this.sessionsDir, entry.name, "agent.sqlite");
      let createdAt = Date.now();
      try {
        createdAt = Math.round(statSync(dbPath).mtimeMs);
      } catch {}
      insert.run(
        entry.name,
        `Recovered session ${entry.name.slice(0, 8)}`,
        this.options.startDirs[0] ?? homedir(),
        dbPath,
        createdAt,
        fallback?.modelId ?? "unknown",
        fallback?.provider ?? "unknown",
      );
    }
  }

  static async open(options: StoreOptions) {
    let store: Store;
    try {
      store = new Store({ ...options, dataDir: resolve(options.dataDir) });
    } catch (e) {
      // R5 finding 7: a second device start on one home used to die as an uncaught
      // exception plus a crash report telling the operator to file an issue. It is
      // not a crash: detect the own-lock case and exit cleanly, no report.
      if (e instanceof DeviceAlreadyRunningError) {
        process.stdout.write(`dpi: already running (pid ${e.pid}) — ${e.path} is owned by that process\n`);
        // Exit 0: the operator's intent ("start the device") is already satisfied by
        // the live process, so a supervisor's restart loop must not fight it.
        process.exit(0);
      }
      throw e;
    }
    // Start dirs are where new sessions begin; create any that do not exist yet.
    await Promise.all(options.startDirs.map((dir) => mkdir(dir, { recursive: true }).catch(() => {})));
    try {
      store.projects = await ProjectRegistry.open(store.projectsPath, {
        warn: (m) => process.emitWarning(`projects: ${m}`),
      });
      // Seed the registry from history: a device that predates projects still
      // shows every root its sessions already live in (idempotent by rootPath).
      for (const row of store.list()) {
        const status = await gitStatus(row.cwd).catch(() => undefined);
        await store.projects
          .ensure({ rootPath: status?.repo ? (status.root ?? row.cwd) : row.cwd, kind: status?.repo ? "git" : "plain" })
          .catch(() => undefined);
      }
      store.schedules = await ScheduleRegistry.open(store.schedulesPath, {
        warn: (m) => process.emitWarning(`schedules: ${m}`),
      });
      // R8 2.4: runs left "started" by a crash become a visible "interrupted"
      // gap. The intent marker already stamped lastRunAt, so due() holds the
      // schedule until its next full slot — the run is not silently re-fired.
      for (const record of await store.schedules.recoverInterrupted())
        process.emitWarning(
          `schedules: run of "${record.name}" was interrupted by a restart; run it again or wait for its next slot`,
        );
      store.sinks = await NotifySinks.open(store.notifyPath, {
        warn: (m) => process.emitWarning(`notify: ${m}`),
        // ntfy often lives on the LAN; the operator opts in explicitly.
        allowPrivateHosts: process.env.DPI_NOTIFY_ALLOW_PRIVATE === "1",
      });
      // Telegram bridge (Wave 3): chats bound to sessions. The broker below is
      // the ONLY bridge-to-store surface — the module itself knows the protocol.
      store.telegram = await TelegramBridge.open(store.telegramPath, defaultTelegramIo(), store.telegramBroker(), {
        warn: (m) => process.emitWarning(`telegram: ${m}`),
      });
      if (options.telegramToken) store.telegram.start(options.telegramToken);
      store.graphs = await GraphRegistry.open(store.graphsPath, {
        warn: (m) => process.emitWarning(`graphs: ${m}`),
      });
      // A restart mid-run never loses the graph: the run flips to interrupted
      // with its running tasks back to pending, and `run` continues from there.
      for (const run of await store.graphs.recoverInterrupted())
        process.emitWarning(`graphs: run ${run.id} of ${run.graphId} was interrupted by a restart; run it again to continue`);
      store.unlockShared = lockFile(`${store.sharedStatePath}.lock`);
      store.shared = await SharedState.open(store.sharedStatePath);
      store.shared.harness.subscribeCommits(() => store.notify());
      for (const row of store.list()) {
        try {
          await store.openAgent(row);
        } catch (e) {
          store.errors.set(row.id, String(e instanceof Error ? e.message : e));
        }
      }
      if (!(await store.shared.initialized()))
        await store.shared.initialize({ goal: "Explore durable agents", counter: 0, notes: [] });
      store.modelList = await store.loadModels();
      for (const { harness } of store.opened.values()) harness.resume();
      store.wireGitWatcher();
      store.startScheduler();
    return store;
    } catch (e) {
      await store.close().catch(() => {});
      throw e;
    }
  }

  // ------------------------------------------------------------ change feed

  subscribe(fn: () => void) {
    this.listeners.add(fn);
    return () => void this.listeners.delete(fn);
  }
  notify = () => {
    for (const fn of this.listeners) fn();
    this.scheduleAwakeSync();
  };

  /**
   * Keep-awake piggybacks on notify (every state change) with a debounce, so
   * there is no extra timer while the device is idle. The inhibitor itself is
   * idempotent — start when the first session turns busy, stop at zero.
   */
  private scheduleAwakeSync() {
    if (this.awakeTimer) return;
    this.awakeTimer = setTimeout(() => {
      this.awakeTimer = undefined;
      void this.syncAwake();
    }, 1000);
    this.awakeTimer.unref?.();
  }

  /** Count busy sessions and tell the inhibitor. Never throws into a turn. */
  private async syncAwake() {
    try {
      let busy = 0;
      for (const [id, opened] of this.opened) {
        if (!this.opened.has(id)) continue;
        const tasks = await this.liveTasks(opened.harness);
        if (tasks.some((t) => !t.background)) busy += 1;
      }
      this.awake.sync(busy);
    } catch {
      /* keep-awake must never break a turn */
    }
  }

  /** The git fs-watcher pokes the tree so every connected UI hears "dirty". */
  private gitWired = false;
  wireGitWatcher() {
    if (this.gitWired) return;
    this.gitWired = true;
    onGitDirty(() => this.notify());
  }

  // ------------------------------------------------------------ device

  deviceInfo(): DeviceInfo {
    return {
      uid: this.uid,
      name: this.name,
      hostname: hostname(),
      platform: `${platform()}-${process.arch} node ${process.version}`,
      apiVersion: 1,
      durableVersion: DURABLE_VERSION,
      packageVersion: PACKAGE_VERSION,
      startedAt: this.startedAt,
      startDirs: this.startDirs,
      models: this.modelList,
      defaultModel: this.defaultModel(),
      provider: this.options.provider,
      ...(this.modelsKeyless ? { providerKeyMissing: true } : {}),
      storage: { dataDir: this.options.dataDir, catalogPath: this.catalogPath, appStatePath: this.sharedStatePath },
      codeDir: CODE_DIR,
      capabilities: [
        "events",
        "docs",
        "demo",
        "jobs",
        ...(this.awake.mode !== "none" ? (["keep-awake"] as const) : []),
        ...(this.telegram?.running ? (["telegram"] as const) : []),
      ],
      /** How this device holds the OS awake while sessions run ("none" = it cannot). */
      keepAwake: this.awake.mode,
      jobs: JOB_DEFS,
    };
  }

  /** The device has no provider key: its catalog is the built-in list. */
  get keyless(): boolean {
    return this.modelsKeyless;
  }

  private defaultModel() {
    if (this.options.provider === "faux") return fauxModels[0].id;
    // The curated constant can drift out of the LIVE catalog (seen: default
    // anthropic/claude-sonnet-5.5 while the credential store held 41 other
    // models) — never point the default outside the catalog we serve.
    // (this.modelList, NOT deviceInfo() — that would recurse.)
    const catalog = this.modelList;
    return catalog.some((m) => `${m.provider}/${m.id}` === defaultModelId)
      ? defaultModelId
      : (catalog[0] ? `${catalog[0].provider}/${catalog[0].id}` : defaultModelId);
  }

  /** defaultModel() as a ModelRef, for callers that need the pair (create's
   *  ladder). Faux ids carry no provider prefix; catalog ids are provider/id. */
  private defaultModelRef(): ModelRef | undefined {
    const id = this.defaultModel();
    if (this.options.provider === "faux") return { provider: "faux", modelId: id };
    const slash = id.indexOf("/");
    if (slash <= 0 || slash === id.length - 1) return undefined;
    return { provider: id.slice(0, slash), modelId: id.slice(slash + 1) };
  }

  /** True when the device has no provider key: the catalog shown is the built-in
   *  list, and chat requests will fail until a key is set (deviceInfo carries it
   *  so every client can say so instead of showing a mystery empty picker). */
  private modelsKeyless = false;

  private async loadModels(): Promise<ModelInfo[]> {
    if (this.options.provider === "faux")
      return fauxModels.map((m) => ({
        id: m.id,
        provider: "faux",
        name: m.name,
        tier: "T",
        icon: "lab.png",
        contextWindow: 128000,
        reasoning: false,
        cost: { input: 0, output: 0 },
      }));
    // The device serves every provider pi can authenticate on this machine:
    // OpenRouter (the curated default) plus each provider pi holds a credential
    // for (auth.json / models.json). Asking per-provider keeps providers with
    // no credential out of the auth check entirely.
    const ids = new Set(["openrouter", ...this.pi.credentialed]);
    const out: ModelInfo[] = [];
    let authenticated = false;
    for (const id of ids) {
      const available = await this.models
        .getAvailable(id, { signal: AbortSignal.timeout(10_000) })
        .catch(() => [] as ReadonlyArray<{ id: string }>);
      if (!available.length) continue;
      authenticated = true;
      if (id === "openrouter") {
        // The curated list, with live context/pricing when the key allows it.
        out.push(
          ...curatedModels.flatMap((c) => {
            const m = available.find((x) => x.id === c.id) as
              | { id: string; contextWindow?: number; reasoning?: boolean; cost?: { input: number; output: number } }
              | undefined;
            return m
              ? [{
                  id: c.id,
                  provider: "openrouter",
                  name: c.name,
                  tier: c.tier,
                  icon: c.icon,
                  contextWindow: m.contextWindow ?? 128000,
                  reasoning: m.reasoning ?? false,
                  cost: { input: m.cost?.input ?? 0, output: m.cost?.output ?? 0 },
                }]
              : [];
          }),
        );
      } else {
        for (const m of available as ReadonlyArray<{
          id: string;
          name?: string;
          contextWindow?: number;
          reasoning?: boolean;
          cost?: { input: number; output: number };
        }>)
          out.push({
            id: m.id,
            provider: id,
            name: m.name ?? m.id,
            tier: "·",
            icon: "lab.png",
            contextWindow: m.contextWindow ?? 128000,
            reasoning: m.reasoning ?? false,
            cost: { input: m.cost?.input ?? 0, output: m.cost?.output ?? 0 },
          });
      }
    }
    if (!authenticated) {
      this.modelsKeyless = true;
      // No credential anywhere: the built-in curated catalog (static metadata)
      // so picking a model is never blocked; chat needs a key.
      const hasChatFields = (m: unknown): m is { id: string; contextWindow: number; reasoning: boolean; cost: { input: number; output: number } } =>
        typeof m === "object" && m !== null && "contextWindow" in m && "reasoning" in m;
      out.push(
        ...this.models
          .getAllModels("openrouter")
          .filter((m) => hasChatFields(m) && curatedModels.some((c) => c.id === m.id))
          .map(
            (m) =>
              hasChatFields(m)
                ? { id: m.id, contextWindow: m.contextWindow, reasoning: m.reasoning, cost: { input: m.cost.input, output: m.cost.output } }
                : undefined,
          )
          .filter(
            (m): m is { id: string; contextWindow: number; reasoning: boolean; cost: { input: number; output: number } } => !!m,
          )
          .map((m) => {
            const c = curatedModels.find((x) => x.id === m.id)!;
            return {
              id: m.id,
              provider: "openrouter",
              name: c.name,
              tier: c.tier,
              icon: c.icon,
              contextWindow: m.contextWindow,
              reasoning: m.reasoning,
              cost: { input: m.cost.input, output: m.cost.output },
            } satisfies ModelInfo;
          }),
      );
    }
    return out;
  }

  routedModel(model?: ModelRef): ModelRef {
    if (this.options.provider === "faux") {
      const id = fauxModels.some((m) => m.id === model?.modelId) ? model!.modelId : fauxModels[0].id;
      return { provider: "faux", modelId: id };
    }
    // A model the device actually serves (pi provider or curated openrouter)
    // keeps its provider; everything else routes to the OpenRouter default.
    if (model && this.modelList.some((m) => m.provider === model.provider && m.id === model.modelId))
      return { provider: model.provider, modelId: model.modelId };
    const exact = model?.provider === "openrouter" ? model.modelId : `${model?.provider}/${model?.modelId}`;
    return {
      provider: "openrouter",
      modelId: curatedModels.some((m) => m.id === exact) ? exact : defaultModelId,
    };
  }

  validateModel(model: unknown): ModelRef {
    const m = model as ModelRef | undefined;
    if (!m || typeof m.provider !== "string" || typeof m.modelId !== "string")
      throw invalid("model must be { provider, modelId }");
    // Known = listed in this device's catalog (faux models, curated OpenRouter,
    // or any provider pi authenticated here). The list IS the contract.
    const known = this.modelList.some((x) => x.provider === m.provider && x.id === m.modelId);
    if (!known) throw invalid(`Unknown model ${m.provider}/${m.modelId}. Choose one from GET /v1/device models`);
    return { provider: m.provider, modelId: m.modelId };
  }

  // ------------------------------------------------------------ directories

  /** Every start dir, realpathed (missing ones dropped): the containment roots
   *  for /fs/dirs and the git routes — symlinks cannot tunnel under them. */
  async startDirRoots(): Promise<string[]> {
    const roots: string[] = [];
    for (const dir of this.startDirs) {
      try {
        roots.push(await realpath(dir));
      } catch {}
    }
    return roots;
  }

  /** A resolved path IS a start dir root or lives under one. */
  private underRoots(candidate: string, roots: string[]): boolean {
    return roots.some((root) => candidate === root || candidate.startsWith(root + sep) || candidate.startsWith(root + "/"));
  }

  /** A caller-supplied path that must stay inside the start dirs: `~` expands,
   *  symlinks resolve, and anything outside answers 400 `invalid`. A path that
   *  does not exist is judged by its deepest EXISTING ancestor (R15, run-2 h6):
   *  a not-yet-existing tail spelled under an in-start-dir symlink must not
   *  pass a lexical prefix check — walk dirname until realpath succeeds,
   *  re-append the missing tail, then judge that (git worktree-add targets
   *  never exist, so the old lexical fallback was the branch every
   *  worktree-add took). */
  async containedPath(input: string): Promise<string> {
    const expanded = input === "~" ? homedir() : input.startsWith("~/") ? join(homedir(), input.slice(2)) : input;
    let candidate: string;
    try {
      candidate = await realpath(resolve(expanded));
    } catch {
      // Not yet existing: resolve the deepest existing ancestor so symlink
      // components are honored, then re-append the missing tail verbatim.
      const absolute = resolve(expanded);
      const tail: string[] = [];
      let current = absolute;
      let resolvedAncestor: string | undefined;
      for (let depth = 0; depth < 64; depth++) {
        const parent = dirname(current);
        if (parent === current) break;
        tail.unshift(current.slice(parent.length + 1));
        current = parent;
        try {
          resolvedAncestor = await realpath(current);
          break;
        } catch {}
      }
      // Fail CLOSED on exhaustion (R15 cold review P1-2): when no existing
      // ancestor was found at all, judging the raw spelling lexically would
      // resurrect the exact symlink escape this walk exists to close.
      if (resolvedAncestor === undefined) throw invalid("path must live under a start dir");
      // R17 (run-3 h1): lstat every re-appended tail component. The walk only
      // calls realpath, which cannot see a DANGLING symlink — a link component
      // pointing at a nonexistent path would ride the tail verbatim and be
      // judged lexically. Any symlink in the tail is resolved-and-rejudged;
      // a dangling one is refused (fail closed on what the walk cannot see).
      let walked = resolvedAncestor;
      for (const part of tail) {
        const next = join(walked, part);
        let isLink = false;
        try {
          isLink = (await lstat(next)).isSymbolicLink();
        } catch {
          isLink = false; // plain missing component: fine, the path is new
        }
        if (isLink) {
          const linked = await realpath(next).catch(() => undefined);
          if (linked === undefined) throw invalid("path must live under a start dir"); // dangling link: refuse
          walked = linked; // existing link target: continue the walk from truth
        } else {
          walked = next;
        }
      }
      candidate = walked;
    }
    if (!this.underRoots(candidate, await this.startDirRoots())) throw invalid("path must live under a start dir");
    return candidate;
  }

  /** The deterministic default when a git route gets no path: the first start
   *  dir — never the daemon's own cwd. */
  async firstStartDir(): Promise<string> {
    return (await this.startDirRoots())[0] ?? resolve(this.startDirs[0] ?? homedir());
  }

  /** Start-dir containment for a would-be session cwd — the rule behind
   *  `create` and every schedule record. `~` expands, a relative path resolves
   *  against the FIRST start dir (what `create` has always done), and the
   *  resolved path must land inside the start-dir roots: the bare `resolve()`
   *  in create used to let an absolute cwd override the base entirely, so
   *  {"cwd":"/etc"} could root a session — or a schedule's run — outside the
   *  sandbox the operator configured. A path that does not exist (a schedule
   *  may point at a mount that is offline right now) is judged lexically, like
   *  `containedPath`. Read paths never re-check: existing sessions whose cwd
   *  predates the rule are not retroactively broken. */
  async assertSessionCwdAllowed(input: string): Promise<void> {
    const expanded = input === "~" ? homedir() : input.startsWith("~/") ? join(homedir(), input.slice(2)) : input;
    const base = this.startDirs[0] ?? homedir();
    let candidate: string;
    try {
      candidate = await realpath(resolve(base, expanded));
    } catch {
      candidate = resolve(base, expanded);
    }
    const roots = await this.startDirRoots();
    if (!this.underRoots(candidate, roots))
      throw invalid(`cwd must live under a start dir (${roots.join(", ") || "none configured on this device"})`);
  }

  async directories(): Promise<DirListing> {
    const dirs: { name: string; path: string }[] = [];
    for (const root of this.startDirs) {
      try {
        dirs.push({ name: root, path: await realpath(root) });
      } catch {}
    }
    return { path: "", dirs };
  }

  async browse(path: string): Promise<DirListing> {
    if (!path) return this.directories();
    const expanded = path === "~" ? homedir() : path.startsWith("~/") ? join(homedir(), path.slice(2)) : path;
    let real: string;
    try {
      real = await realpath(resolve(expanded));
      if (!(await stat(real)).isDirectory()) throw Error();
    } catch {
      throw notFound(`Not a directory on ${this.name}: ${path}`);
    }
    // Containment: only the start dirs and their subdirectories are listable —
    // `~` and ".." traversal count only when they land inside one.
    const roots = await this.startDirRoots();
    if (!this.underRoots(real, roots)) throw invalid("path must live under a start dir");
    const dirs: { name: string; path: string }[] = [];
    try {
      for (const entry of await readdir(real, { withFileTypes: true })) {
        if (!entry.isDirectory() || entry.name.startsWith(".") || entry.name === "node_modules") continue;
        dirs.push({ name: entry.name, path: join(real, entry.name) });
      }
    } catch (e) {
      throw new ApiFault("unavailable", `Cannot list ${real}: ${(e as Error).message}`);
    }
    dirs.sort((a, b) => a.name.localeCompare(b.name));
    // Parent navigation clamps at the roots: a start dir's parent is outside
    // and is never offered to the picker.
    const up = dirname(real) !== real && this.underRoots(dirname(real), roots) ? dirname(real) : undefined;
    return { path: real, parent: up, dirs: dirs.slice(0, 500) };
  }

  // ------------------------------------------------------------ sessions

  list(): SessionRow[] {
    return this.catalog.prepare("SELECT * FROM sessions ORDER BY createdAt DESC").all() as SessionRow[];
  }

  row(id: string): SessionRow {
    const row = this.catalog.prepare("SELECT * FROM sessions WHERE id=?").get(id) as SessionRow | undefined;
    if (!row) throw notFound(`No session ${id}`);
    return row;
  }

  /** A session by UUID or unique case-insensitive name. */
  resolveSession(ref: string): SessionRow {
    const byId = this.catalog.prepare("SELECT * FROM sessions WHERE id=?").get(ref) as SessionRow | undefined;
    if (byId) return byId;
    const matches = this.catalog
      .prepare("SELECT * FROM sessions WHERE lower(name)=lower(?)")
      .all(ref) as SessionRow[];
    if (matches.length === 1) return matches[0];
    if (matches.length > 1)
      throw new ApiFault("ambiguous", `${matches.length} sessions are named "${ref}"; use the session id`);
    throw notFound(`No session "${ref}" on ${this.name}`);
  }

  harness(row: SessionRow) {
    const h = this.opened.get(row.id)?.harness;
    if (!h) throw new ApiFault("unavailable", this.errors.get(row.id) ?? `Session ${row.name} is unavailable`);
    return h;
  }

  /**
   * A Session that failed its own Storage call is closed by pi-durable. Drop its handles and record a bounded,
   * secret-free reason so every later call answers `unavailable` instead of touching a closed Session.
   */
  private failSession(id: string, error: unknown) {
    const opened = this.opened.get(id);
    if (!opened) return; // already cleaned up (normal close in removeSession, or an earlier failure)
    this.opened.delete(id);
    try {
      opened.unsubscribe();
    } catch {}
    try {
      opened.unlock();
    } catch {}
    const reason = sessionFailureMessage(error);
    this.errors.set(id, reason);
    this.taskLabels.clear();
    this.notify();
    // A failed session is the one thing a human must hear about even when no
    // UI is open — fire and forget, delivery never throws.
    void this.notifyEvent({
      kind: "session.failed",
      title: `Session failed on ${this.name}`,
      body: `${this.sessionName(id)}: ${reason}`,
      data: { sessionId: id, device: this.name },
    });
  }

  private sessionName(id: string): string {
    return this.list().find((row) => row.id === id)?.name ?? id;
  }

  // ------------------------------------------------- notifications (Wave 2)

  notifySinkList(): NotifySinkView[] {
    const recent = new Map(this.sinks.recent().map((r) => [r.id, r.silencedUntil]));
    return this.sinks.list().map((sink) => ({ ...sink, silencedUntil: recent.get(sink.id) ?? null }));
  }

  async createNotifySink(input: SinkInput & { allowPrivateHosts?: boolean }): Promise<NotifySinkView> {
    const { allowPrivateHosts, ...sink } = input;
    const created = await this.sinks.create(sink, { allowPrivateHosts: allowPrivateHosts === true });
    this.notify();
    return { ...created, silencedUntil: null };
  }

  async updateNotifySink(
    id: string,
    patch: Partial<SinkInput> & { enabled?: boolean; allowPrivateHosts?: boolean },
  ): Promise<NotifySinkView> {
    const { allowPrivateHosts, ...rest } = patch;
    const sink = await this.sinks.update(id, rest, { allowPrivateHosts: allowPrivateHosts === true });
    this.notify();
    return { ...sink, silencedUntil: null };
  }

  async removeNotifySink(id: string): Promise<{ removed: boolean }> {
    const removed = await this.sinks.remove(id);
    this.notify();
    return { removed };
  }

  /** Fan one event out. Returns per-sink results so a UI can show what happened. */
  async notifyEvent(event: Parameters<NotifySinks["deliver"]>[0]): Promise<DeliveryResult[]> {
    try {
      return await this.sinks.deliver(event, { device: this.name });
    } catch {
      return [];
    }
  }

  /** Send a test event through every enabled sink (the "test" button). */
  async testNotifySinks(): Promise<DeliveryResult[]> {
    return this.notifyEvent({
      kind: "test",
      title: `Test notification from ${this.name}`,
      body: `If you can read this, ${this.name} can reach your sink.`,
      data: { device: this.name },
    });
  }

  /**
   * pi provider keys (gate #2): WRITE-ONLY surface. The view re-reads pi's
   * files (not the boot snapshot) so a rotation is visible immediately;
   * values never leave — masked tails only.
   */
  piAuthView(): PiAuthEntry[] {
    const dir = piAgentDir();
    return piAuthViewExport(readPiAuth(dir), readPiModelsJson(dir));
  }

  setPiApiKey(providerId: string, key: string): { providerId: string; masked: string; restartRequired: true } {
    const entry = writePiApiKey(piAgentDir(), providerId, key);
    return { providerId: entry.providerId, masked: entry.masked, restartRequired: true };
  }

  removePiApiKey(providerId: string): { removed: boolean; restartRequired: true } {
    return { removed: removePiApiKeyFn(piAgentDir(), providerId), restartRequired: true };
  }

  /** The env-file view (secrets masked, process-only vars read-only). */
  envView(): Promise<EnvFileView> {
    return this.env.view();
  }

  /** Set one env key in the device's env file. Applies after the next restart. */
  async setEnvVar(key: string, value: string) {
    const view = await this.env.set(key, value);
    this.notify();
    return view;
  }

  /** Remove one env key. Only file-sourced keys can be removed. */
  async removeEnvVar(key: string) {
    const result = await this.env.unset(key);
    this.notify();
    return result;
  }

  /** The store side of the Telegram bridge: sessions in, answers out. */
  private telegramBroker(): TelegramBroker {
    return {
      listSessions: () => this.list().map((row) => ({ id: row.id, name: row.name })),
      sendToSession: async (sessionId, text) => {
        const { c } = await this.resolveAgent(sessionId, "main");
        const submission = await this.send(c, {
          content: text,
          whenBusy: "followUp",
          requestId: `telegram-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
        });
        return { submissionId: submission.id as number };
      },
      awaitAnswer: async (sessionId, submissionId, timeoutMs) => {
        const row = this.resolveSession(sessionId);
        const h = this.harness(row);
        await this.settled(h, submissionId, timeoutMs).catch(() => undefined);
        const c = await h.conversation(1 as ConversationId, ctx);
        if (!c) return undefined;
        return lastAssistantText(await this.activeEntries(c)) ?? undefined;
      },
    };
  }

  // ------------------------------------------------ task-graphs (Wave 3)

  graphList(includeArchived = false): Array<GraphRecord & { lastRun?: GraphRunRecord }> {
    return this.graphs.list({ includeArchived }).map((g) => ({ ...g, lastRun: this.graphs.lastRun(g.id) }));
  }

  graphGet(id: string): { graph: GraphRecord; runs: GraphRunRecord[] } | undefined {
    const graph = this.graphs.get(id);
    if (!graph) return undefined;
    return { graph, runs: this.graphs.runs(id) };
  }

  async createGraph(body: Record<string, unknown>): Promise<GraphRecord> {
    // R16 (run-2 h6 parity): sessions refuse a bad cwd up-front; graphs ran
    // confined only at run time. Same rule at mutation time.
    if (typeof body?.cwd === "string" && body.cwd.trim())
      await this.assertSessionCwdAllowed(normaliseCwd(body.cwd));
    const created = await this.graphs.create(body as never);
    this.notify();
    return created;
  }

  async updateGraph(id: string, body: Record<string, unknown>): Promise<GraphRecord> {
    if (typeof body?.cwd === "string" && body.cwd.trim())
      await this.assertSessionCwdAllowed(normaliseCwd(body.cwd));
    const updated = await this.graphs.update(id, body as never);
    this.notify();
    return updated;
  }

  async removeGraph(id: string): Promise<{ removed: boolean }> {
    if (this.graphRunsInFlight.has(id)) throw invalid("this graph is running");
    const removed = await this.graphs.remove(id);
    this.notify();
    return { removed };
  }

  /**
   * Start a run. Execution is sequential in topological order — deterministic
   * and debuggable on a single device — and happens in the background: the
   * route answers with the run record immediately, statuses flow through the
   * tree and GET /graphs/:id.
   */
  async runGraphNow(id: string): Promise<{ run: GraphRunRecord }> {
    const record = this.graphs.get(id);
    if (!record) throw notFound(`no graph ${id}`);
    if (this.graphRunsInFlight.has(record.id)) throw invalid("this graph is already running");
    const run = await this.graphs.beginRun(record.id);
    this.graphRunsInFlight.add(record.id);
    this.notify();
    void this.executeGraphRun(record, run.id).catch(() => undefined);
    return { run };
  }

  /** One task = one fresh session (the schedules rule: never overwrite prior work). */
  private async executeGraphTask(record: GraphRecord, runId: string, taskId: string) {
    const task = record.tasks.find((t) => t.id === taskId);
    if (!task) return;
    await this.graphs.markTask(record.id, runId, taskId, { status: "running" });
    this.notify();
    try {
      const session = await this.create({
        name: `${record.name} · ${task.name}`,
        cwd: record.cwd,
        ...(task.model ? { model: task.model } : {}),
      });
      await this.graphs.markTask(record.id, runId, taskId, { sessionId: session.id });
      const row = this.resolveSession(session.id);
      const h = this.harness(row);
      const { c } = await this.resolveAgent(session.id, "main");
      const submission = await this.send(c, {
        content: task.prompt,
        whenBusy: "followUp",
        requestId: `graph-${runId}-${taskId}`,
      });
      const outcome = await this.waitForGraphAnswer(h, submission.id as number);
      await this.graphs.markTask(record.id, runId, taskId, outcome.ok ? { status: "ok" } : { status: "failed", error: outcome.error });
    } catch (e) {
      const error = String(e instanceof Error ? e.message : e).slice(0, 300);
      await this.graphs.markTask(record.id, runId, taskId, { status: "failed", error }).catch(() => undefined);
    }
    this.notify();
  }

  /** A task turn gets 30 minutes; `settled` waits ≤5 min a call, so this polls. */
  private async waitForGraphAnswer(h: Harness, submissionId: number): Promise<{ ok: true } | { ok: false; error: string }> {
    const deadline = Date.now() + 30 * 60_000;
    for (;;) {
      try {
        const r = await this.settled(h, submissionId, 60_000);
        if ("answer" in r) return { ok: true };
        if (r.status === "unanswered") return { ok: false, error: `unanswered: ${r.reason}` };
      } catch (e) {
        return { ok: false, error: String(e instanceof Error ? e.message : e).slice(0, 300) };
      }
      if (Date.now() >= deadline) return { ok: false, error: "timed out after 30 minutes" };
    }
  }

  private async executeGraphRun(record: GraphRecord, runId: string) {
    try {
      const order = topoOrder(record.tasks);
      for (;;) {
        const run = this.graphs.runs(record.id).find((r) => r.id === runId);
        if (!run || run.status !== "running") break;
        const ready = readyTasks(record.tasks, run.tasks).sort((a, b) => order.indexOf(a) - order.indexOf(b));
        if (!ready.length) break; // complete (or fully skipped) — the registry closed it
        await this.executeGraphTask(record, runId, ready[0]!);
      }
      const final = this.graphs.runs(record.id).find((r) => r.id === runId);
      if (final?.status === "ok" || final?.status === "failed")
        void this.notifyEvent({
          kind: final.status === "ok" ? "graph.ok" : "graph.failed",
          title: `Graph ${final.status === "ok" ? "finished" : "failed"}: ${record.name}`,
          body:
            final.status === "ok"
              ? `Every task of "${record.name}" finished ok on ${this.name}.`
              : `A task of "${record.name}" failed on ${this.name}; its dependants were skipped.`,
          data: { graphId: record.id, runId: final.id },
        });
    } finally {
      this.graphRunsInFlight.delete(record.id);
      this.notify();
    }
  }

  /** `spawnKey` records which tool call created the session, in the same transaction as the session row. */
  async create(body: CreateSessionBody, spawnKey?: string): Promise<SessionSummary> {
    if (typeof body?.name !== "string") throw invalid("name is required");
    if (typeof body.cwd !== "string" || !body.cwd.trim()) throw invalid("cwd is required");
    // One name rule for create and rename (assertSessionName, module scope): the old
    // slice(0,100) silently swallowed a 10k paste where rename threw.
    const path = body.cwd.trim();
    const expanded = path === "~" ? homedir() : path.startsWith("~/") ? join(homedir(), path.slice(2)) : path;
    let cwd: string;
    try {
      cwd = await realpath(resolve(this.startDirs[0] ?? homedir(), expanded));
      if (!(await stat(cwd)).isDirectory()) throw Error();
    } catch {
      throw invalid(`cwd must be an existing folder on ${this.name}`);
    }
    // Same containment rule as the fs/git routes: the resolve() above lets an
    // absolute cwd override the start-dir base entirely, which is how
    // {"cwd":"/etc"} used to root a session outside the sandbox. This is the
    // single choke point — schedule runs and graph runs create here too.
    await this.assertSessionCwdAllowed(path);
    // Every session roots a project: the registry is the tree's group-by-cwd,
    // promoted to an entity you can name, label and archive (paseo model).
    const status = await gitStatus(cwd).catch(() => undefined);
    await this.projects
      .ensure({ rootPath: status?.repo ? (status.root ?? cwd) : cwd, kind: status?.repo ? "git" : "plain" })
      .catch(() => undefined);
    // Per-project default model (Wave 2: per-project settings): a session that
    // starts without an explicit model in a project that chose one uses the
    // project's choice. The project of a path is its longest registered root.
    const explicit = body.model as ModelRef | undefined;
    const projectDefault = explicit ? undefined : this.projectForPath(cwd)?.model;
    // Nothing explicit and no project default: fall back to the DEVICE default
    // (GET /v1/device defaultModel — the value every client dialog prefills).
    // Only the genuinely-nothing-available case keeps the old error, so a
    // resolution that cannot be validated (empty catalog, unknown id) falls
    // through to validateModel(undefined).
    let deviceDefault: ModelRef | undefined;
    if (!explicit && !projectDefault) {
      try {
        deviceDefault = this.validateModel(this.defaultModelRef());
      } catch {
        deviceDefault = undefined;
      }
    }
    const model = this.validateModel(explicit ?? projectDefault ?? deviceDefault);
    if (body.thinkingLevel !== undefined && !THINKING_LEVELS.includes(body.thinkingLevel))
      throw invalid("Invalid thinking level");
    const id = randomUUID();
    const row: SessionRow = {
      id,
      name: assertSessionName(body.name) || "Untitled session",
      cwd,
      dbPath: join(this.sessionsDir, id, "agent.sqlite"),
      createdAt: Date.now(),
      model: model.modelId,
      provider: model.provider,
    };
    await this.openAgent(row, true, body.thinkingLevel ?? "medium");
    this.catalog.exec("BEGIN");
    try {
      // Named columns (R5 finding 4): a catalog with an extra or missing future
      // column fails loudly here instead of mis-binding positionally.
      this.catalog
        .prepare("INSERT INTO sessions(id,name,cwd,dbPath,createdAt,model,provider) VALUES(?,?,?,?,?,?,?)")
        .run(id, row.name, cwd, row.dbPath, row.createdAt, row.model, row.provider);
      if (spawnKey) this.catalog.prepare("INSERT OR REPLACE INTO session_spawns VALUES(?,?)").run(spawnKey, id);
      this.catalog.exec("COMMIT");
    } catch (e) {
      this.catalog.exec("ROLLBACK");
      throw e;
    }
    this.notify();
    return this.sessionSummary(row);
  }

  /**
   * The start_session tool. A replay of the same tool call (same `key`) finds the session it created, and the first
   * prompt reuses its requestId, so a crash never starts a second session or sends the prompt twice.
   */
  spawnSession: SpawnSession = async (input) => {
    const found = this.catalog.prepare("SELECT sessionId FROM session_spawns WHERE key=?").get(input.key) as
      | { sessionId: string }
      | undefined;
    const existing = found && this.list().find((r) => r.id === found.sessionId);
    const session = existing
      ? await this.sessionSummary(existing)
      : await this.create(
          { name: input.name, cwd: input.cwd, model: input.model, thinkingLevel: input.thinkingLevel },
          input.key,
        );
    if (!input.prompt) return { session };
    const { c } = await this.resolveAgent(session.id, "main");
    const submission = await this.send(c, { content: input.prompt, requestId: `${input.key}:prompt` });
    return { session, submissionId: submission.id as number };
  };

  rename(row: SessionRow, name: unknown) {
    if (typeof name !== "string" || !name.trim()) throw invalid("A name is required");
    // assertSessionName owns the whole rule: cap, reserved word, control characters.
    const trimmed = assertSessionName(name);
    this.catalog.prepare("UPDATE sessions SET name=? WHERE id=?").run(trimmed, row.id);
    this.notify();
    return this.sessionSummary(this.row(row.id));
  }

  /** Stop all work, close the harness and move its files to archive/. Nothing is deleted. */
  async archive(row: SessionRow) {
    const opened = this.opened.get(row.id);
    if (opened) {
      for (const record of await this.scanAll(opened.harness)) {
        const c = await opened.harness.conversation(record.id, ctx);
        if (c) await c.abort(ctx, { background: true }).catch(() => {});
      }
      opened.unsubscribe();
      try {
        await opened.harness.close(ctx);
      } finally {
        opened.unlock();
      }
      this.opened.delete(row.id);
    }
    await mkdir(this.archiveDir, { recursive: true });
    const archivedAt = Date.now();
    const target = join(this.archiveDir, `${row.id}-${archivedAt}`);
    try {
      await renamePath(dirname(row.dbPath), target);
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code !== "ENOENT") throw e;
    }
    // The bundle keeps its identity: from now on every archive carries a
    // session.json so the archive stays browsable years later (old bundles
    // predating this are listed with a best-effort name).
    writeArchiveManifest(target, {
      sessionId: row.id,
      name: row.name,
      cwd: row.cwd,
      model: row.model,
      provider: row.provider,
      createdAt: row.createdAt,
      archivedAt,
      packageVersion: PACKAGE_VERSION,
    });
    this.catalog.prepare("DELETE FROM conversation_names WHERE sessionId=?").run(row.id);
    this.catalog.prepare("DELETE FROM sessions WHERE id=?").run(row.id);
    this.errors.delete(row.id);
    this.notify();
    return { archived: target };
  }

  /**
   * The old-session surface (policy #3 rationale: nothing auto-deletes, so
   * the archive is worth browsing). List is cheap and never throws; the
   * transcript/restore paths map their module errors to API faults.
   */
  archivedList(): ArchivedView[] {
    return listArchived(this.archiveDir);
  }

  archivedTranscriptView(sessionId: string, format: string) {
    const bundle = findBundle(this.archiveDir, sessionId);
    if (!bundle) throw notFound(`no archived session ${sessionId}`);
    try {
      return archivedTranscript(bundle, format === "markdown" ? "markdown" : "json");
    } catch {
      throw notFound(`archive bundle unreadable for ${sessionId}`);
    }
  }

  async restoreArchivedSession(sessionId: string): Promise<SessionSummary> {
    if (this.list().some((r) => r.id === sessionId))
      throw invalid("a live session with this id already exists");
    const manifest = await restoreArchive(this.archiveDir, this.options.dataDir, sessionId).catch(() => undefined);
    if (!manifest) throw notFound(`no archived session ${sessionId}`);
    const row: SessionRow = {
      id: manifest.sessionId,
      name: manifest.name || "Untitled session",
      cwd: manifest.cwd,
      dbPath: join(this.sessionsDir, manifest.sessionId, "agent.sqlite"),
      createdAt: manifest.createdAt,
      model: manifest.model,
      provider: manifest.provider,
    };
    this.catalog.exec("BEGIN");
    try {
      // Named columns, as in create (R5 finding 4).
      this.catalog
        .prepare("INSERT INTO sessions(id,name,cwd,dbPath,createdAt,model,provider) VALUES(?,?,?,?,?,?,?)")
        .run(row.id, row.name, row.cwd, row.dbPath, row.createdAt, row.model, row.provider);
      this.catalog.exec("COMMIT");
    } catch (e) {
      this.catalog.exec("ROLLBACK");
      throw e;
    }
    this.notify();
    // sessionSummary handles a not-yet-opened session (the closed-bundle path).
    return await this.sessionSummary(row);
  }

  async openAgent(row: SessionRow, create = false, thinkingLevel: ThinkingLevel = "medium") {
    const current = this.opened.get(row.id);
    if (current) return current.harness;
    if (!create) await stat(row.dbPath);
    await mkdir(dirname(row.dbPath), { recursive: true });
    const unlock = lockFile(`${row.dbPath}.lock`);
    try {
      const shellEnv = Object.fromEntries(
        ["PATH", "HOME", "USER", "SHELL", "TMPDIR", "LANG", "TERM"].flatMap((k) =>
          process.env[k] ? [[k, process.env[k]]] : [],
        ),
      );
      const registry = createRegistry();
      registry.install(CodingTools);
      const jobs = createJobs({ shared: this.shared, sessionId: row.id });
      const compaction = () => this.compactionOf(row.id);
      const playground = createPlayground(this.shared, row.id, this.spawnSession, jobs);
      registry.install(playground);
      // Custom extensions are installed but not selected: an agent turns them on in its own selection.
      const addons = createAddons({ offline: this.options.provider === "faux" });
      for (const extension of addons.list) registry.install(extension);
      // R7: an unreadable db (a corrupt header, per the R5 audit recipe — garbage
      // bytes 32-64) used to hide intact data forever: the close-path checkpoint
      // folds the WAL into the corrupt main file without fixing page 1, and the
      // only recovery was a manual header patch. Before failing the open, ONE
      // bounded salvage on a COPY (header patch + integrity_check + atomic
      // promote; see salvage.ts). The original file is never modified — a failed
      // salvage leaves it byte-identical and the failure surface says so. Any other
      // open error (a held lock, a schema mismatch) keeps its existing behavior.
      let storage: Awaited<ReturnType<typeof openNodeSqliteStorage>>;
      try {
        storage = await openNodeSqliteStorage(row.dbPath);
      } catch (error) {
        if (create || !isUnreadableStorage(error)) throw error;
        // R10 5.2: single-flight per session — two routes opening one corrupt db
        // (UI refresh fetching git-files + agents) used to spawn two salvage
        // workers racing on shared scratch; both attempts now share ONE outcome.
        const inFlight = this.salvageInFlight.get(row.id) ?? salvageSessionDb(row.dbPath).then(
          (outcome) => {
            this.salvageInFlight.delete(row.id);
            return outcome;
          },
          // R12 P3-10: clear on rejection too — a cached rejected promise would
          // permanently disable salvage for this session. (Unreachable today:
          // salvageSessionDb resolves on every path — but the map must not
          // depend on that staying true.)
          (error: unknown) => {
            this.salvageInFlight.delete(row.id);
            throw error;
          },
        );
        this.salvageInFlight.set(row.id, inFlight);
        const outcome = await inFlight;
        if (!outcome.recovered) {
          const note = salvageFailureNote(outcome);
          const previous = this.errors.get(row.id);
          this.errors.set(row.id, note); // rides the session summary and every later fault
          this.notify();
          // Same operator visibility failSession gives a mid-run failure — once per
          // distinct note, so repeated failed opens do not spam the sinks.
          if (previous !== note)
            void this.notifyEvent({
              kind: "session.failed",
              title: `Session failed on ${this.name}`,
              body: `${this.sessionName(row.id)}: ${note}`,
              data: { sessionId: row.id, device: this.name },
            });
          throw new ApiFault("unavailable", note);
        }
        process.emitWarning(
          `[dpi-backend] session ${row.id}'s database was unreadable; salvaged a copy (original kept as ${outcome.keptAs}). ` +
            `The copy reflects the database's last consistent state — if its write-ahead log was lost in the crash, the final turns may be missing (the quarantined original retains every byte).`,
        );
        storage = await openNodeSqliteStorage(row.dbPath); // the ONE retry, on the promoted copy
      }
      const harness = await Harness.open(
        storage,
        {
          models: this.models,
          registry,
          env: ({ cwd }) => new NodeExecutionEnv({ cwd: cwd ?? row.cwd, shellEnv }),
          conversationCreated: async (tx, c) => {
            await tx.doc(Workspace, c.id);
            await tx.doc(JobRuns, c.id);
          },
          settings: {
            extensions: [CodingTools, playground],
            // Read at every use, so a PATCH .../compaction applies from the next request.
            get compaction() {
              return compaction();
            },
            progress: { partialIntervalMs: 100, outputIntervalMs: 100 },
          },
          onReport: (e) => console.error("[durable]", String(e)),
        },
        ctx,
      );
      await harness.root(ctx, {
        agent: {
          cwd: row.cwd,
          model: { provider: row.provider, modelId: row.model },
          thinkingLevel,
        },
      });
      // Route stored agent choices to this device's provider before recovery issues any request.
      for (const record of await this.scanAll(harness)) {
        const conversation = (await harness.conversation(record.id, ctx))!;
        const previous = (await conversation.agent(ctx)).model;
        const routed = this.routedModel(previous);
        if (previous?.provider !== routed.provider || previous.modelId !== routed.modelId)
          await conversation.configure({ model: routed }, ctx);
      }
      const rootModel = (await (await harness.root(ctx)).agent(ctx)).model!;
      row.provider = rootModel.provider;
      row.model = rootModel.modelId;
      this.catalog.prepare("UPDATE sessions SET provider=?,model=? WHERE id=?").run(row.provider, row.model, row.id);
      const unsubscribe = harness.subscribeCommits(() => this.notify());
      this.opened.set(row.id, { harness, unlock, unsubscribe, jobs, addons });
      this.errors.delete(row.id);
      // pi-durable 1.2+: any failed Storage call closes the Session, without waiting for the next event.
      // Surface it as unavailable and clean up the handle/listener/lock; never auto-reopen in a loop —
      // a later request reopens it once from committed storage (see openAgent), and fails cleanly if it still fails.
      void harness.closed
        .then((end) => {
          if (end.reason === "failed") this.failSession(row.id, end.error);
        })
        .catch(() => {});
      if (create) harness.resume();
      return harness;
    } catch (e) {
      unlock();
      throw e;
    }
  }

  async scanAll(h: Harness): Promise<ConversationRecord[]> {
    return h.commit(async (tx) => {
      let page = await tx.scanConversations({}, 1000);
      const records = [...page.items];
      while (page.next) {
        page = await tx.scanConversations({}, 1000, page.next);
        records.push(...page.items);
      }
      return records;
    }, ctx);
  }

  /**
   * zcode's flagship, adapted: the paths this session's agents have written or
   * edited — the "commit session changes" changelist. Read-only scan of every
   * conversation's stored entries for write/edit tool calls; caps keep big
   * sessions cheap. No worktree is touched.
   */
  async sessionTouchedFiles(row: SessionRow): Promise<string[]> {
    const h = await this.openAgent(row);
    const paths = new Set<string>();
    await h.commit(async (tx) => {
      let convs = await tx.scanConversations({}, 1000);
      const records = [...convs.items];
      while (convs.next && records.length < 100) {
        convs = await tx.scanConversations({}, 1000, convs.next);
        records.push(...convs.items);
      }
      for (const c of records) {
        let page = await tx.scanEntries({ conversationId: c.id }, 500);
        let seen = 0;
        for (;;) {
          for (const e of page.items as unknown as { model?: readonly { content?: unknown }[] }[]) {
            for (const m of e.model ?? []) {
              const blocks = Array.isArray(m.content) ? (m.content as unknown[]) : [];
              for (const b of blocks as { type?: string; name?: string; arguments?: Record<string, unknown> }[]) {
                if (b?.type !== "toolCall" || (b.name !== "write" && b.name !== "edit")) continue;
                const args = b.arguments ?? {};
                // pi's write/edit speak `path` (edit also nests edits[].path); some
                // harnesses say file_path — accept both, never invent one.
                const candidates: unknown[] = [args.file_path, args.path];
                const edits = Array.isArray(args.edits) ? (args.edits as { path?: unknown }[]) : [];
                for (const ed of edits) candidates.push(ed.path);
                for (const f of candidates) if (typeof f === "string" && f.length > 0 && f.length < 4096) paths.add(f);
              }
            }
          }
          seen += page.items.length;
          if (!page.next || seen >= 4000 || paths.size >= 800) break;
          page = await tx.scanEntries({ conversationId: c.id }, 500, page.next);
        }
      }
    }, ctx);
    return [...paths];
  }

  /**
   * Per-turn file summary (zcode taskChangeSummary): every user turn of the
   * session, with the files its agents wrote or edited during that turn.
   * Line stats come from the UI against the live status — here we only know
   * WHAT was touched and how many times.
   */
  async sessionGitTurns(
    row: SessionRow,
  ): Promise<{ when: string; files: { path: string; writes: number; a?: number; d?: number }[] }[]> {
    const h = await this.openAgent(row);
    type Call = { op: "write" | "edit"; path: string; content?: string; oldText?: string; newText?: string };
    const scanned: { when: string; files: Map<string, number>; calls: Call[] }[] = [];
    let current: { when: string; files: Map<string, number>; calls: Call[] } | null = null;
    const callsOf = (b: { type?: string; name?: string; arguments?: Record<string, unknown> }): Call[] => {
      if (b?.type !== "toolCall" || (b.name !== "write" && b.name !== "edit")) return [];
      const args = b.arguments ?? {};
      const path = typeof args.path === "string" ? args.path : typeof args.file_path === "string" ? args.file_path : undefined;
      if (!path) return [];
      if (b.name === "write") return typeof args.content === "string" ? [{ op: "write", path, content: args.content }] : [];
      const edits = Array.isArray(args.edits)
        ? (args.edits as { oldText?: unknown; newText?: unknown }[])
        : typeof args.oldText === "string" && typeof args.newText === "string"
          ? [{ oldText: args.oldText, newText: args.newText }]
          : [];
      return edits
        .filter((e) => typeof e.oldText === "string" && typeof e.newText === "string")
        .map((e) => ({ op: "edit" as const, path, oldText: e.oldText as string, newText: e.newText as string }));
    };
    await h.commit(async (tx) => {
      let convs = await tx.scanConversations({}, 1000);
      const records = [...convs.items];
      while (convs.next && records.length < 100) {
        convs = await tx.scanConversations({}, 1000, convs.next);
        records.push(...convs.items);
      }
      for (const c of records) {
        // ascending: a turn's tool calls FOLLOW its user entry (default is
        // descending, which attributes every call to the NEXT turn — caught
        // by the git-session-files test).
        let page = await tx.scanEntries({ conversationId: c.id, order: "ascending" }, 500);
        let count = 0;
        for (;;) {
          for (const e of page.items as unknown as { kind?: string; model?: readonly { content?: unknown }[] }[]) {
            if (e.kind === "pi.user") {
              current = { when: new Date().toISOString(), files: new Map(), calls: [] };
              scanned.push(current);
              continue;
            }
            if (!current) continue;
            for (const m of e.model ?? []) {
              const blocks = Array.isArray(m.content) ? (m.content as unknown[]) : [];
              for (const b of blocks as { type?: string; name?: string; arguments?: Record<string, unknown> }[]) {
                for (const call of callsOf(b)) {
                  current.files.set(call.path, (current.files.get(call.path) ?? 0) + 1);
                  current.calls.push(call);
                }
              }
            }
          }
          count += page.items.length;
          if (!page.next || count >= 4000) break;
          page = await tx.scanEntries({ conversationId: c.id }, 500, page.next);
        }
      }
    }, ctx);
    // zcode's line stats, replayed honestly: start from each file's HEAD
    // version (git truth, not snapshots) and re-apply the recorded tool calls
    // in order; a turn's ±n is the net line delta at its boundary.
    const lines = (t: string | null | undefined) => (t == null ? 0 : t.split("\n").length - (t.endsWith("\n") ? 1 : 0));
    let root = "";
    try {
      root = (await git(row.cwd, ["rev-parse", "--show-toplevel"])).trim();
    } catch {
      root = row.cwd;
    }
    const headOf = async (p: string) => {
      const abs = resolve(row.cwd, p);
      const rel = relative(root, abs);
      if (!rel || rel.startsWith("..")) return null;
      try {
        return await git(row.cwd, ["show", `HEAD:${rel}`]);
      } catch {
        return null;
      }
    };
    const content = new Map<string, string | null>();
    for (const p of [...new Set(scanned.flatMap((t) => [...t.files.keys()]))].slice(0, 200))
      content.set(p, await headOf(p));
    return scanned.slice(-20).map((t) => {
      const before = new Map([...content].map(([p, c]) => [p, lines(c)] as const));
      for (const call of t.calls) {
        const cur = content.get(call.path) ?? null;
        if (call.op === "write") content.set(call.path, call.content ?? "");
        else {
          const base = cur ?? "";
          const next = base.split(call.oldText!).join(call.newText!);
          content.set(call.path, next);
        }
      }
      const files = [...t.files.entries()].slice(0, 50).map(([path, writes]) => {
        const delta = lines(content.get(path) ?? null) - (before.get(path) ?? 0);
        return { path, writes, ...(delta !== 0 ? { a: Math.max(0, delta), d: Math.max(0, -delta) } : {}) };
      });
      return { when: t.when, files };
    });
  }

  /** One provider, one model, one throwaway session — is it alive? */
  async probeModel(provider: string, modelId: string): Promise<ModelProbe> {
    if (!provider || !modelId) throw invalid("provider and modelId are required");
    const created: SessionRow[] = [];
    try {
      const summary = await this.create({ name: `probe-${provider}`, cwd: this.startDirs[0] ?? homedir(), model: { provider, modelId } });
      const row = { ...summary, createdAt: Number(summary.createdAt) } as unknown as SessionRow;
      created.push(row);
      const h = await this.openAgent(row);
      const c = (await h.conversation(1 as ConversationId, ctx))!;
      const submission = await this.send(c, { content: "Reply with exactly: ok", whenBusy: "followUp", requestId: `probe-${Date.now()}` });
      const result = await this.settled(h, submission.id as number, 45_000);
      const text = result.status === "done" ? result.answer.text.trim() : "";
      if (result.status === "done" && text) return { ok: true, detail: text.slice(0, 120) };
      const reason = ((result as { reason?: string }).reason ?? "no answer").slice(0, 120);
      // The submission only says "model_error"; the provider's own words live on
      // the last assistant entry. That text is what tells a human whether to wait
      // (429), fix a key (401) or pick another model (404).
      const providerError = await this.lastProviderError(c);
      return { ok: false, detail: (providerError || reason).slice(0, 300), ...classifyProviderError(providerError || reason) };
    } catch (e) {
      const detail = String((e as Error).message).slice(0, 300);
      return { ok: false, detail: detail.slice(0, 160), ...classifyProviderError(detail) };
    } finally {
      for (const r of created) void this.archive(r).catch(() => {});
    }
  }

  /** The most recent assistant error string, if the run failed with one. */
  private async lastProviderError(c: Conversation): Promise<string | undefined> {
    try {
      const entries = await this.activeEntries(c);
      for (let i = entries.length - 1; i >= 0; i -= 1) {
        const error = (entries[i] as { error?: unknown } | undefined)?.error;
        if (typeof error === "string" && error.trim()) return error.trim();
      }
    } catch {
      /* a probe that cannot read its own transcript reports the reason it had */
    }
    return undefined;
  }

  // ------------------------------------------------------------ agents

  private names(sessionId: string) {
    return new Map(
      (
        this.catalog
          .prepare("SELECT conversationId,name FROM conversation_names WHERE sessionId=?")
          .all(sessionId) as { conversationId: number; name: string }[]
      ).map((r) => [r.conversationId, r.name]),
    );
  }

  private agentRef(record: ConversationRecord, names: Map<number, string>): AgentRef {
    const id = record.id as number;
    const kind = record.parent ? "fork" : record.owner ? "subagent" : "root";
    const custom = names.get(id);
    const derived =
      id === 1 ? "Main" : kind === "fork" ? `Fork #${id}` : kind === "subagent" ? `Subagent #${id}` : `Root #${id}`;
    return {
      id,
      name: custom ?? derived,
      named: custom !== undefined,
      kind,
      ...(record.parent ? { parentId: record.parent.conversationId as number, forkedAt: record.parent.at as number } : {}),
      ...(record.owner
        ? { ownerAgentId: record.owner.conversationId as number, ownerTaskId: record.owner.taskId as number }
        : {}),
    };
  }

  async agents(row: SessionRow, tasks?: TaskNode[]): Promise<AgentSummary[]> {
    const h = this.harness(row);
    const names = this.names(row.id);
    const records = await this.scanAll(h);
    const live = tasks ?? (await this.liveTasks(h));
    return records.map((record) => {
      const own = live.filter((t) => t.conversationId === (record.id as number));
      return {
        ...this.agentRef(record, names),
        busy: own.some((t) => !t.background),
        background: own.filter((t) => t.background).length,
      };
    });
  }

  async liveTasks(h: Harness): Promise<TaskNode[]> {
    const graph = await h.taskGraph(ctx);
    try {
      return await this.labelTasks(h, Object.values(graph.value.tasks).map((t) => this.taskNode(t)));
    } finally {
      graph.dispose();
    }
  }

  taskNode(t: unknown): TaskNode {
    const n = t as {
      id: number;
      kind: string;
      conversationId: number;
      owner?: number;
      background: boolean;
      abortRequested?: boolean;
      state: { status: string; phase?: string; on?: readonly number[]; policy?: string; outcome?: string };
      conversations?: readonly number[];
    };
    return {
      id: n.id,
      kind: n.kind,
      conversationId: n.conversationId,
      ...(n.owner !== undefined ? { owner: n.owner } : {}),
      background: !!n.background,
      ...(n.abortRequested ? { aborting: true } : {}),
      state: {
        status: n.state.status,
        ...(n.state.phase ? { phase: n.state.phase } : {}),
        ...(n.state.on ? { on: [...n.state.on] } : {}),
        ...(n.state.policy ? { policy: n.state.policy } : {}),
      },
      conversations: [...(n.conversations ?? [])],
    };
  }

  /** Reopens in flight (resolveAgent's one retry): concurrent requests share the attempt instead of stampeding the same db. */
  private reopenInFlight = new Map<string, Promise<Harness>>();

  /** ONE bounded reopen attempt per session at a time; removes itself when settled. */
  private reopenOnce(row: SessionRow): Promise<Harness> {
    const inFlight = this.reopenInFlight.get(row.id);
    if (inFlight) return inFlight;
    const attempt = this.openAgent(row).finally(() => this.reopenInFlight.delete(row.id));
    this.reopenInFlight.set(row.id, attempt);
    return attempt;
  }

  /** Agent by numeric id, `main`, or unique name (custom or derived, case-insensitive). */
  async resolveAgent(sessionRef: string, agentRef: string): Promise<Resolved> {
    const row = this.resolveSession(sessionRef);
    let h: Harness;
    try {
      h = this.harness(row);
    } catch (e) {
      // R5 finding 1 (the availability brick): once a Session failed (failSession),
      // EVERY agent route used to answer 503 "Session failed and is unavailable"
      // for the process lifetime — the reopen path existed only in
      // sessionTouchedFiles/sessionGitTurns, so a transient storage failure
      // (another process holding the sqlite lock, a full disk) soft-bricked the
      // session until the device restarted. The unavailable fault is exactly the
      // "harness is not open" signal: attempt ONE fresh openAgent here, on the
      // request path every client hits, before answering.
      if (!(e instanceof ApiFault) || e.code !== "unavailable") throw e;
      try {
        h = await this.reopenOnce(row);
      } catch (retryError) {
        if (isStorageBusy(retryError)) throw storageBusyFault();
        // R7: a reopen that failed with its own typed fault (a salvage that was
        // attempted and did not recover) is MORE specific than the recorded
        // "Session X is unavailable" this path used to re-throw — surface it.
        if (retryError instanceof ApiFault) throw retryError;
        throw e; // the recorded, bounded reason — never the raw storage error
      }
    }
    let id: number | undefined;
    if (/^\d+$/.test(agentRef)) id = Number(agentRef);
    else if (agentRef.toLowerCase() === "main") id = 1;
    else {
      const wanted = agentRef.toLowerCase();
      const names = this.names(row.id);
      const matches = (await this.scanAll(h))
        .map((r) => this.agentRef(r, names))
        .filter((a) => a.name.toLowerCase() === wanted);
      if (matches.length > 1) throw new ApiFault("ambiguous", `${matches.length} agents are named "${agentRef}"`);
      id = matches[0]?.id;
    }
    const c = id === undefined ? undefined : await h.conversation(id as ConversationId, ctx);
    if (!c) throw notFound(`No agent "${agentRef}" in session ${row.name}`);
    return { row, h, c };
  }

  async agentSummary(row: SessionRow, c: Conversation): Promise<AgentSummary> {
    const agents = await this.agents(row);
    return agents.find((a) => a.id === (c.id as number))!;
  }

  /** Every tool of the agent's selected extensions, first definition per name, and the names it is offered. */
  private async toolsOf(c: Conversation) {
    const agent = await c.agent(ctx);
    const all = new Map<string, ToolRegistration>();
    for (const extension of agent.extensions)
      for (const tool of extension.tools ?? []) if (!all.has(tool.name)) all.set(tool.name, tool as ToolRegistration);
    return { agent, all: [...all.values()], offered: new Set(agent.tools.map((t) => t.name)) };
  }

  async agentDetail(row: SessionRow, c: Conversation): Promise<AgentDetail> {
    const { agent, all, offered } = await this.toolsOf(c);
    const writers = all.filter((t) => WRITE_TOOLS.has(t.name));
    return {
      ...(await this.agentSummary(row, c)),
      sessionId: row.id,
      config: {
        model: agent.model,
        thinkingLevel: agent.thinkingLevel as ThinkingLevel | undefined,
        instructions: agent.instructions,
        cwd: agent.cwd,
        readOnly: writers.length > 0 && writers.every((t) => !offered.has(t.name)),
      },
      tools: all.map((t) => ({
        name: t.name,
        description: t.description,
        replay: (t.replay ?? "unsafe") as "safe" | "unsafe",
        parameters: JSON.parse(JSON.stringify(t.parameters ?? {})),
        writes: WRITE_TOOLS.has(t.name),
        offered: offered.has(t.name),
      })),
      extensions: agent.extensions.map((e) => e.name),
    };
  }

  setAgentName(row: SessionRow, agentId: number, name: unknown) {
    if (typeof name !== "string" || !name.trim()) throw invalid("A name is required");
    const clean = name.trim().slice(0, 100);
    if (/^\d+$/.test(clean) || clean.toLowerCase() === "main" && agentId !== 1)
      throw invalid("Agent names cannot be numbers or 'main'");
    this.catalog
      .prepare(
        "INSERT INTO conversation_names VALUES(?,?,?) ON CONFLICT(sessionId,conversationId) DO UPDATE SET name=excluded.name",
      )
      .run(row.id, agentId, clean);
    this.notify();
  }

  async createAgent(row: SessionRow, body: { from?: unknown; name?: unknown }) {
    const h = this.harness(row);
    const source = await this.resolveAgent(row.id, String(body.from ?? 1));
    const agent = await source.c.agent(ctx);
    const other = await h.createConversation(
      {
        ownership: { kind: "ownerless" },
        agent: {
          model: agent.model,
          cwd: agent.cwd,
          thinkingLevel: agent.thinkingLevel,
          instructions: agent.instructions,
        },
      },
      ctx,
    );
    if (typeof body.name === "string" && body.name.trim()) this.setAgentName(row, other.id as number, body.name);
    this.notify();
    return this.agentSummary(row, other);
  }

  async fork(row: SessionRow, c: Conversation, body: { entryId?: unknown; name?: unknown }) {
    const at = Number(body.entryId);
    if (!Number.isSafeInteger(at)) throw invalid("entryId is required");
    if (body.name !== undefined && typeof body.name !== "string") throw invalid("Invalid fork name");
    const fork = await c.fork(at as EntryId, { ownership: { kind: "ownerless" } }, ctx);
    const agent = await fork.agent(ctx);
    await fork.configure({ model: this.routedModel(agent.model) }, ctx);
    if (typeof body.name === "string" && body.name.trim()) this.setAgentName(row, fork.id as number, body.name);
    this.notify();
    return this.agentSummary(row, fork);
  }

  async configure(row: SessionRow, c: Conversation, body: Record<string, unknown>) {
    const model = body.model === undefined ? undefined : this.validateModel(body.model);
    if (body.thinkingLevel !== undefined && !THINKING_LEVELS.includes(body.thinkingLevel as ThinkingLevel))
      throw invalid("Invalid thinking level");
    if (body.instructions !== undefined && typeof body.instructions !== "string")
      throw invalid("instructions must be a string");
    let cwd: string | undefined;
    if (body.cwd !== undefined) {
      if (typeof body.cwd !== "string") throw invalid("cwd must be a string");
      cwd = (await this.browse(body.cwd)).path;
    }
    if (body.readOnly !== undefined && typeof body.readOnly !== "boolean") throw invalid("readOnly must be a boolean");
    // Read only filters the agent's tools: the model is never offered the ones that create, update or delete.
    const tools =
      body.readOnly === true
        ? { tools: { remove: (await this.toolsOf(c)).all.filter((t) => WRITE_TOOLS.has(t.name)) } }
        : body.readOnly === false
          ? { tools: null }
          : {};
    await c.configure(
      {
        ...tools,
        ...(model ? { model } : {}),
        ...(body.thinkingLevel ? { thinkingLevel: body.thinkingLevel as ThinkingLevel } : {}),
        ...(typeof body.instructions === "string" ? { instructions: body.instructions.slice(0, 12000) } : {}),
        ...(cwd ? { cwd } : {}),
      },
      ctx,
    );
    if (model && (c.id as number) === 1)
      this.catalog.prepare("UPDATE sessions SET model=?,provider=? WHERE id=?").run(model.modelId, model.provider, row.id);
    // Thresholds are shared by the session's agents; refit them when this model's window is too small for them.
    const window = model ? this.windowOf(model.modelId) : 0;
    if (window && !compactionFits(window, this.compactionOf(row.id))) {
      const fitted = defaultCompaction(window);
      this.setCompaction(row, { reserveTokens: fitted.reserveTokens, backgroundTokens: fitted.backgroundTokens });
    }
    this.notify();
    return (await this.agentDetail(row, c)).config;
  }

  async send(c: Conversation, body: Record<string, unknown>) {
    if (typeof body.content !== "string" || !body.content.trim() || body.content.length > 100000)
      throw invalid("content must be a message under 100,000 characters");
    const whenBusy = (body.whenBusy ?? "followUp") as WhenBusy;
    if (!["steer", "followUp", "reject"].includes(whenBusy)) throw invalid("whenBusy must be followUp, steer or reject");
    if (typeof body.requestId !== "string" || !body.requestId || body.requestId.length > 128)
      throw invalid("requestId is required (≤128 chars) so retries never submit twice");
    return c.submit({ type: "input", content: body.content, requestId: body.requestId, whenBusy }, ctx);
  }

  async settled(h: Harness, submissionId: number, waitMs = 0, signal?: AbortSignal): Promise<SendResult> {
    const submission = await h.submission(submissionId as SubmissionId, ctx);
    if (!submission) throw notFound(`No submission ${submissionId}`);
    let record = await submission.status(ctx);
    if (waitMs > 0 && record.status !== "done" && record.status !== "unanswered") {
      const timeout = AbortSignal.timeout(Math.min(waitMs, 300_000));
      const stop = signal ? AbortSignal.any([timeout, signal]) : timeout;
      try {
        record = await submission.wait(withAbortSignal(stop, ctx));
      } catch (e) {
        if (!stop.aborted) throw e;
      }
    }
    if (record.status === "done" && record.answer !== undefined) {
      const entry = await h.commit((tx) => tx.entry(record.answer as EntryId), ctx);
      const text = (entry?.model ?? []).map((m) => messageText(m as never)).join("").trim();
      return { submissionId, status: "done", answer: { entryId: record.answer as number, text } };
    }
    if (record.status === "unanswered") return { submissionId, status: "unanswered", reason: record.reason };
    return { submissionId, status: record.status === "queued" ? "queued" : "pending" };
  }

  async abort(c: Conversation, background: boolean) {
    await c.abort(ctx, { background });
    return { ok: true as const };
  }

  async withdraw(h: Harness, c: Conversation, submissionId: number) {
    return { status: await h.abortSubmission(submissionId as SubmissionId, ctx, c.id) };
  }

  async compact(c: Conversation, instructions?: unknown) {
    return { taskId: (await c.compact(typeof instructions === "string" && instructions.trim() ? instructions : undefined, ctx)) as number };
  }

  async reset(c: Conversation, note?: unknown) {
    await c.reset(typeof note === "string" && note.trim() ? note : undefined, ctx);
    return { ok: true as const };
  }

  async tasks(h: Harness, status: string, limit: number): Promise<TaskOutcome[]> {
    const items = await h.commit(async (tx) => {
      let page = await tx.scanTasks({}, 500);
      let all = [...page.items];
      while (page.next) {
        page = await tx.scanTasks({}, 500, page.next);
        all = [...all, ...page.items].slice(-2000);
      }
      return all;
    }, ctx);
    const wanted = items.filter((t) =>
      status === "terminal" ? t.state.status === "terminal" : t.state.status !== "terminal",
    );
    return wanted.slice(-Math.min(Math.max(limit, 1), 200)).reverse().map((t) => ({
      id: t.id as number,
      kind: (t as { kind?: string }).kind ?? (t as { definition?: string }).definition ?? "task",
      conversationId: (t as { conversationId?: number }).conversationId,
      state: JSON.parse(JSON.stringify(t.state)),
    }));
  }

  async abortTask(h: Harness, taskId: number) {
    const task = await h.getTask(taskId as TaskId, ctx);
    if (!task) throw notFound(`No task ${taskId}`);
    return { status: await h.abortTask(task.id, ctx) };
  }

  async inspect(h: Harness) {
    return h.inspect(ctx);
  }

  async entries(c: Conversation, cursor: string | undefined, limit: number): Promise<Page<WireEntry>> {
    const page = await c.entries({}, Math.min(Math.max(limit, 1), 2000), decodeCursor(cursor), ctx);
    return { items: page.items as unknown as WireEntry[], next: encodeCursor(page.next) };
  }

  async activeEntries(c: Conversation): Promise<WireEntry[]> {
    const view = await c.viewState(ctx);
    try {
      return JSON.parse(JSON.stringify(view.value.entries)) as WireEntry[];
    } finally {
      view.dispose();
    }
  }

  async transcript(c: Conversation, format: string) {
    const items = toTranscript(await this.activeEntries(c));
    return format === "markdown" ? { format: "markdown", text: toMarkdown(items) } : { format: "json", items };
  }

  async preview(row: SessionRow, agentId: number) {
    const h = this.opened.get(row.id)?.harness;
    const c = h ? await h.conversation(agentId as ConversationId, ctx) : undefined;
    if (!c) return undefined;
    return lastAssistantText(await this.activeEntries(c))?.slice(0, 200);
  }

  async inbox(h: Harness, c: Conversation): Promise<InboxItem[]> {
    const doc = await h.snapshot(InboxDoc, c.id, ctx);
    return (doc?.items ?? []).map((item) => {
      if (item.mode === "write") return { id: item.id as number, mode: "write" as const, content: "Context update" };
      const content = item.content as unknown;
      const text =
        typeof content === "string"
          ? content
          : Array.isArray(content)
            ? content.map((b: { type?: string; text?: string }) => (b.type === "text" ? b.text : "")).join("")
            : undefined;
      return { id: item.id as number, mode: item.mode, content: text };
    });
  }

  async agentDoc(h: Harness, c: Conversation, kind: string) {
    const token = AGENT_DOCS[kind as keyof typeof AGENT_DOCS];
    if (!token) throw notFound(`Unknown agent document ${kind}. Known: ${AGENT_DOC_KINDS.join(", ")}`);
    const value = await h.snapshot(token as typeof JobRuns, c.id, ctx);
    return JSON.parse(JSON.stringify(value ?? (kind === JOB_RUNS_DOC ? { counts: {}, items: {} } : {}))) as unknown;
  }

  async deviceDoc(kind: string) {
    if (kind !== "app.shared-state") throw notFound(`Unknown device document ${kind}`);
    const { value, revision } = await this.shared.snapshot();
    return { value, revision };
  }

  async usage(h: Harness): Promise<UsageTotals> {
    return JSON.parse(JSON.stringify(await h.usage(ctx))) as UsageTotals;
  }

  // ------------------------------------------------------------ custom extensions (per agent)

  async extensionsOf(row: SessionRow, c: Conversation): Promise<AgentExtensions> {
    const active = new Set((await c.agent(ctx)).extensions.map((e) => e.name));
    const checked = (await this.harness(row).snapshot(PromptChecklist, c.id, ctx))?.enabled ?? [PROMPTS[0].id];
    return {
      builtIn: [...active].filter((name) => !ADDON_INFO.some((a) => a.name === name)),
      extensions: ADDON_INFO.map((info) => ({
        ...info,
        enabled: active.has(info.name),
        ...(info.name === "system-prompts"
          ? { prompts: PROMPTS.map(({ id, title, description, text }) => ({ id, title, description, text, enabled: checked.includes(id) })) }
          : {}),
      })),
    };
  }

  /** `{name, enabled}` edits the agent's extension selection; `{prompt, enabled}` edits its prompt checklist. */
  async setExtension(row: SessionRow, c: Conversation, body: Record<string, unknown>) {
    if (typeof body.enabled !== "boolean") throw invalid("enabled must be a boolean");
    const enabled = body.enabled;
    if (typeof body.name === "string") {
      const extension = this.opened.get(row.id)?.addons.all[body.name];
      if (!extension) throw invalid(`Unknown extension ${body.name}. Known: ${ADDON_INFO.map((a) => a.name).join(", ")}`);
      // An array is the agent's whole selection. An { add | remove } object would edit the host default instead and
      // replace the previous edit, so turning one extension on would turn the other off.
      const rank = (name: string) => ADDON_INFO.findIndex((a) => a.name === name);
      const others = (await c.agent(ctx)).extensions.filter((e) => e.name !== extension.name);
      const next = (enabled ? [...others, extension] : others).sort((a, b) => rank(a.name) - rank(b.name));
      await c.configure({ extensions: next }, ctx);
    } else if (typeof body.prompt === "string") {
      const prompt = body.prompt;
      if (!PROMPTS.some((p) => p.id === prompt)) throw invalid(`Unknown prompt ${prompt}. Known: ${PROMPTS.map((p) => p.id).join(", ")}`);
      await c.commit(async (tx) => {
        const doc = await tx.doc(PromptChecklist, c.id);
        const next = new Set(doc.enabled);
        if (enabled) next.add(prompt);
        else next.delete(prompt);
        doc.enabled = PROMPTS.map((p) => p.id).filter((id) => next.has(id));
      }, ctx);
    } else throw invalid("name or prompt is required");
    this.notify();
    return this.extensionsOf(row, c);
  }

  // ------------------------------------------------------------ compaction settings (per session)

  private windowOf(modelId: string) {
    return this.modelList.find((m) => m.id === modelId)?.contextWindow ?? 0;
  }

  /** Saved thresholds, or the defaults for the session model's window (200k background, 250k wait when it fits). */
  compactionOf(sessionId: string): CompactionSettings {
    if (!this.compactions.has(sessionId)) {
      const row = this.catalog.prepare("SELECT settings FROM session_compaction WHERE sessionId=?").get(sessionId) as
        | { settings: string }
        | undefined;
      this.compactions.set(sessionId, row ? (JSON.parse(row.settings) as Partial<CompactionSettings>) : null);
    }
    const saved = this.compactions.get(sessionId);
    if (saved) return { ...DEFAULT_COMPACTION, ...saved };
    const session = this.catalog.prepare("SELECT model FROM sessions WHERE id=?").get(sessionId) as { model: string } | undefined;
    return defaultCompaction(this.windowOf(session?.model ?? ""));
  }

  /** Validate and store new thresholds; pi-durable reads them at its next use, so they apply from the next request. */
  setCompaction(row: SessionRow, body: Record<string, unknown>): CompactionSettings {
    const next = this.compactionOf(row.id);
    const int = (key: "reserveTokens" | "backgroundTokens" | "keepRecentTokens", min: number, max: number) => {
      if (body[key] === undefined) return;
      const n = Number(body[key]);
      if (!Number.isInteger(n) || n < min || n > max) throw invalid(`${key} must be an integer from ${min} to ${max}`);
      next[key] = n;
    };
    if (body.enabled !== undefined) {
      if (typeof body.enabled !== "boolean") throw invalid("enabled must be a boolean");
      next.enabled = body.enabled;
    }
    int("reserveTokens", 1024, 1_000_000);
    int("backgroundTokens", 0, 1_000_000);
    int("keepRecentTokens", 500, 200_000);
    this.catalog
      .prepare("INSERT INTO session_compaction VALUES(?,?) ON CONFLICT(sessionId) DO UPDATE SET settings=excluded.settings")
      .run(row.id, JSON.stringify(next));
    this.compactions.set(row.id, next);
    this.notify();
    return { ...next };
  }

  /** Name every pi.tool task by its tool and every job run by its title, so a task list reads like the transcript. */
  async labelTasks(h: Harness, nodes: TaskNode[]): Promise<TaskNode[]> {
    return Promise.all(
      nodes.map(async (node) => {
        const key = `${node.conversationId}:${node.id}`;
        let known = this.taskLabels.get(key);
        if (!known) {
          known = await this.taskLabel(h, node).catch(() => undefined);
          if (!known) return node;
          this.taskLabels.set(key, known);
          if (this.taskLabels.size > 5000) this.taskLabels.delete(this.taskLabels.keys().next().value!);
        }
        return { ...node, ...known };
      }),
    );
  }

  private async taskLabel(h: Harness, node: TaskNode): Promise<{ label?: string; callId?: string } | undefined> {
    if (node.kind.startsWith("demo.job.")) {
      const run = (await h.snapshot(JobRuns, node.conversationId as ConversationId, ctx))?.items[String(node.id)];
      const def = jobDef(node.kind.slice("demo.job.".length));
      return def ? { label: run ? `${def.title} #${run.run}` : def.title } : undefined;
    }
    if (node.kind !== "pi.tool") return undefined;
    const task = await h.getTask(node.id as TaskId, ctx);
    // pi-durable 1.2+ tagged union: only a model-issued call reads its assistant entry. A nested call
    // (kind "nested") carries no assistant/callId, so it gets no label rather than a fabricated one.
    const input = task?.input as { kind?: string; assistant?: number; callId?: string } | undefined;
    if (input?.kind !== "model" || input.callId === undefined || input.assistant === undefined) return undefined;
    const entry = await h.commit((tx) => tx.entry(input.assistant as EntryId), ctx);
    for (const m of (entry?.model ?? []) as unknown as { role: string; content?: { type: string; id?: string; name?: string }[] }[])
      for (const b of m.role === "assistant" ? (m.content ?? []) : [])
        if (b.type === "toolCall" && b.id === input.callId) return { label: b.name, callId: input.callId };
    return { callId: input.callId };
  }

  // ------------------------------------------------------------ tree

  sessionSummaryBase(row: SessionRow) {
    return {
      id: row.id,
      name: row.name,
      cwd: row.cwd,
      model: row.model,
      provider: row.provider,
      createdAt: row.createdAt,
      dbPath: row.dbPath,
      compaction: this.compactionOf(row.id),
    };
  }

  async sessionSummary(row: SessionRow): Promise<SessionSummary> {
    if (!this.opened.has(row.id))
      return { ...this.sessionSummaryBase(row), busy: false, agents: [], error: this.errors.get(row.id) ?? "Session unavailable" };
    const agents = await this.agents(row);
    return { ...this.sessionSummaryBase(row), busy: agents.some((a) => a.busy), agents };
  }

  async tree(): Promise<DeviceTree> {
    const sessions = await Promise.all(this.list().map((row) => this.sessionSummary(row)));
    const git = gitDirtyMarks();
    return { uid: this.uid, name: this.name, sessions, at: Date.now(), ...(git.length ? { git } : {}) };
  }

  // ------------------------------------------- ops: vitals, search, export

  /** One-shot host health (herdr/piggery shape) — asked for, never polled. */
  async vitals(): Promise<DeviceVitals & { counts: { sessions: number; archived: number } }> {
    const archived = await readdir(this.archiveDir).catch(() => [] as string[]);
    return {
      ...deviceVitals(this.options.dataDir, this.startedAt),
      counts: { sessions: this.list().length, archived: archived.length },
    };
  }

  /**
   * Session search over names, cwds and models — the cheap half of paseo's
   * history search. Transcript text is deliberately NOT scanned: at volume it
   * needs an FTS index, and a naive LIKE over every entry would make the device
   * slow exactly when a human is typing.
   */
  searchSessions(rawQuery: string): SessionSearchResult {
    const query = String(rawQuery ?? "").trim();
    const needle = query.toLowerCase();
    if (needle.length < 2) return { query, matches: [] };
    const matches: SessionSearchMatch[] = [];
    for (const row of this.list()) {
      const where: SessionSearchMatch["where"] = [];
      if (row.name.toLowerCase().includes(needle)) where.push("name");
      if (row.cwd.toLowerCase().includes(needle)) where.push("cwd");
      if (row.model.toLowerCase().includes(needle)) where.push("model");
      if (!where.length) continue;
      const base = this.sessionSummaryBase(row);
      matches.push({
        id: base.id,
        name: base.name,
        cwd: base.cwd,
        model: base.model,
        createdAt: base.createdAt,
        dbPath: base.dbPath,
        ...(base.compaction ? { compaction: base.compaction } : {}),
        where,
      });
    }
    // Name hits first (what a human means by "search my sessions"), then the newest.
    matches.sort(
      (a, b) => Number(b.where.includes("name")) - Number(a.where.includes("name")) || b.createdAt - a.createdAt,
    );
    return { query, matches: matches.slice(0, SEARCH_LIMIT) };
  }

  /**
   * One downloadable archive of a session: manifest, session record, and every
   * agent's transcript + config (paseo `exports.ts` shape). Text only, zipped by
   * our own writer — the device has no archive dependency.
   */
  async exportSession(
    row: SessionRow,
  ): Promise<{ filename: string; mime: string; bytes: number; base64: string }> {
    const agents = this.opened.has(row.id) ? await this.agents(row) : [];
    const files: ZipEntry[] = [];
    const manifest = {
      format: "dpi-session-bundle",
      version: 1,
      exportedAt: new Date().toISOString(),
      device: {
        uid: this.uid,
        name: this.name,
        hostname: hostname(),
        platform: `${platform()} node ${process.version}`,
        durableVersion: DURABLE_VERSION,
      },
      session: { id: row.id, name: row.name, cwd: row.cwd, model: row.model, createdAt: row.createdAt },
      agents: agents.map((a) => ({ id: a.id, name: a.name, kind: a.kind })),
    };
    const opened = this.opened.get(row.id);
    // R7 memory guard: every entry text is held in RAM at zip time, and the zip
    // writer adds deflate + base64 copies (≈2-3× raw). Refuse over the raw limit
    // BEFORE the second copy exists — checked as files accumulate so a huge
    // transcript also skips the per-agent extras that would follow it.
    let rawBytes = 0;
    const push = (entry: ZipEntry) => {
      rawBytes += Buffer.byteLength(entry.text, "utf8");
      if (rawBytes > EXPORT_RAW_LIMIT_BYTES) {
        const mb = (n: number) => `${(n / (1024 * 1024)).toFixed(1)} MiB`;
        throw invalid(
          `Export refused: transcripts are ${mb(rawBytes)} of text, over the ${mb(EXPORT_RAW_LIMIT_BYTES)} in-memory limit. ` +
            `Compact the session first, then export again`,
        );
      }
      files.push(entry);
    };
    push({ path: "manifest.json", text: `${JSON.stringify(manifest, null, 2)}\n` });
    push({ path: "session.json", text: `${JSON.stringify(this.sessionSummaryBase(row), null, 2)}\n` });
    for (const agent of agents) {
      const c = opened ? await opened.harness.conversation(agent.id as ConversationId, ctx) : undefined;
      if (!c) continue;
      const dir = `agents/${agent.id}`;
      push({ path: `${dir}/transcript.json`, text: `${JSON.stringify(await this.transcript(c, "json"), null, 2)}\n` });
      const md = await this.transcript(c, "markdown");
      if (typeof md.text === "string") push({ path: `${dir}/transcript.md`, text: md.text });
      push({ path: `${dir}/config.json`, text: `${JSON.stringify((await this.agentDetail(row, c)).config, null, 2)}\n` });
    }
    if (!agents.length) push({ path: "README.txt", text: NOT_OPENED_README });
    const zip = zipSync(files);
    return {
      filename: `${slugName(row.name || row.id)}.bundle.zip`,
      mime: "application/zip",
      bytes: zip.length,
      base64: zip.toString("base64"),
    };
  }

  // ------------------------------------------------ schedules (Wave 2)

  /** Schedules with their computed next run, for any UI that displays them. */
  scheduleList(): ScheduleView[] {
    return this.schedules.list().map((record) => this.scheduleView(record));
  }

  async createSchedule(input: ScheduleCreateInput): Promise<ScheduleView> {
    // The registry stores cwd as typed (it never stats), so an out-of-sandbox
    // cwd used to surface only when the run spawned its session. Reject the
    // POST up front with the same rule Store.create applies.
    if (typeof input?.cwd === "string" && input.cwd.trim()) await this.assertSessionCwdAllowed(normaliseCwd(input.cwd));
    const record = await this.schedules.create(input);
    this.notify();
    return this.scheduleView(record);
  }

  async updateSchedule(id: string, patch: SchedulePatchBody): Promise<ScheduleView> {
    // Same early refusal when a patch repoints the schedule at /etc.
    if (typeof patch?.cwd === "string" && patch.cwd.trim()) await this.assertSessionCwdAllowed(normaliseCwd(patch.cwd));
    const record = await this.schedules.update(id, patch);
    this.notify();
    return this.scheduleView(record);
  }

  /** R10 Design B: clear schedule/graph refs pointing at sessions a gc pass
   *  removed (the daemon-side sweep — the CLI routes here when the device is
   *  up, so registry mutations happen in-process with no file race). The
   *  registries keep outcome/error history; only the links go. Cap 10k ids. */
  async gcSweepRefs(sessionIds: unknown): Promise<{ schedules: number; graphRuns: number }> {
    if (!Array.isArray(sessionIds)) throw new ApiFault("invalid", "sessionIds must be an array");
    if (sessionIds.length > 10_000) throw new ApiFault("invalid", "sessionIds capped at 10000");
    const ids = new Set(
      sessionIds.filter((id): id is string => typeof id === "string" && id.length > 0 && id.length <= 64),
    );
    const schedules = await this.schedules.clearSessionRefs(ids);
    const graphRuns = await this.graphs.clearSessionRefs(ids);
    if (schedules > 0 || graphRuns > 0) this.notify();
    return { schedules, graphRuns };
  }

  async removeSchedule(id: string): Promise<{ removed: boolean }> {
    const removed = await this.schedules.remove(id);
    // R12 P3-4: the schedule is gone — its degraded-episode markers must not
    // linger in the sets forever (random ids, never reused).
    this.scheduleRegistryDegraded.delete(id);
    this.schedulePruneDegraded.delete(id);
    this.notify();
    return { removed };
  }

  /** Run one schedule now (the "run" button) — same path the timer takes.
   *  Throws ApiFault("busy") (HTTP 409, "already running") when the schedule
   *  has a run in flight: the guard lives in the shared dispatch entry point
   *  (R8 2.1), so a double-clicked Run button gets a typed fault instead of a
   *  second concurrent run with duplicated side effects.
   *
   *  R11 2.3: returns AS SOON AS the run is armed, not when the turn finishes —
   *  a slow turn used to hold the HTTP request (and the hub tunnel) hostage
   *  for up to the full 60 s dispatch deadline + 120 s settle cap; browsers
   *  and proxies time out long before that. No awaits sit between the busy
   *  pre-check and the dispatch (whose guard-add also runs synchronously), so
   *  two Run clicks in one turn cannot both pass. The outcome lands in the
   *  record (scheduleList/view) and the schedule.ok/failed events, exactly as
   *  the timer path's outcomes always have. The route answers 202. */
  async runScheduleNow(id: string): Promise<ScheduleView> {
    const record = this.schedules.get(id);
    if (!record) throw notFound(`no schedule ${id}`);
    if (this.scheduleInFlight.has(record.id)) {
      throw new ApiFault("busy", `Schedule "${record.name}" is already running`);
    }
    void this.dispatchSchedule(record).catch(() => undefined);
    return this.scheduleView(this.schedules.get(id) ?? record);
  }

  private scheduleView(record: ScheduleRecord): ScheduleView {
    // The SDK's ScheduleView union (dpi-sdk/src/api.ts) still lists only
    // "ok" | "failed"; the intermediate outcomes are ordinary wire strings and
    // dpi-sdk is not this fix's file, so carry the recorded value through with
    // a narrowing cast. UIs treat the field as opaque text.
    const { lastOutcome, ...rest } = record;
    // R10 Design A: derived count of ring ids no longer live (archived or gone)
    // so the UI can render "keeping last N" truthfully. Bounded: ring ≤ 100.
    let archivedRuns: number | undefined;
    if (record.keepRuns !== undefined && record.recentSessionIds?.length) {
      archivedRuns = record.recentSessionIds.filter(
        (id) => !this.catalog.prepare("SELECT 1 FROM sessions WHERE id=?").get(id),
      ).length;
    }
    return {
      ...rest,
      ...(lastOutcome === undefined ? {} : { lastOutcome: lastOutcome as ScheduleView["lastOutcome"] }),
      ...(archivedRuns !== undefined ? { archivedRuns } : {}),
      nextRunAt: this.schedules.nextRunAt(record, Date.now()) ?? null,
      running: this.scheduleInFlight.has(record.id),
    };
  }

  /** Ids with a run in flight. ONE guarded entry point (dispatchSchedule): the
   *  timer loop and "Run now" both dispatch through it, so the guard cannot be
   *  bypassed the way the old timer-only check was (R8 2.1). */
  private scheduleInFlight = new Set<string>();
  private scheduleTimer?: ReturnType<typeof setTimeout>;

  /** R11 2.2: schedules whose registry (schedules.json) is currently
   *  unwritable — each is reported ONCE per degraded episode, not per tick. */
  private scheduleRegistryDegraded = new Set<string>();

  /** R12 P2-1: schedules whose retention prune could not archive an evicted
   *  run — reported once per episode; a later successful prune ends it. */
  private schedulePruneDegraded = new Set<string>();

  /** R10 5.2: per-session salvage single-flight — concurrent openers of one
   *  corrupt session share ONE bounded attempt instead of racing scratch files. */
  private salvageInFlight = new Map<string, Promise<import("./salvage.js").SalvageOutcome>>();

  /** R8 schedule budgets (StoreOptions-overridable so tests simulate wedged
   *  dispatches in milliseconds instead of minutes). */
  private get scheduleTickMs(): number {
    return this.options.scheduleTickMs ?? SCHEDULE_TICK_MS;
  }

  private get dispatchTimeoutMs(): number {
    return this.options.scheduleDispatchTimeoutMs ?? SCHEDULE_DISPATCH_TIMEOUT_MS;
  }

  private get settleCapMs(): number {
    return this.options.scheduleSettleCapMs ?? SCHEDULE_SETTLE_CAP_MS;
  }

  /** The device owns the clock (orca automations): a 30 s tick is plenty for a
   *  minute-granularity schedule and costs nothing when there is none. */
  private startScheduler() {
    if (this.scheduleTimer) return;
    const tick = () => {
      // R8 2.2: re-arm BEFORE the pass runs. Chaining the next tick on run
      // completion (`runDueSchedules().finally(tick)`) let ONE wedged dispatch
      // — a cwd on a soft-dead NFS mount whose realpath never resolves — hold
      // the chain open forever and silently halt every schedule on the device.
      // Dispatches are individually bounded (dispatchSchedule), but the pass
      // also awaits registry persists and settle waits; the timer must never
      // depend on any of them. Overlapping passes are safe: the in-flight guard
      // is per schedule id.
      this.scheduleTimer = setTimeout(tick, this.scheduleTickMs);
      this.scheduleTimer.unref?.();
      void this.runDueSchedules().catch(() => undefined);
    };
    tick();
  }

  private stopScheduler() {
    if (this.scheduleTimer) clearTimeout(this.scheduleTimer);
    this.scheduleTimer = undefined;
  }

  /** One pass: dispatch everything due that is not already running. */
  async runDueSchedules(at = Date.now()): Promise<string[]> {
    const started: string[] = [];
    for (const record of this.schedules.due(at)) {
      if (this.scheduleInFlight.has(record.id)) continue;
      // R12 P3-5: only ids that actually DISPATCHED are reported — an
      // intent-marker skip (degraded registry) must not read as "started".
      const ran = await this.dispatchSchedule(record).catch(() => false);
      if (ran) started.push(record.id);
    }
    return started;
  }

  /**
   * A schedule run = a fresh session (so each run has its own transcript and
   * nothing overwrites yesterday's work), the prompt sent to its root agent,
   * then the outcome recorded from the session TURN (not from the enqueue).
   * Failures are recorded, never thrown: a broken schedule must not stop the
   * loop or the daemon — the one exception is the in-flight guard, which the
   * caller sees as a typed busy fault.
   *
   * R8 2.1: this is the ONE guarded entry point; check and add have no await
   * between them, so within the process they are atomic.
   * R8 2.4: the intent marker (`lastRunAt` + outcome "started") is persisted
   * BEFORE the session is created, so a crash in the create→outcome window
   * leaves a visible "interrupted" record after restart instead of silently
   * re-firing the same minute.
   *
   * R12 P3-5: returns true when the dispatch ran (attempted past the intent
   * marker), false when skipped — runDueSchedules reports only the true ones.
   */
  private async dispatchSchedule(record: ScheduleRecord): Promise<boolean> {
    if (this.scheduleInFlight.has(record.id)) {
      throw new ApiFault("busy", `Schedule "${record.name}" is already running`);
    }
    this.scheduleInFlight.add(record.id);
    this.notify();
    try {
      // R11 2.2: the intent marker is the at-most-once anchor. Without it,
      // `due()` re-offers this slot on EVERY tick while the registry is
      // unwritable (disk full, AV lock) and the prompt would re-fire at tick
      // rate — up to 2,880 duplicate real runs/day, each with a notify event.
      // So a failed intent persist now SKIPS the dispatch (the run has not
      // started, so not running it is correct) and surfaces the degraded
      // state ONCE per episode; the next successful write ends the episode.
      // Outcome persists inside dispatchBounded stay best-effort.
      const intentOk = await deadline(
        this.schedules.markRun(record.id, { outcome: "started" }),
        SCHEDULE_REGISTRY_IO_MS,
        "schedule registry write timed out (started)",
      ).then(
        () => true,
        () => false,
      );
      if (!intentOk) {
        if (!this.scheduleRegistryDegraded.has(record.id)) {
          this.scheduleRegistryDegraded.add(record.id);
          void this.notifyEvent({
            kind: "schedule.failed",
            title: `Schedule paused: ${record.name}`,
            body: "its registry is unwritable (disk full or locked) — the run was skipped so it cannot re-fire every tick; it resumes when the registry is writable again",
            data: { scheduleId: record.id },
          });
        }
        return false;
      }
      if (this.scheduleRegistryDegraded.delete(record.id)) {
        void this.notifyEvent({
          kind: "schedule.ok",
          title: `Schedule resumed: ${record.name}`,
          body: "registry writes recovered; scheduled runs continue",
          data: { scheduleId: record.id },
        });
      }
      await this.dispatchBounded(record);
      return true;
    } finally {
      this.scheduleInFlight.delete(record.id);
      this.notify();
    }
  }

  /**
   * The bounded body of one dispatch: submit, wait for the turn, record the
   * outcome. Never throws — every path lands in a recorded outcome.
   *
   * R8 2.2: the submission phase (create + resolve + submit) races a wall-clock
   * deadline, so a wedged cwd becomes a recorded `timeout` and the loop moves
   * on; the abandoned attempt is NOT cancelled and may still complete later
   * (at-least-once, visible as a stray session in the tree).
   * R8 2.3: `send` only enqueues, so the outcome is taken from `settled()` —
   * `done` → ok, `unanswered` → failed, still queued/pending at the cap →
   * `timeout` (explicit intermediate, never a green "ok").
   */
  private async dispatchBounded(record: ScheduleRecord): Promise<void> {
    let sessionId: string | undefined;
    const recordFailure = async (outcome: "failed" | "timeout", detail: string) => {
      await deadline(
        this.schedules.markRun(record.id, {
          ...(sessionId ? { sessionId } : {}),
          outcome,
          error: detail.slice(0, 300),
        }),
        SCHEDULE_REGISTRY_IO_MS,
        "schedule registry write timed out (failure)",
      ).catch(() => undefined);
      void this.notifyEvent({
        kind: "schedule.failed",
        title: `Schedule failed: ${record.name}`,
        body: detail.slice(0, 300),
        data: { scheduleId: record.id },
      });
    };
    try {
      const submitted = await deadline(
        (async () => {
          const session = await this.create({
            name: `${record.name} · ${new Date().toISOString().slice(0, 16).replace("T", " ")}`,
            cwd: record.cwd,
            model: record.model,
          });
          sessionId = session.id;
          const { c, h } = await this.resolveAgent(session.id, "main");
          const submission = await this.send(c, {
            content: record.prompt,
            requestId: `schedule-${record.id}-${Date.now()}`,
          });
          return { h, submission };
        })(),
        this.dispatchTimeoutMs,
        `dispatch timed out after ${this.dispatchTimeoutMs / 1000}s`,
      );
      let result: SendResult;
      try {
        // The settle phase: wait (bounded) for the TURN's terminal state.
        result = await this.settled(submitted.h, submitted.submission.id as number, this.settleCapMs);
      } catch (e) {
        await recordFailure("failed", e instanceof Error ? e.message : String(e));
        return;
      }
      if (result.status === "done") {
        // R10 Design A: snapshot the retention ring BEFORE markRun pushes+trims,
        // then prune whatever fell out of the window (void: never blocks the
        // guard release, no new timers — best-effort archive with retry next run).
        const ringBefore = [...(record.recentSessionIds ?? [])];
        const okRecord = await deadline(
          this.schedules.markRun(record.id, { sessionId, outcome: "ok" }),
          SCHEDULE_REGISTRY_IO_MS,
          "schedule registry write timed out (ok)",
        ).catch(() => undefined);
        if (okRecord?.keepRuns)
          void this.pruneScheduleSessions(okRecord, ringBefore).catch(() => this.markPruneDegraded(okRecord));
        void this.notifyEvent({
          kind: "schedule.ok",
          title: `Schedule ran: ${record.name}`,
          body: `${this.name} finished a run of "${record.name}" in ${record.cwd} (session ${sessionId}).`,
          data: { scheduleId: record.id, sessionId },
        });
        return;
      }
      if (result.status === "unanswered") {
        await recordFailure(
          "failed",
          `schedule turn ended without an answer${result.reason ? `: ${result.reason}` : ""}`,
        );
        return;
      }
      await recordFailure(
        "timeout",
        `turn did not finish within ${this.settleCapMs / 1000}s; it may still complete in session ${sessionId}`,
      );
    } catch (e) {
      // The submission-phase deadline lands here as a typed timeout fault;
      // everything else is a dispatch error. Both are recorded, never thrown.
      const timedOut = e instanceof ApiFault && e.code === "timeout";
      await recordFailure(timedOut ? "timeout" : "failed", e instanceof Error ? e.message : String(e));
    }
  }

  /** R10 Design A: archive run sessions that fell out of the schedule's
   *  keepRuns window. Called (void, best-effort) only from the ok-path of a
   *  successful dispatch, with the ring as it was BEFORE markRun trimmed it.
   *  `ringBefore \ ringAfter` = evicted ids; each LIVE evicted session is
   *  archived via the existing store.archive path (abort-open → atomic rename
   *  to archive/ → catalog row deleted — nothing deleted, restorable, ages into
   *  the gc plan). Archive failure leaves the session live; the id is already
   *  gone from the ring, so a PERSISTENT failure accumulates one straggler
   *  per run until recovery — unbounded while the fault lasts, which is why
   *  R12 P2-1 reports the degraded episode instead of swallowing it. */
  /** R12 P2-1: the once-per-episode signal for a retention prune that could
   *  not archive an evicted run — shared by the prune's own failure path and
   *  the void-caller's outer catch. */
  private markPruneDegraded(record: ScheduleRecord): void {
    if (this.schedulePruneDegraded.has(record.id)) return;
    this.schedulePruneDegraded.add(record.id);
    void this.notifyEvent({
      kind: "schedule.failed",
      title: `Retention paused: ${record.name}`,
      body: `an evicted run's session could not be archived (archive/ unwritable or disk full?) — it stays live; ` +
        `retention resumes when archiving works again`,
      data: { scheduleId: record.id },
    });
  }

  private async pruneScheduleSessions(record: ScheduleRecord, ringBefore: string[]): Promise<void> {
    if (typeof record.keepRuns !== "number") return;
    const ringNow = new Set(record.recentSessionIds ?? []);
    const evicted = [...new Set(ringBefore)].filter((id) => !ringNow.has(id));
    let archived = 0;
    try {
      for (const id of evicted) {
        const row = this.catalog.prepare("SELECT * FROM sessions WHERE id=?").get(id) as SessionRow | undefined;
        if (!row) continue; // already gone (archived/corrupt-removed) — nothing to do
        await this.archive(row);
        archived += 1;
      }
    } catch {
      // R12 P2-1: a persistent archive failure (archive/ unwritable, disk full)
      // used to be swallowed silently — and since markRun already trimmed the
      // ring, every later run left one more live session behind FOREVER, the
      // exact growth this feature exists to prevent, with zero signal.
      this.markPruneDegraded(record);
      return;
    }
    if (evicted.length > 0 && this.schedulePruneDegraded.delete(record.id)) {
      void this.notifyEvent({
        kind: "schedule.ok",
        title: `Retention resumed: ${record.name}`,
        body:
          archived > 0
            ? `archived ${archived} evicted run(s); the window is healthy again`
            : `archiving works again (the evicted run(s) were already gone); the window is healthy`,
        data: { scheduleId: record.id },
      });
    }
  }

  // ------------------------------------------------- projects (Wave 2)

  /** The project a path belongs to: its longest registered root. */
  private projectForPath(cwd: string): ProjectRecord | undefined {
    let best: ProjectRecord | undefined;
    for (const project of this.projects.list({ includeArchived: false })) {
      // Slash/case-normalized compare (pathsUnder): a session cwd recorded as
      // `D:\src\repo` must match a project registered as `D:/src/repo`.
      const isUnder = pathsUnder(project.rootPath, cwd);
      if (isUnder && (!best || project.rootPath.length > best.rootPath.length)) best = project;
    }
    return best;
  }

  /** Projects, newest activity first: the tree's group-by-cwd as an entity. */
  projectList(includeArchived = false): ProjectRecord[] {
    return this.projects.list({ includeArchived });
  }

  /**
   * Rename/label a project. `customName` wins over the derived basename, and
   * labels are what humans filter by — paseo's rule that reconciliation never
   * touches either.
   */
  async updateProject(id: string, patch: ProjectPatchBody): Promise<ProjectRecord> {
    // Only the keys the caller actually sent: passing `customName: undefined`
    // must not read as "clear the name" (that is `customName: ""`).
    const next: { customName?: string; labels?: string[]; model?: { provider: string; modelId: string } | "" } = {};
    if (patch.customName !== undefined) next.customName = patch.customName;
    if (patch.labels !== undefined) next.labels = patch.labels;
    if (patch.model !== undefined) next.model = patch.model;
    return this.projects.update(id, next);
  }

  async archiveProject(id: string): Promise<ProjectRecord> {
    this.notify();
    return this.projects.archive(id);
  }

  async unarchiveProject(id: string): Promise<ProjectRecord> {
    this.notify();
    return this.projects.unarchive(id);
  }

  /**
   * Usage rollup (orca `usage/`, our data): every live session's harness usage,
   * summed per session, per model and per project. Archived sessions are closed
   * stores, so they are not counted — this is "what this device is spending on
   * the work it still holds", not a lifetime invoice.
   */
  async usageReport(): Promise<DeviceUsageReport> {
    const models = new Map<string, UsageSummary>();
    const projects = new Map<string, DeviceUsageReport["projects"][number]>();
    const sessions: DeviceUsageReport["sessions"] = [];
    let tokens = 0;
    let cost = 0;

    for (const row of this.list()) {
      const opened = this.opened.get(row.id);
      if (!opened) continue;
      const raw = await this.usage(opened.harness);
      const usage = sumUsage(raw);
      for (const [key, u] of Object.entries(raw.models ?? {})) {
        const prev = models.get(key) ?? ZERO_USAGE;
        models.set(key, {
          tokens: prev.tokens + (u.totalTokens ?? 0),
          cost: prev.cost + (u.cost?.total ?? 0),
          input: prev.input + (u.input ?? 0),
          output: prev.output + (u.output ?? 0),
          cacheRead: prev.cacheRead + (u.cacheRead ?? 0),
          cacheWrite: prev.cacheWrite + (u.cacheWrite ?? 0),
          inputCost: prev.inputCost + (u.cost?.input ?? 0),
          outputCost: prev.outputCost + (u.cost?.output ?? 0),
          cacheReadCost: prev.cacheReadCost + (u.cost?.cacheRead ?? 0),
          cacheWriteCost: prev.cacheWriteCost + (u.cost?.cacheWrite ?? 0),
        });
      }
      const project = this.projects.findByPath(row.cwd) ?? this.projects.findByPath(dirname(row.cwd));
      sessions.push({
        id: row.id,
        name: row.name,
        cwd: row.cwd,
        project: project ? (project.customName ?? project.name) : undefined,
        tokens: usage.tokens,
        cost: usage.cost,
        agents: (await this.agents(row)).length,
      });
      tokens += usage.tokens;
      cost += usage.cost;
      if (project) {
        const prev = projects.get(project.id) ?? {
          rootPath: project.rootPath,
          name: project.customName ?? project.name,
          tokens: 0,
          cost: 0,
          sessions: 0,
        };
        projects.set(project.id, {
          ...prev,
          tokens: prev.tokens + usage.tokens,
          cost: prev.cost + usage.cost,
          sessions: prev.sessions + 1,
        });
      }
    }

    return {
      at: Date.now(),
      totals: { tokens, cost },
      models: [...models.entries()]
        .map(([key, value]) => ({ key, ...value }))
        .sort((a, b) => b.cost - a.cost || b.tokens - a.tokens),
      sessions: sessions.sort((a, b) => b.cost - a.cost || b.tokens - a.tokens),
      projects: [...projects.values()].sort((a, b) => b.cost - a.cost || b.tokens - a.tokens),
    };
  }

  // ------------------------------------------------------------ demo extension

  async demoState(c: Conversation, body: Record<string, unknown>) {
    let change = body as unknown as StateChange;
    if (body.operation === undefined) {
      const { value } = await this.shared.snapshot();
      if (typeof body.goal === "string")
        change = { operation: Object.hasOwn(value, "goal") ? "update" : "create", path: "/goal", value: body.goal };
      else if (body.increment === true) change = { operation: "increment", path: "/counter", value: 1 };
      else if (typeof body.note === "string") change = { operation: "create", path: "/notes/-", value: body.note };
      else throw invalid("A state operation is required");
    }
    await this.shared.change(
      change,
      undefined,
      typeof body.expectedRevision === "number" ? body.expectedRevision : undefined,
    );
    await c.commit(
      (tx) =>
        tx.appendEntry(c.id, {
          kind: "demo.state-change",
          data: { text: `Shared App State: ${change.operation} ${change.path || "/"}` },
        }),
      ctx,
    );
    return { ok: true as const, ...(await this.deviceDoc("app.shared-state")) };
  }

  /** Start a durable job from a client: the conversation owns the run, and a transcript entry anchors its card. */
  async startJob(row: SessionRow, h: Harness, c: Conversation, body: Record<string, unknown>) {
    const def = typeof body.job === "string" ? jobDef(body.job) : undefined;
    if (!def) throw invalid(`job must be one of ${JOB_DEFS.map((d) => d.id).join(", ")}`);
    let input;
    try {
      input = resolveJobInput(def, body.input ?? {});
    } catch (e) {
      throw invalid((e as Error).message);
    }
    const jobs = this.opened.get(row.id)?.jobs;
    if (!jobs) throw new ApiFault("unavailable", "Session is not open");
    const taskId = await c.commit(async (tx) => {
      const id = await jobs.start(tx, c.id, { def, input, startedBy: "you", now: Date.now() });
      await tx.appendEntry(c.id, { kind: "demo.job", data: { taskId: id as number, job: def.id, text: `Started ${def.title}` } });
      return id;
    }, ctx);
    h.resume();
    return { taskId: taskId as number };
  }

  async approveJob(c: Conversation, taskId: number, approved: unknown) {
    if (typeof approved !== "boolean") throw invalid("approved must be a boolean");
    await c.commit(async (tx) => {
      const run = (await tx.doc(JobRuns, c.id)).items[String(taskId)];
      if (!run || run.approval !== "pending") throw new ApiFault("conflict", "No pending approval for that run");
      run.approval = approved ? "approved" : "declined";
    }, ctx);
    return { ok: true as const };
  }

  // ------------------------------------------------------------ idempotency

  replay(key: string, route: string) {
    const row = this.catalog.prepare("SELECT * FROM requests WHERE key=?").get(key) as
      | { route: string; status: number; body: string }
      | undefined;
    if (!row) return undefined;
    if (row.route !== route) throw invalid("Idempotency-Key was already used for a different request");
    return { status: row.status, body: JSON.parse(row.body) as unknown };
  }

  remember(key: string, route: string, status: number, body: unknown) {
    this.catalog
      .prepare("INSERT OR IGNORE INTO requests VALUES(?,?,?,?,?)")
      .run(key, route, status, JSON.stringify(body), Date.now());
  }

  // ------------------------------------------------------------ lifecycle

  async close() {
    this.stopScheduler();
    if (this.awakeTimer) clearTimeout(this.awakeTimer);
    this.awake.stop();
    this.telegram?.stop();
    // A graceful stop marks an in-flight graph run interrupted (not lost).
    await this.graphs?.recoverInterrupted().catch(() => undefined);
    for (const { harness, unlock, unsubscribe } of this.opened.values()) {
      unsubscribe();
      try {
        await harness.close(ctx);
      } finally {
        unlock();
      }
    }
    this.opened.clear();
    await this.shared?.close();
    this.unlockShared?.();
    this.catalog.close();
    this.unlockCatalog();
  }
}

export type { Resolved };
