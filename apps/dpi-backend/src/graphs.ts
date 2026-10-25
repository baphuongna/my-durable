/**
 * Device-side task-graph registry — "Task-graph orchestration", the last Wave 3
 * SHOULD of docs/host-project-checklist.md (modelled on paseo's
 * `packages/server/src/server/tasks/task-graph.ts` + `execution-order`).
 *
 * A graph is a named DAG of prompt-tasks. Each task, once EVERY dependency
 * reached ok, runs as a fresh session on the device — the schedules-proven "a
 * run = a fresh session" rule. This module owns records, validation, pure
 * planning (`topoOrder`/`readyTasks`/`cascadeSkips`/`runComplete`) and run-state
 * bookkeeping (`beginRun`/`markTask`/`recoverInterrupted`). It deliberately does
 * NOT execute anything: the store drives a run through these methods, one
 * session per task, because a task that reuses a session would inherit the
 * previous task's context and the DAG would no longer be a DAG of independent
 * steps.
 *
 * The file handling is lifted from `schedules.ts`/`projects.ts` on purpose —
 * same atomic temp+rename, same `.bak` rolling backup, same "unreadable file is
 * moved aside, never overwritten" rule, same 0600/0700 perms, same serialised
 * mutation queue and the same typed errors (`invalid` → 400, `not_found` → 404).
 * A registry must never lose records silently.
 *
 * Everything here is Node builtins only: `node:fs/promises`, `node:crypto`,
 * `node:path`. No shell, no zod, no SDK imports beyond the shared private-dir guard.
 */
import { randomBytes } from "node:crypto";
import { chmod, copyFile, readFile, rename, unlink, writeFile } from "node:fs/promises";
import { dirname, isAbsolute, resolve } from "node:path";
import { ensurePrivateDir } from "../../dpi-sdk/src/node/private-dir.js";

/** Bumped only when the on-disk shape changes; `migrate` owns the upgrade path. */
export const GRAPH_REGISTRY_VERSION = 1;

/** A label a human reads in a list — not a description. */
export const MAX_GRAPH_NAME_LENGTH = 80;
/** Task display names share the graph-name budget: a chip, not a paragraph. */
export const MAX_TASK_NAME_LENGTH = 80;
/** A prompt is a message, not a document; graphs get more headroom than schedules (20k vs 8k). */
export const MAX_TASK_PROMPT_LENGTH = 20_000;
/** A DAG a human can still reason about on one screen. */
export const MAX_TASKS = 32;
/** Run history per graph: enough to debug a week of runs, small enough to keep the file quick. */
export const MAX_RUNS_PER_GRAPH = 20;
/** Run summaries are read by humans in a list; the full trace lives in the session. */
export const MAX_TASK_ERROR_LENGTH = 300;

/** Lowercase slug: stable enough to type, reference in dependsOn and read in logs. */
const TASK_ID_PATTERN = /^[a-z0-9][a-z0-9-]{0,31}$/;

/** One node of the DAG. Runs as a fresh session once every dependency reached ok. */
export interface GraphTask {
  /** Stable id inside the graph: lowercase slug, unique, ≤32 chars. */
  id: string;
  /** Display name, ≤80 chars. */
  name: string;
  /** What the session is asked; non-empty, ≤20_000 chars. Kept verbatim. */
  prompt: string;
  /** Task ids this task waits on; `[]` = root task. */
  dependsOn: string[];
  /** Optional model override; project/apply rules belong to the store, not here. */
  model?: { provider: string; modelId: string };
}

/** A named DAG plus the human-typed cwd its sessions start in. */
export interface GraphRecord {
  /** `grp_<10 hex>`; stable across edits of the graph. */
  id: string;
  /** Human label, ≤80 characters. */
  name: string;
  /** Human-typed path (the store resolves it like schedules' `normaliseCwd`). */
  cwd: string;
  tasks: GraphTask[];
  createdAt: string;
  updatedAt: string;
  archivedAt: string | null;
}

export type TaskRunStatus = "pending" | "running" | "ok" | "failed" | "skipped";

/** What `markTask` accepts: present keys only, like every patch in this codebase. */
export interface TaskRunPatch {
  status?: TaskRunStatus;
  sessionId?: string;
  error?: string;
}

/** The state of one task inside one run. Every task has an entry from run start. */
export interface TaskRunState {
  status: TaskRunStatus;
  /** The session this task ran as (a run = a fresh session per task). */
  sessionId?: string;
  /** ≤300 chars, truncated by this module — the session holds the full trace. */
  error?: string;
  startedAt?: string;
  endedAt?: string;
}

export type GraphRunStatus = "running" | "ok" | "failed" | "interrupted";

/** One execution of a whole graph. */
export interface GraphRunRecord {
  /** `run_<startedAt-ms>_<4hex>` — sortable, unique per graph. */
  id: string;
  graphId: string;
  startedAt: string;
  finishedAt: string | null;
  /** "running" while work remains; "ok" | "failed" | "interrupted" once terminal. */
  status: GraphRunStatus;
  /** Keyed by task id; every task has an entry from run start. */
  tasks: Record<string, TaskRunState>;
}

/** What `create` accepts. */
export interface GraphInput {
  name: string;
  cwd: string;
  tasks: GraphTask[];
}

/** What `update` accepts: name/cwd/tasks replace-whole when present; absent keys untouched. */
export type GraphPatch = Partial<GraphInput>;

/** The on-disk document. `version` exists so a future shape can be migrated instead of discarded. */
export interface GraphRegistryFile {
  version: 1;
  graphs: GraphRecord[];
  runs: GraphRunRecord[];
}

export type GraphErrorCode = "invalid" | "not_found";

/** Typed failure so routes can answer 400 (`invalid`) or 404 (`not_found`) without string matching. */
export class GraphError extends Error {
  readonly code: GraphErrorCode;

  constructor(code: GraphErrorCode, message: string) {
    super(message);
    this.name = "GraphError";
    this.code = code;
  }
}

export interface GraphRegistryOptions {
  /** Where unreadable-file / recovery notices go. Defaults to `console.warn`. */
  warn?: (message: string, error?: unknown) => void;
  /** Injectable clock (ISO string) — tests pin timestamps instead of sleeping. */
  now?: () => string;
}

const invalid = (message: string) => new GraphError("invalid", message);
const notFound = (id: string) => new GraphError("not_found", `no graph ${id}`);
const describeError = (error: unknown) => (error instanceof Error ? error.message : String(error));
const defaultWarn = (message: string, error?: unknown) =>
  console.warn(`[graphs] ${message}`, error === undefined ? "" : describeError(error));

const nonEmptyString = (value: unknown): string | undefined =>
  typeof value === "string" && value.trim() ? value.trim() : undefined;

const cloneTask = (task: GraphTask): GraphTask => ({
  ...task,
  dependsOn: [...task.dependsOn],
  ...(task.model ? { model: { ...task.model } } : {}),
});

/** Records are handed out as deep copies: `tasks`/`model` are nested and must not alias the cache. */
const cloneGraph = (record: GraphRecord): GraphRecord => ({
  ...record,
  tasks: record.tasks.map(cloneTask),
});

/** Runs are handed out as deep copies too (`tasks` is a nested record). */
const cloneRun = (run: GraphRunRecord): GraphRunRecord => ({
  ...run,
  tasks: Object.fromEntries(Object.entries(run.tasks).map(([id, state]) => [id, { ...state }])),
});

/** `grp_` + 10 hex: short enough to type as a prefix, wide enough that collisions are not a real risk. */
export function newGraphId(): string {
  return `grp_${randomBytes(5).toString("hex")}`;
}

/** `run_<startedAt-ms>_<4hex>` — the ms prefix makes the list sortable, the hex breaks same-ms ties. */
export function newRunId(startedAtMs: number): string {
  return `run_${startedAtMs}_${randomBytes(2).toString("hex")}`;
}

/**
 * Keep the path the human typed: the device resolves a relative cwd against its
 * start dirs when the run creates the session (`Store.create`), so resolving it
 * here — against the daemon's own cwd — would point at a folder that does not
 * exist on the device. Same rule as schedules' `normaliseCwd` (this copy throws
 * `GraphError`, not `ScheduleRegistryError`).
 */
export function normaliseGraphCwd(cwd: string): string {
  const trimmed = typeof cwd === "string" ? cwd.trim() : "";
  if (!trimmed) throw invalid("cwd is required");
  if (trimmed === "~" || trimmed.startsWith("~/")) return trimmed; // home is expanded by the device
  return isAbsolute(trimmed) ? resolve(trimmed) : trimmed.replace(/[\\/]+$/, "");
}

function normaliseName(value: unknown): string {
  const name = nonEmptyString(value);
  if (!name) throw invalid("name is required");
  if (name.length > MAX_GRAPH_NAME_LENGTH) {
    throw invalid(`name is ${name.length} characters; the limit is ${MAX_GRAPH_NAME_LENGTH}`);
  }
  return name;
}

function normaliseTaskName(id: string, value: unknown): string {
  const name = nonEmptyString(value);
  if (!name) throw invalid(`task "${id}" needs a name`);
  if (name.length > MAX_TASK_NAME_LENGTH) {
    throw invalid(`task "${id}" name is ${name.length} characters; the limit is ${MAX_TASK_NAME_LENGTH}`);
  }
  return name;
}

function normaliseTaskPrompt(id: string, value: unknown): string {
  if (typeof value !== "string" || !value.trim()) throw invalid(`task "${id}" needs a prompt`);
  if (value.length > MAX_TASK_PROMPT_LENGTH) {
    throw invalid(`task "${id}" prompt is ${value.length} characters; the limit is ${MAX_TASK_PROMPT_LENGTH}`);
  }
  // Kept verbatim: the prompt is the user's words, and re-indenting it would change it.
  return value;
}

function normaliseTaskModel(id: string, value: unknown): { provider: string; modelId: string } | undefined {
  if (value === undefined || value === null) return undefined;
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw invalid(`task "${id}" model must be { provider, modelId }`);
  }
  const source = value as Record<string, unknown>;
  const provider = nonEmptyString(source.provider);
  const modelId = nonEmptyString(source.modelId);
  if (!provider) throw invalid(`task "${id}" model.provider is required`);
  if (!modelId) throw invalid(`task "${id}" model.modelId is required`);
  return { provider, modelId };
}

// ---------------------------------------------------------------- cycle + order

/**
 * Build the cycle error, naming the tasks stuck in the ring. `stuck` is what
 * Kahn could not emit: every task in it has at least one dependency that is
 * also stuck, so walking dependencies inside the set must revisit a node — that
 * walk IS the ring, and the closing edge is the "… depends on …" the message quotes.
 */
function cycleError(tasks: readonly GraphTask[], stuck: ReadonlySet<string>): GraphError {
  const byId = new Map(tasks.map((task) => [task.id, task]));
  const start = [...stuck].sort()[0] ?? "";
  const path: string[] = [];
  const firstSeen = new Map<string, number>();
  let current = start;
  while (current !== undefined && !firstSeen.has(current)) {
    firstSeen.set(current, path.length);
    path.push(current);
    current = (byId.get(current)?.dependsOn ?? []).filter((dep) => stuck.has(dep)).sort()[0];
  }
  if (current === undefined || path.length < 2) {
    // Unreachable while `dependsOn ⊆ ids` holds (validated first); kept honest anyway.
    return invalid(`the graph has a cycle (${[...stuck].sort().join(", ")})`);
  }
  const ring = path.slice(firstSeen.get(current)!);
  const closed = [...ring, ring[0]].join(" → ");
  return invalid(`task "${path[path.length - 1]}" depends on "${current}": the graph has a cycle (${closed})`);
}

/**
 * A topological order of the task ids — what the store runs in. Deterministic:
 * among the tasks whose dependencies are all placed, the smallest id goes next,
 * so two runs of the same graph execute in the same order.
 *
 * Pure: no fs, no clock. Throws `GraphError` (`invalid`) on an unknown
 * dependency or a cycle.
 */
export function topoOrder(tasks: readonly GraphTask[]): string[] {
  if (!Array.isArray(tasks)) throw invalid("tasks must be a list");
  const byId = new Map(tasks.map((task) => [task.id, task]));
  for (const task of tasks) {
    for (const dep of task.dependsOn) {
      if (!byId.has(dep)) throw invalid(`task "${task.id}" depends on unknown task "${dep}"`);
    }
  }
  const remaining = new Set(byId.keys());
  const order: string[] = [];
  while (remaining.size) {
    const next = [...remaining]
      .filter((id) => (byId.get(id)?.dependsOn ?? []).every((dep: string) => !remaining.has(dep)))
      .sort()[0];
    if (next === undefined) throw cycleError(tasks, remaining);
    order.push(next);
    remaining.delete(next);
  }
  return order;
}

/**
 * Strict task-list validation for `create`/`update` (1–32 tasks, slug ids,
 * unique, deps ⊆ ids, no self-reference, no duplicate dep, acyclic). Throws
 * rather than coercing, so the human who typed a broken graph is told about it.
 */
export function normaliseTasks(tasks: readonly GraphTask[]): GraphTask[] {
  if (!Array.isArray(tasks)) throw invalid("tasks must be a list");
  if (tasks.length < 1 || tasks.length > MAX_TASKS) {
    throw invalid(`a graph needs 1–${MAX_TASKS} tasks, got ${tasks.length}`);
  }
  const out: GraphTask[] = [];
  const ids = new Set<string>();
  for (const raw of tasks) {
    if (!raw || typeof raw !== "object") throw invalid("each task must be an object");
    const source = raw as Record<string, unknown>;
    const id = typeof source.id === "string" ? source.id.trim() : "";
    if (!TASK_ID_PATTERN.test(id)) {
      throw invalid(
        `task id "${String(source.id)}" must be a lowercase slug: a-z, 0-9 and "-", at most 32 characters, starting with a letter or digit`,
      );
    }
    if (ids.has(id)) throw invalid(`task id "${id}" is used twice`);
    ids.add(id);
    if (source.dependsOn !== undefined && source.dependsOn !== null && !Array.isArray(source.dependsOn)) {
      throw invalid(`task "${id}" dependsOn must be a list of task ids`);
    }
    const dependsOn = (Array.isArray(source.dependsOn) ? source.dependsOn : []) as unknown[];
    const deps: string[] = [];
    for (const dep of dependsOn) {
      if (typeof dep !== "string") throw invalid(`task "${id}" dependsOn must be a list of task ids`);
      const name = dep.trim();
      if (!name) continue; // a trailing comma is not an error worth a 400
      if (name === id) throw invalid(`task "${id}" cannot depend on itself`);
      if (deps.includes(name)) throw invalid(`task "${id}" lists dependency "${name}" twice`);
      deps.push(name);
    }
    const model = normaliseTaskModel(id, source.model);
    out.push({
      id,
      name: normaliseTaskName(id, source.name),
      prompt: normaliseTaskPrompt(id, source.prompt),
      dependsOn: deps,
      ...(model ? { model } : {}),
    });
  }
  for (const task of out) {
    for (const dep of task.dependsOn) {
      if (!ids.has(dep)) throw invalid(`task "${task.id}" depends on unknown task "${dep}"`);
    }
  }
  topoOrder(out); // throws invalid("… depends on …: the graph has a cycle") naming the ring
  return out;
}

// ---------------------------------------------------------------- pure planning

/**
 * Which pending tasks have every dependency ok right now — the store's pick
 * list. Order follows the task list, so it is stable per graph shape.
 */
export function readyTasks(tasks: readonly GraphTask[], runs: Record<string, TaskRunState>): string[] {
  return tasks
    .filter(
      (task) =>
        runs[task.id]?.status === "pending" && task.dependsOn.every((dep) => runs[dep]?.status === "ok"),
    )
    .map((task) => task.id);
}

/**
 * Cascade: mark every pending task whose dependencies can never all be ok as
 * skipped, recursively. A dep in {failed, skipped} can never become ok; a dep in
 * {pending, running} still can, so its dependents are neither ready nor skipped.
 *
 * Mutates `runs` in place (it is the live run record) and returns the
 * newly-skipped ids in topological order, so the caller logs them causally.
 */
export function cascadeSkips(tasks: readonly GraphTask[], runs: Record<string, TaskRunState>): string[] {
  const skipped: string[] = [];
  const byId = new Map(tasks.map((task) => [task.id, task]));
  for (const id of topoOrder(tasks)) {
    const state = runs[id];
    if (!state || state.status !== "pending") continue;
    const doomed = (byId.get(id)?.dependsOn ?? []).some((dep) => {
      const depState = runs[dep];
      return depState?.status === "failed" || depState?.status === "skipped";
    });
    if (doomed) {
      state.status = "skipped";
      skipped.push(id);
    }
  }
  return skipped;
}

/** Terminal when no task is pending or running. An empty record is vacuously complete. */
export function runComplete(runs: Record<string, TaskRunState>): boolean {
  return Object.values(runs).every(
    (state) => state.status === "ok" || state.status === "failed" || state.status === "skipped",
  );
}

/** "ok" only when every task reached ok; any failed OR skipped task is a failed outcome for the run. */
function runOutcome(runs: Record<string, TaskRunState>): "ok" | "failed" {
  return Object.values(runs).every((state) => state.status === "ok") ? "ok" : "failed";
}

// ------------------------------------------------------------------ load path

const isTaskRunStatus = (value: unknown): value is TaskRunStatus =>
  value === "pending" || value === "running" || value === "ok" || value === "failed" || value === "skipped";
const isRunStatus = (value: unknown): value is GraphRunStatus =>
  value === "running" || value === "ok" || value === "failed" || value === "interrupted";

/**
 * Lenient task read for the load path: drop tasks whose ids are unusable, keep
 * the rest with repaired names/prompts, filter deps to known ids (no self, no
 * duplicates). A hand-edited file must not wipe the registry — but a graph that
 * became CYCLIC by hand cannot be run at all, so it fails the file, which is
 * then moved aside (with `.bak` tried) instead of silently forgotten.
 */
function coerceTasks(raw: unknown): GraphTask[] {
  if (!Array.isArray(raw)) return [];
  const tasks: GraphTask[] = [];
  const ids = new Set<string>();
  for (const entry of raw) {
    if (!entry || typeof entry !== "object") continue;
    const source = entry as Record<string, unknown>;
    const id = typeof source.id === "string" ? source.id.trim() : "";
    if (!TASK_ID_PATTERN.test(id) || ids.has(id)) continue;
    ids.add(id);
    const model =
      source.model && typeof source.model === "object" && !Array.isArray(source.model)
        ? (source.model as { provider?: unknown; modelId?: unknown })
        : undefined;
    const provider = nonEmptyString(model?.provider);
    const modelId = nonEmptyString(model?.modelId);
    tasks.push({
      id,
      name: (nonEmptyString(source.name) ?? id).slice(0, MAX_TASK_NAME_LENGTH),
      prompt:
        typeof source.prompt === "string" && source.prompt.trim()
          ? source.prompt.slice(0, MAX_TASK_PROMPT_LENGTH)
          : `Run task ${id}.`,
      dependsOn: [],
      ...(provider && modelId ? { model: { provider, modelId } } : {}),
    });
  }
  for (const task of tasks) {
    const source = (raw as Record<string, unknown>[]).find((entry) => entry && entry.id === task.id) ?? {};
    const deps = Array.isArray(source.dependsOn) ? source.dependsOn : [];
    for (const dep of deps) {
      if (typeof dep !== "string") continue;
      const name = dep.trim();
      if (!name || name === task.id || !ids.has(name) || task.dependsOn.includes(name)) continue;
      task.dependsOn.push(name);
    }
  }
  if (tasks.length) topoOrder(tasks); // a cyclic hand-edit fails the file, not the whole registry silently
  return tasks;
}

/**
 * One stored graph → a record we can trust. Missing `id`/timestamps are repaired
 * rather than fatal; a record with no `cwd` is unusable and fails the file,
 * which is then moved aside instead of silently forgotten.
 */
function coerceRecord(raw: unknown, now: string): GraphRecord {
  if (!raw || typeof raw !== "object") throw invalid("graph record is not an object");
  const source = raw as Record<string, unknown>;
  const cwd = nonEmptyString(source.cwd);
  if (!cwd) throw invalid("graph record has no cwd");
  return {
    id: nonEmptyString(source.id) ?? newGraphId(),
    name: (nonEmptyString(source.name) ?? "Graph").slice(0, MAX_GRAPH_NAME_LENGTH),
    cwd: normaliseGraphCwd(cwd),
    tasks: coerceTasks(source.tasks),
    createdAt: nonEmptyString(source.createdAt) ?? now,
    updatedAt: nonEmptyString(source.updatedAt) ?? now,
    archivedAt: nonEmptyString(source.archivedAt) ?? null,
  };
}

function coerceTaskState(raw: unknown): TaskRunState {
  const source = (raw && typeof raw === "object" ? raw : {}) as Record<string, unknown>;
  const state: TaskRunState = { status: isTaskRunStatus(source.status) ? source.status : "pending" };
  const sessionId = nonEmptyString(source.sessionId);
  if (sessionId) state.sessionId = sessionId;
  const error = nonEmptyString(source.error);
  if (error) state.error = error.slice(0, MAX_TASK_ERROR_LENGTH);
  const startedAt = nonEmptyString(source.startedAt);
  if (startedAt) state.startedAt = startedAt;
  const endedAt = nonEmptyString(source.endedAt);
  if (endedAt) state.endedAt = endedAt;
  return state;
}

/** Lenient run read: an unknown run status is coerced to "interrupted" (the safe terminal state). */
function coerceRun(raw: unknown, now: string): GraphRunRecord {
  if (!raw || typeof raw !== "object") throw invalid("run record is not an object");
  const source = raw as Record<string, unknown>;
  const graphId = nonEmptyString(source.graphId);
  if (!graphId) throw invalid("run record has no graphId");
  const startedAt = nonEmptyString(source.startedAt) ?? now;
  const tasksSource =
    source.tasks && typeof source.tasks === "object" && !Array.isArray(source.tasks)
      ? (source.tasks as Record<string, unknown>)
      : {};
  const tasks: Record<string, TaskRunState> = {};
  for (const [id, value] of Object.entries(tasksSource)) tasks[id] = coerceTaskState(value);
  return {
    id: nonEmptyString(source.id) ?? newRunId(Date.parse(startedAt) || Date.now()),
    graphId,
    startedAt,
    finishedAt: nonEmptyString(source.finishedAt) ?? null,
    status: isRunStatus(source.status) ? source.status : "interrupted",
    tasks,
  };
}

const listOf = (value: unknown, label: string): unknown[] => {
  if (value === undefined || value === null) return [];
  if (!Array.isArray(value)) throw invalid(`registry \`${label}\` is not a list`);
  return value;
};

/** Oldest-first ordering (startedAt, then id): the eviction order and the "newest first" inverse. */
const byStartedAsc = (left: GraphRunRecord, right: GraphRunRecord) =>
  left.startedAt.localeCompare(right.startedAt) || left.id.localeCompare(right.id);

/** Keep at most `MAX_RUNS_PER_GRAPH` runs per graph, dropping the oldest. */
function capRuns(runs: readonly GraphRunRecord[]): GraphRunRecord[] {
  const kept = [...runs];
  const perGraph = new Map<string, GraphRunRecord[]>();
  for (const run of kept) {
    const list = perGraph.get(run.graphId) ?? [];
    list.push(run);
    perGraph.set(run.graphId, list);
  }
  for (const list of perGraph.values()) {
    list.sort(byStartedAsc);
    while (list.length > MAX_RUNS_PER_GRAPH) {
      const oldest = list.shift()!;
      kept.splice(kept.indexOf(oldest), 1);
    }
  }
  return kept;
}

/**
 * Turn whatever is on disk into v1 graphs + runs. v0 is the same documents
 * without a `version` field (and, defensively, a bare graph array); an unknown
 * `version` is refused so a newer build's file is not read as garbage.
 */
export function migrate(raw: unknown, options: { now?: string } = {}): { graphs: GraphRecord[]; runs: GraphRunRecord[] } {
  const now = options.now ?? new Date().toISOString();
  if (raw === null || raw === undefined) return { graphs: [], runs: [] };
  if (Array.isArray(raw)) return { graphs: raw.map((entry) => coerceRecord(entry, now)), runs: [] };
  if (typeof raw !== "object") throw invalid("registry file is not a JSON object");
  const file = raw as Record<string, unknown>;
  const version = file.version;
  if (version !== undefined && version !== null && version !== 0 && version !== GRAPH_REGISTRY_VERSION) {
    throw invalid(`unsupported registry version ${String(version)}`);
  }
  const graphs = listOf(file.graphs, "graphs").map((entry) => coerceRecord(entry, now));
  const runs = capRuns(listOf(file.runs, "runs").map((entry) => coerceRun(entry, now)));
  return { graphs, runs };
}

type ReadResult =
  | { ok: true; graphs: GraphRecord[]; runs: GraphRunRecord[] }
  | { ok: false; missing: boolean; error: unknown };

/** Read + migrate one file, folding ENOENT (a fresh device) apart from "unusable". */
async function readRegistryFile(filePath: string, now: string): Promise<ReadResult> {
  let text: string;
  try {
    text = await readFile(filePath, "utf8");
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    return { ok: false, missing: code === "ENOENT", error };
  }
  try {
    return { ok: true, ...migrate(JSON.parse(text), { now }) };
  } catch (error) {
    return { ok: false, missing: false, error };
  }
}

// ------------------------------------------------------------------- registry

/**
 * The graph registry: one JSON file, loaded once at `open`, mutated through
 * in-memory state that is only committed after the file write lands.
 *
 * Writes are serialised (`run`) so two concurrent `beginRun` calls cannot
 * interleave: each stages a copy, persists it, then swaps it in.
 */
export class GraphRegistry {
  /** Absolute path of the main JSON file. */
  readonly filePath: string;
  /** The rolling backup restored by `open` when `filePath` is unusable. */
  readonly backupPath: string;

  private readonly warn: (message: string, error?: unknown) => void;
  private readonly now: () => string;
  private graphs = new Map<string, GraphRecord>();
  private runRecords: GraphRunRecord[] = [];
  /** False until a good file is read or written: while false we must not overwrite `.bak` with junk. */
  private mainIsGood = false;
  private queue: Promise<unknown> = Promise.resolve();

  private constructor(filePath: string, options: GraphRegistryOptions) {
    this.filePath = resolve(filePath);
    this.backupPath = `${this.filePath}.bak`;
    this.warn = options.warn ?? defaultWarn;
    this.now = options.now ?? (() => new Date().toISOString());
  }

  /**
   * Load the registry, or start from an empty one. A missing file is normal
   * (fresh device). An unreadable one is moved to `<file>.corrupt-<ts>` and the
   * `.bak` is tried before giving up, because the alternative — carrying on with
   * an empty registry over a file we could not parse — loses the user's graphs
   * on the next write.
   */
  static async open(filePath: string, options: GraphRegistryOptions = {}): Promise<GraphRegistry> {
    const registry = new GraphRegistry(filePath, options);
    await registry.load();
    return registry;
  }

  /** Active graphs by default — archived ones are out of the way until asked for. Sorted by name. */
  list(options: { includeArchived?: boolean } = {}): GraphRecord[] {
    const includeArchived = options.includeArchived === true;
    return [...this.graphs.values()]
      .filter((record) => includeArchived || record.archivedAt === null)
      .map(cloneGraph)
      .sort(
        (left, right) =>
          left.name.localeCompare(right.name, undefined, { sensitivity: "base" }) ||
          left.id.localeCompare(right.id),
      );
  }

  /** One record by id (archived included), or undefined when it does not exist. */
  get(id: string): GraphRecord | undefined {
    const record = this.graphs.get(id);
    return record ? cloneGraph(record) : undefined;
  }

  /** Store a new graph. Validation throws (`GraphError` `invalid`) rather than coercing. */
  async create(input: GraphInput): Promise<GraphRecord> {
    const name = normaliseName(input?.name);
    const cwd = normaliseGraphCwd(input?.cwd);
    const tasks = normaliseTasks(input?.tasks ?? []);
    return this.run(async () => {
      const staged = new Map(this.graphs);
      let id = newGraphId();
      while (staged.has(id)) id = newGraphId();
      const now = this.now();
      const created: GraphRecord = { id, name, cwd, tasks, createdAt: now, updatedAt: now, archivedAt: null };
      staged.set(created.id, created);
      await this.commit(staged, this.runRecords.map(cloneRun));
      return cloneGraph(created);
    });
  }

  /**
   * Patch what the user owns: name/cwd/tasks replace-whole when present
   * (present-keys semantics; absent keys untouched), with full re-validation.
   */
  async update(id: string, patch: GraphPatch): Promise<GraphRecord> {
    return this.run(async () => {
      const staged = new Map(this.graphs);
      const existing = staged.get(id);
      if (!existing) throw notFound(id);
      const next = cloneGraph(existing);
      if ("name" in patch) next.name = normaliseName(patch.name);
      if ("cwd" in patch) next.cwd = normaliseGraphCwd(patch.cwd as string);
      if ("tasks" in patch) next.tasks = normaliseTasks(patch.tasks ?? []);
      next.updatedAt = this.now();
      staged.set(next.id, next);
      await this.commit(staged, this.runRecords.map(cloneRun));
      return cloneGraph(next);
    });
  }

  /**
   * Soft delete. Archiving an already-archived graph keeps the original stamp —
   * the first archive is the fact, a second one is a double click.
   */
  async archive(id: string): Promise<GraphRecord> {
    return this.run(async () => {
      const staged = new Map(this.graphs);
      const existing = staged.get(id);
      if (!existing) throw notFound(id);
      if (existing.archivedAt) return cloneGraph(existing);
      const now = this.now();
      const next = { ...existing, archivedAt: now, updatedAt: now };
      staged.set(next.id, next);
      await this.commit(staged, this.runRecords.map(cloneRun));
      return cloneGraph(next);
    });
  }

  /** Undo `archive`. Tasks and the run history survived, which is the whole point of a soft delete. */
  async unarchive(id: string): Promise<GraphRecord> {
    return this.run(async () => {
      const staged = new Map(this.graphs);
      const existing = staged.get(id);
      if (!existing) throw notFound(id);
      if (existing.archivedAt === null) return cloneGraph(existing);
      const next = { ...existing, archivedAt: null, updatedAt: this.now() };
      staged.set(next.id, next);
      await this.commit(staged, this.runRecords.map(cloneRun));
      return cloneGraph(next);
    });
  }

  /** Hard delete (also drops the graph's run history — no orphan runs). False when already gone. */
  async remove(id: string): Promise<boolean> {
    return this.run(async () => {
      if (!this.graphs.has(id)) return false;
      const staged = new Map(this.graphs);
      staged.delete(id);
      const runs = this.runRecords.filter((run) => run.graphId !== id).map(cloneRun);
      await this.commit(staged, runs);
      return true;
    });
  }

  // ------------------------------------------------------------ run bookkeeping

  /**
   * Snapshot every task to pending and open a run: the honest starting state,
   * because nothing has executed yet. Evicts this graph's runs beyond
   * `MAX_RUNS_PER_GRAPH` (oldest first) so the file stays bounded.
   */
  async beginRun(graphId: string): Promise<GraphRunRecord> {
    return this.run(async () => {
      const stagedGraphs = new Map(this.graphs);
      const graph = stagedGraphs.get(graphId);
      if (!graph) throw notFound(graphId);
      const startedAt = this.now();
      const tasks: Record<string, TaskRunState> = {};
      for (const task of graph.tasks) tasks[task.id] = { status: "pending" };
      const stagedRuns = this.runRecords.map(cloneRun);
      let id = newRunId(Date.parse(startedAt));
      while (stagedRuns.some((run) => run.id === id)) id = newRunId(Date.parse(startedAt));
      const record: GraphRunRecord = {
        id,
        graphId,
        startedAt,
        finishedAt: null,
        status: "running",
        tasks,
      };
      stagedRuns.push(cloneRun(record));
      await this.commit(stagedGraphs, capRuns(stagedRuns));
      return record;
    });
  }

  /**
   * Record one task's progress. Terminal statuses stamp `endedAt`; a transition
   * to "running" stamps `startedAt`. After each mark the cascade runs (a failed
   * task skips its dependents) and, once no task is pending or running, the run
   * closes: "ok" only when every task reached ok, "failed" when any failed or
   * was skipped.
   */
  async markTask(graphId: string, runId: string, taskId: string, patch: TaskRunPatch): Promise<GraphRunRecord> {
    if (patch?.status !== undefined && !isTaskRunStatus(patch.status)) {
      throw invalid(`unknown task status ${String(patch.status)}`);
    }
    if (patch?.sessionId !== undefined && typeof patch.sessionId !== "string") {
      throw invalid("sessionId must be a string");
    }
    if (patch?.error !== undefined && typeof patch.error !== "string") {
      throw invalid("error must be a string");
    }
    return this.run(async () => {
      const stagedGraphs = new Map(this.graphs);
      const graph = stagedGraphs.get(graphId);
      if (!graph) throw notFound(graphId);
      const stagedRuns = this.runRecords.map(cloneRun);
      const run = stagedRuns.find((entry) => entry.id === runId && entry.graphId === graphId);
      if (!run) throw new GraphError("not_found", `no run ${runId}`);
      const state = run.tasks[taskId];
      if (!state) throw invalid(`graph ${graphId} has no task ${taskId}`);
      const now = this.now();
      if (patch.status !== undefined) {
        state.status = patch.status;
        if (patch.status === "running") {
          state.startedAt = now; // a re-run re-stamps: the fresh session is a new attempt
          delete state.endedAt;
        } else if (patch.status === "ok" || patch.status === "failed" || patch.status === "skipped") {
          state.endedAt = now;
        }
      }
      if (patch.sessionId !== undefined) {
        const sessionId = patch.sessionId.trim();
        if (sessionId) state.sessionId = sessionId;
        else delete state.sessionId;
      }
      if (patch.error !== undefined) {
        const error = patch.error.trim();
        if (error) state.error = error.slice(0, MAX_TASK_ERROR_LENGTH); // ≤300: the session holds the trace
        else delete state.error;
      }
      for (const skipped of cascadeSkips(graph.tasks, run.tasks)) {
        run.tasks[skipped].endedAt = now; // a skipped task is terminal the moment its fate is known
      }
      // Only a live run closes; an "interrupted" (recovered) run stays closed.
      if (run.status === "running" && runComplete(run.tasks)) {
        run.status = runOutcome(run.tasks);
        run.finishedAt = now;
      }
      await this.commit(stagedGraphs, stagedRuns);
      return cloneRun(run);
    });
  }

  /**
   * At boot: every run still marked "running" belongs to a process that died.
   * Its running tasks go back to pending (error cleared — the attempt never
   * finished, so it has no verdict), and the run closes as "interrupted". The
   * leader logs/notifications these; re-running is the human's call.
   */
  async recoverInterrupted(): Promise<GraphRunRecord[]> {
    return this.run(async () => {
      const stagedRuns = this.runRecords.map(cloneRun);
      const touched: GraphRunRecord[] = [];
      for (const run of stagedRuns) {
        if (run.status !== "running") continue;
        for (const state of Object.values(run.tasks)) {
          if (state.status === "running") {
            state.status = "pending";
            delete state.error;
            delete state.startedAt; // re-stamped when the task runs again
          }
        }
        run.status = "interrupted";
        run.finishedAt = this.now();
        touched.push(run);
      }
      if (touched.length) await this.commit(new Map(this.graphs), stagedRuns);
      return touched.map(cloneRun);
    });
  }

  /** A graph's runs, newest first (the order a history list renders). */
  runs(graphId: string): GraphRunRecord[] {
    return this.runRecords
      .filter((run) => run.graphId === graphId)
      .sort((left, right) => byStartedAsc(right, left))
      .map(cloneRun);
  }

  /** The newest run of a graph, or undefined when it never ran. */
  lastRun(graphId: string): GraphRunRecord | undefined {
    return this.runs(graphId)[0];
  }

  // ------------------------------------------------------------------ plumbing

  private async load(): Promise<void> {
    // Same guard as `Store.open`/`ScheduleRegistry.open`: the data dir holds
    // credentials-adjacent state, so it is created 0700 or tightened first.
    ensurePrivateDir(dirname(this.filePath));
    const now = this.now();

    const main = await readRegistryFile(this.filePath, now);
    if (main.ok) {
      this.adopt(main.graphs, main.runs);
      this.mainIsGood = true;
      return;
    }
    if (main.missing) return; // fresh device: nothing to load, nothing to complain about

    this.warn(`${this.filePath} is unusable (${describeError(main.error)}); moving it aside`);
    await this.setAside();

    const backup = await readRegistryFile(this.backupPath, now);
    if (backup.ok) {
      this.adopt(backup.graphs, backup.runs);
      this.warn(`recovered ${backup.graphs.length} graph(s) from ${this.backupPath}`);
      return;
    }
    if (!backup.missing) this.warn(`${this.backupPath} is unusable too; starting with an empty registry`);
  }

  /** Rename an unreadable file out of the way instead of deleting it: it is the only copy of that data. */
  private async setAside(): Promise<void> {
    const aside = `${this.filePath}.corrupt-${Date.now()}`;
    try {
      await rename(this.filePath, aside);
      this.warn(`kept the unreadable registry as ${aside}`);
    } catch (error) {
      this.warn(`could not move ${this.filePath} aside; nothing was written over it`, error);
    }
  }

  private adopt(graphs: readonly GraphRecord[], runs: readonly GraphRunRecord[]): void {
    this.graphs.clear();
    for (const record of graphs) this.graphs.set(record.id, record);
    this.runRecords = runs.map(cloneRun);
  }

  /** Stage → persist → swap. A failed write leaves memory exactly as it was. */
  private async commit(staged: Map<string, GraphRecord>, runs: readonly GraphRunRecord[]): Promise<void> {
    await this.persist([...staged.values()], runs);
    this.graphs = staged;
    this.runRecords = runs.map(cloneRun);
  }

  private run<T>(task: () => Promise<T>): Promise<T> {
    const started = this.queue.then(task, task);
    // Swallow the rejection on the chain only; the caller still sees it.
    this.queue = started.then(
      () => undefined,
      () => undefined,
    );
    return started;
  }

  /**
   * temp (0600) → rename → chmod, with the previous good file copied to `.bak`
   * first. Rename is atomic within a directory, so a reader sees either the old
   * bytes or the complete new ones — never a torn registry.
   */
  private async persist(graphs: readonly GraphRecord[], runs: readonly GraphRunRecord[]): Promise<void> {
    const dir = dirname(this.filePath);
    ensurePrivateDir(dir); // re-tightened on every write, like the pairing files
    if (this.mainIsGood) await this.backUpMain();

    const payload = `${JSON.stringify(
      { version: GRAPH_REGISTRY_VERSION, graphs: [...graphs], runs: [...runs] } satisfies GraphRegistryFile,
      null,
      2,
    )}\n`;
    const temp = `${this.filePath}.tmp-${process.pid}-${randomBytes(4).toString("hex")}`;
    try {
      await writeFile(temp, payload, { encoding: "utf8", mode: 0o600 });
      await chmod(temp, 0o600); // umask can only make this stricter, but be explicit
      await rename(temp, this.filePath);
      await chmod(this.filePath, 0o600);
      this.mainIsGood = true;
    } catch (error) {
      await unlink(temp).catch(() => undefined);
      throw error;
    }
  }

  /** Best effort: a failed backup must not fail the mutation that good file still protects. */
  private async backUpMain(): Promise<void> {
    try {
      await copyFile(this.filePath, this.backupPath);
      await chmod(this.backupPath, 0o600);
    } catch (error) {
      this.warn(`could not refresh ${this.backupPath}`, error);
    }
  }
}
