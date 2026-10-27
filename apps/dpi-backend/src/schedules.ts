/**
 * Device-side schedule registry — "Scheduled sessions (device-side)", Wave 2 of
 * docs/host-project-checklist.md.
 *
 * A schedule is a stored intent: "every N minutes" or "daily at HH:MM", plus the
 * cwd, model and prompt a *new* session should start with. The device owns
 * execution — nothing here starts a session; the device loop asks `due()` and
 * reports back with `markRun()`: once BEFORE the dispatch (the `started` intent
 * marker, so a crash mid-run cannot silently re-fire after a restart) and once
 * when the session turn settles, with the real outcome. The hub only displays
 * what this file says.
 *
 * Modelled on orca's `automations/service.ts:186-211` (scheduled trigger +
 * precheck + completion watcher): a stored `nextRunAt`-style slot per record, an
 * enabled bit, and the outcome of the last run written back once the run is
 * done. Two deliberate adaptations: the "next slot" is *computed* from
 * `lastRunAt ?? createdAt` instead of being persisted (a device that was off for
 * a week must not fire seven times on boot — see `computeNextRun`), and the
 * scheduling precheck stays with the caller, because a device that cannot reach
 * its model should say so on the run it records, not by silently editing the
 * registry.
 *
 * The file handling is lifted from `projects.ts` on purpose — same atomic
 * temp+rename, same `.bak` rolling backup, same "unreadable file is moved aside,
 * never overwritten" rule, same 0600/0700 perms, same serialised mutation queue
 * and the same typed errors. A registry must never lose records silently.
 *
 * Everything here is Node builtins only: `node:fs/promises`, `node:crypto`,
 * `node:path`. No shell, no zod, no SDK imports beyond the shared private-dir guard.
 */
import { randomBytes } from "node:crypto";
import { chmod, copyFile, readFile, rename, unlink, writeFile } from "node:fs/promises";
import { dirname, isAbsolute, resolve } from "node:path";
import { ensurePrivateDir } from "../../dpi-sdk/src/node/private-dir.js";

/** Bumped only when the on-disk shape changes; `migrate` owns the upgrade path. */
export const SCHEDULE_REGISTRY_VERSION = 1;

/** A label a human reads in a list — not a description. */
export const MAX_SCHEDULE_NAME_LENGTH = 80;
/** A prompt is a message, not a document; past this the agent gets a wall of text instead of a task. */
export const MAX_PROMPT_LENGTH = 8000;
/** Five minutes is the shortest interval a session turn reliably fits inside. */
export const MIN_EVERY_MINUTES = 5;
/** A day: longer than this and `dailyAt` is the better trigger anyway. */
export const MAX_EVERY_MINUTES = 1440;

/** `HH:MM`, 24-hour, local time. Strict two digits so the file has one spelling per time. */
const DAILY_AT_PATTERN = /^([01]\d|2[0-3]):([0-5]\d)$/;
const MINUTE_MS = 60_000;

/**
 * Outcome of the last run. Terminal states: `ok` (the session turn finished)
 * and `failed` (the dispatch or the turn errored). The intermediate states keep
 * a run that has not landed *visible* instead of silent: `started` is the
 * pre-dispatch intent marker (R8 2.4 — written before the session is created),
 * `timeout` means the run outlived its budget and may still complete later,
 * and `interrupted` is what a restart turns a pending `started` into
 * (`recoverInterrupted`). Registries written before R8 only ever contain
 * `ok`/`failed`; both still parse and render unchanged.
 */
export type ScheduleRunOutcome = "ok" | "failed" | "started" | "timeout" | "interrupted";

/** The model a scheduled session starts on. Same shape the session API takes. */
export interface ScheduleModel {
  provider: string;
  modelId: string;
}

/**
 * One schedule. `everyMinutes` / `dailyAt` are the trigger and exactly one of
 * them is present; `lastRunAt` is the only thing the device writes back, and it
 * is what makes "next run" mean "next run after the last one" rather than "every
 * N minutes since the epoch".
 */
export interface ScheduleRecord {
  /** `sch_<12 hex>`; stable across renames of the schedule. */
  id: string;
  /** Human label, ≤ 80 characters. */
  name: string;
  /** Absolute directory the new session starts in. Not probed: the device may be offline from that mount. */
  cwd: string;
  model: ScheduleModel;
  /** The message sent to the new session's root agent. */
  prompt: string;
  /** Interval trigger in minutes (5–1440); mutually exclusive with `dailyAt`. */
  everyMinutes?: number;
  /** `"HH:MM"` 24-hour local time trigger; mutually exclusive with `everyMinutes`. */
  dailyAt?: string;
  /** Disabled records are never due and `nextRunAt` answers `undefined`. */
  enabled: boolean;
  /** Epoch ms the next interval counts from: stamped by the pre-dispatch intent
   *  marker (run start) and re-stamped when the outcome lands. */
  lastRunAt?: number;
  /** Session the last run created, so the UI can link to it. */
  lastSessionId?: string;
  /** Outcome of the last run; absent means "never run". */
  lastOutcome?: ScheduleRunOutcome;
  /** Why the last run failed. Cleared by the next successful run. */
  lastError?: string;
  createdAt: number;
  updatedAt: number;
}

/** What `create` accepts. `enabled` is optional there and defaults to `true`. */
export interface ScheduleInput {
  name: string;
  cwd: string;
  model: ScheduleModel;
  prompt: string;
  everyMinutes?: number;
  dailyAt?: string;
}

/** `create` also takes the initial `enabled` bit, so a schedule can be staged switched-off. */
export type ScheduleCreateInput = ScheduleInput & { enabled?: boolean };

/** What `update` accepts: everything a user owns, plus the switch. */
export type SchedulePatch = Partial<ScheduleInput> & { enabled?: boolean };

/** The fields `computeNextRun` reads. Narrowed so callers can pass a bare object in tests. */
export type ScheduleTiming = Pick<
  ScheduleRecord,
  "enabled" | "createdAt" | "lastRunAt" | "everyMinutes" | "dailyAt"
>;

/** The on-disk document. `version` exists so a future shape can be migrated instead of discarded. */
export interface ScheduleRegistryFile {
  version: number;
  schedules: ScheduleRecord[];
}

export type ScheduleRegistryErrorCode = "invalid" | "not_found";

/** Typed failure so routes can answer 400 (`invalid`) or 404 (`not_found`) without string matching. */
export class ScheduleRegistryError extends Error {
  readonly code: ScheduleRegistryErrorCode;

  constructor(code: ScheduleRegistryErrorCode, message: string) {
    super(message);
    this.name = "ScheduleRegistryError";
    this.code = code;
  }
}

export interface ScheduleRegistryOptions {
  /** Where unreadable-file / recovery notices go. Defaults to `console.warn`. */
  warn?: (message: string, error?: unknown) => void;
  /** Injectable clock (epoch ms) — tests pin timestamps instead of sleeping. */
  now?: () => number;
}

const invalid = (message: string) => new ScheduleRegistryError("invalid", message);
const notFound = (id: string) => new ScheduleRegistryError("not_found", `no schedule ${id}`);
const describeError = (error: unknown) => (error instanceof Error ? error.message : String(error));
const defaultWarn = (message: string, error?: unknown) =>
  console.warn(`[schedules] ${message}`, error === undefined ? "" : describeError(error));

const clone = (record: ScheduleRecord): ScheduleRecord => ({ ...record, model: { ...record.model } });
const nonEmptyString = (value: unknown): string | undefined =>
  typeof value === "string" && value.trim() ? value.trim() : undefined;

/** `sch_` + 12 hex: short enough to type, wide enough that collisions are not a real risk. */
export function newScheduleId(): string {
  return `sch_${randomBytes(6).toString("hex")}`;
}

/**
 * Absolute-ise and strip the trailing separator so `/a/b/` and `/a/b` are the
 * same directory. Deliberately does **not** stat the path: the device may be
 * offline from that mount right now, and a schedule that refuses to save because
 * a network share is down would be useless on the morning it is needed.
 */
/**
 * Keep the path the human typed: the device resolves a relative cwd against its
 * first start dir when the run creates the session (`Store.create`), so
 * resolving it here — against the daemon's own cwd — would point at a folder
 * that does not exist on the device.
 */
export function normaliseCwd(cwd: string): string {
  const trimmed = typeof cwd === "string" ? cwd.trim() : "";
  if (!trimmed) throw invalid("cwd is required");
  if (trimmed === "~" || trimmed.startsWith("~/")) return trimmed; // home is expanded by the device
  return isAbsolute(trimmed) ? resolve(trimmed) : trimmed.replace(/[\\/]+$/, "");
}

/** `hour`/`minute` → the stored `"HH:MM"` spelling; also what error messages quote back. */
export function formatDailyAt(hour: number, minute: number): string {
  if (!Number.isInteger(hour) || hour < 0 || hour > 23) throw invalid(`hour must be 0–23, got ${String(hour)}`);
  if (!Number.isInteger(minute) || minute < 0 || minute > 59) {
    throw invalid(`minute must be 0–59, got ${String(minute)}`);
  }
  return `${String(hour).padStart(2, "0")}:${String(minute).padStart(2, "0")}`;
}

function normaliseName(value: unknown): string {
  const name = nonEmptyString(value);
  if (!name) throw invalid("name is required");
  if (name.length > MAX_SCHEDULE_NAME_LENGTH) {
    throw invalid(`name is ${name.length} characters; the limit is ${MAX_SCHEDULE_NAME_LENGTH}`);
  }
  return name;
}

function normalisePrompt(value: unknown): string {
  if (typeof value !== "string" || !value.trim()) throw invalid("prompt is required");
  if (value.length > MAX_PROMPT_LENGTH) {
    throw invalid(`prompt is ${value.length} characters; the limit is ${MAX_PROMPT_LENGTH}`);
  }
  // Kept verbatim: the prompt is the user's words, and re-indenting it would change it.
  return value;
}

function normaliseModel(value: unknown): ScheduleModel {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw invalid("model must be { provider, modelId }");
  }
  const source = value as Record<string, unknown>;
  const provider = nonEmptyString(source.provider);
  const modelId = nonEmptyString(source.modelId);
  if (!provider) throw invalid("model.provider is required");
  if (!modelId) throw invalid("model.modelId is required");
  return { provider, modelId };
}

function normaliseEveryMinutes(value: unknown): number {
  if (typeof value !== "number" || !Number.isInteger(value)) {
    throw invalid("everyMinutes must be a whole number of minutes");
  }
  if (value < MIN_EVERY_MINUTES || value > MAX_EVERY_MINUTES) {
    throw invalid(
      `everyMinutes must be between ${MIN_EVERY_MINUTES} and ${MAX_EVERY_MINUTES}, got ${value}`,
    );
  }
  return value;
}

function normaliseDailyAt(value: unknown): string {
  const dailyAt = typeof value === "string" ? value.trim() : "";
  if (!DAILY_AT_PATTERN.test(dailyAt)) {
    throw invalid(`dailyAt must be "HH:MM" in 24-hour local time (00:00–23:59), got "${String(value)}"`);
  }
  return dailyAt;
}

/**
 * Exactly one trigger, never both, never neither. A blank/absent `dailyAt` counts
 * as "not set" so a UI can clear the field by sending `""`.
 */
export function normaliseTrigger(input: { everyMinutes?: unknown; dailyAt?: unknown }): {
  everyMinutes?: number;
  dailyAt?: string;
} {
  const dailyRaw = typeof input.dailyAt === "string" ? input.dailyAt.trim() : input.dailyAt;
  const hasEvery = input.everyMinutes !== undefined && input.everyMinutes !== null;
  const hasDaily = dailyRaw !== undefined && dailyRaw !== null && dailyRaw !== "";
  if (hasEvery && hasDaily) {
    throw invalid("everyMinutes and dailyAt are mutually exclusive; set exactly one trigger");
  }
  if (!hasEvery && !hasDaily) {
    throw invalid("a schedule needs one trigger: everyMinutes or dailyAt");
  }
  if (hasEvery) return { everyMinutes: normaliseEveryMinutes(input.everyMinutes) };
  return { dailyAt: normaliseDailyAt(dailyRaw) };
}

function parseDailyAt(dailyAt: string): { hour: number; minute: number } {
  const match = DAILY_AT_PATTERN.exec(dailyAt);
  if (!match) throw invalid(`dailyAt must be "HH:MM", got "${dailyAt}"`);
  return { hour: Number(match[1]), minute: Number(match[2]) };
}

/**
 * The next local `HH:MM` strictly after `from`, on the host's own clock — no
 * timezone library, because "daily at 09:00" means 09:00 where the device is.
 * `setDate(+1)` handles month ends, DST shifts and the midnight wrap for free.
 */
function nextDailyOccurrence(dailyAt: string, from: number): number {
  const { hour, minute } = parseDailyAt(dailyAt);
  const anchor = new Date(from);
  const candidate = new Date(anchor.getFullYear(), anchor.getMonth(), anchor.getDate(), hour, minute, 0, 0);
  if (candidate.getTime() <= from) candidate.setDate(candidate.getDate() + 1);
  return candidate.getTime();
}

/**
 * When this record should run next, or `undefined` when it never will (disabled,
 * or a hand-edited record with no usable trigger).
 *
 * Interval triggers count from `lastRunAt ?? createdAt`, then roll forward by
 * whole intervals until the answer is strictly after `from`. That roll-forward is
 * the anti-stampede rule: a device that was off for a week reports one due run
 * (see `due`), and once `markRun` stamps `lastRunAt` the following slot is in the
 * future — it does not replay seven missed runs.
 */
export function computeNextRun(record: ScheduleTiming, from: number = Date.now()): number | undefined {
  if (!record.enabled) return undefined;
  if (typeof record.everyMinutes === "number") {
    const interval = record.everyMinutes * MINUTE_MS;
    const base = record.lastRunAt ?? record.createdAt;
    const elapsed = from - base;
    const steps = elapsed < 0 ? 1 : Math.floor(elapsed / interval) + 1;
    return base + steps * interval;
  }
  if (typeof record.dailyAt === "string") return nextDailyOccurrence(record.dailyAt, from);
  return undefined;
}

const RUN_OUTCOMES: readonly ScheduleRunOutcome[] = ["ok", "failed", "started", "timeout", "interrupted"];
const isOutcome = (value: unknown): value is ScheduleRunOutcome =>
  typeof value === "string" && (RUN_OUTCOMES as readonly string[]).includes(value);
const finiteNumber = (value: unknown): number | undefined =>
  typeof value === "number" && Number.isFinite(value) ? value : undefined;

/** Lenient model read for the load path: a hand-edited file must not wipe the registry. */
function coerceModel(raw: unknown): ScheduleModel {
  const source = (raw && typeof raw === "object" && !Array.isArray(raw) ? raw : {}) as Record<string, unknown>;
  return { provider: nonEmptyString(source.provider) ?? "", modelId: nonEmptyString(source.modelId) ?? "" };
}

/**
 * Lenient trigger read for the load path: keep the first trigger that is still
 * valid, drop what today's rules reject, and let a record with none stay inert
 * (`computeNextRun` answers `undefined`) rather than discarding the whole file.
 */
function coerceTrigger(source: Record<string, unknown>): { everyMinutes?: number; dailyAt?: string } {
  const every = source.everyMinutes;
  if (typeof every === "number" && Number.isInteger(every) && every >= MIN_EVERY_MINUTES && every <= MAX_EVERY_MINUTES) {
    return { everyMinutes: every };
  }
  const daily = typeof source.dailyAt === "string" ? source.dailyAt.trim() : "";
  if (DAILY_AT_PATTERN.test(daily)) return { dailyAt: daily };
  return {};
}

/**
 * One stored record → a record we can trust. Missing `id`/`name`/timestamps are
 * repaired rather than fatal (a hand-edited file should not wipe the registry);
 * a record with no `cwd` is unusable and fails the file, which is then moved
 * aside instead of silently forgotten.
 */
function coerceRecord(raw: unknown, now: number): ScheduleRecord {
  if (!raw || typeof raw !== "object") throw invalid("schedule record is not an object");
  const source = raw as Record<string, unknown>;
  const cwd = nonEmptyString(source.cwd);
  if (!cwd) throw invalid("schedule record has no cwd");
  const record: ScheduleRecord = {
    id: nonEmptyString(source.id) ?? newScheduleId(),
    name: (nonEmptyString(source.name) ?? "Schedule").slice(0, MAX_SCHEDULE_NAME_LENGTH),
    cwd: normaliseCwd(cwd),
    model: coerceModel(source.model),
    prompt: typeof source.prompt === "string" ? source.prompt.slice(0, MAX_PROMPT_LENGTH) : "",
    enabled: source.enabled !== false,
    createdAt: finiteNumber(source.createdAt) ?? now,
    updatedAt: finiteNumber(source.updatedAt) ?? now,
  };
  const trigger = coerceTrigger(source);
  if (trigger.everyMinutes !== undefined) record.everyMinutes = trigger.everyMinutes;
  if (trigger.dailyAt !== undefined) record.dailyAt = trigger.dailyAt;
  const lastRunAt = finiteNumber(source.lastRunAt);
  if (lastRunAt !== undefined) record.lastRunAt = lastRunAt;
  const lastSessionId = nonEmptyString(source.lastSessionId);
  if (lastSessionId) record.lastSessionId = lastSessionId;
  if (isOutcome(source.lastOutcome)) record.lastOutcome = source.lastOutcome;
  const lastError = nonEmptyString(source.lastError);
  if (lastError) record.lastError = lastError;
  return record;
}

/**
 * Turn whatever is on disk into v1 records. v0 is the same document without a
 * `version` field (and, defensively, a bare record array); an unknown `version`
 * is refused so a newer build's file is not read as garbage.
 */
export function migrate(raw: unknown, options: { now?: number } = {}): ScheduleRecord[] {
  const now = options.now ?? Date.now();
  if (raw === null || raw === undefined) return [];
  if (Array.isArray(raw)) return raw.map((entry) => coerceRecord(entry, now));
  if (typeof raw !== "object") throw invalid("registry file is not a JSON object");
  const file = raw as Record<string, unknown>;
  const version = file.version;
  if (version !== undefined && version !== null && version !== 0 && version !== SCHEDULE_REGISTRY_VERSION) {
    throw invalid(`unsupported registry version ${String(version)}`);
  }
  const schedules = file.schedules;
  if (schedules === undefined || schedules === null) return [];
  if (!Array.isArray(schedules)) throw invalid("registry `schedules` is not a list");
  return schedules.map((entry) => coerceRecord(entry, now));
}

type ReadResult = { ok: true; records: ScheduleRecord[] } | { ok: false; missing: boolean; error: unknown };

/** Read + migrate one file, folding ENOENT (a fresh device) apart from "unusable". */
async function readRegistryFile(filePath: string, now: number): Promise<ReadResult> {
  let text: string;
  try {
    text = await readFile(filePath, "utf8");
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    return { ok: false, missing: code === "ENOENT", error };
  }
  try {
    return { ok: true, records: migrate(JSON.parse(text), { now }) };
  } catch (error) {
    return { ok: false, missing: false, error };
  }
}

/**
 * The schedule registry: one JSON file, loaded once at `open`, mutated through an
 * in-memory map that is only committed after the file write lands.
 *
 * Writes are serialised (`run`) so two concurrent `create` calls cannot
 * interleave: each stages a copy of the map, persists it, then swaps it in.
 */
export class ScheduleRegistry {
  /** Absolute path of the main JSON file. */
  readonly filePath: string;
  /** The rolling backup restored by `open` when `filePath` is unusable. */
  readonly backupPath: string;

  private readonly warn: (message: string, error?: unknown) => void;
  private readonly now: () => number;
  private records = new Map<string, ScheduleRecord>();
  /** False until a good file is read or written: while false we must not overwrite `.bak` with junk. */
  private mainIsGood = false;
  private queue: Promise<unknown> = Promise.resolve();

  private constructor(filePath: string, options: ScheduleRegistryOptions) {
    this.filePath = resolve(filePath);
    this.backupPath = `${this.filePath}.bak`;
    this.warn = options.warn ?? defaultWarn;
    this.now = options.now ?? (() => Date.now());
  }

  /**
   * Load the registry, or start from an empty one. A missing file is normal
   * (fresh device). An unreadable one is moved to `<file>.corrupt-<ts>` and the
   * `.bak` is tried before giving up, because the alternative — carrying on with
   * an empty map over a file we could not parse — loses the user's schedules on
   * the next write.
   */
  static async open(filePath: string, options: ScheduleRegistryOptions = {}): Promise<ScheduleRegistry> {
    const registry = new ScheduleRegistry(filePath, options);
    await registry.load();
    return registry;
  }

  /** Every schedule, sorted by the name a human reads (ties broken by id, so the order is stable). */
  list(): ScheduleRecord[] {
    return [...this.records.values()]
      .map(clone)
      .sort(
        (left, right) =>
          left.name.localeCompare(right.name, undefined, { sensitivity: "base" }) ||
          left.id.localeCompare(right.id),
      );
  }

  /** One record by id, or undefined when it does not exist. */
  get(id: string): ScheduleRecord | undefined {
    const record = this.records.get(id);
    return record ? clone(record) : undefined;
  }

  /**
   * Store a new schedule. Validation throws (`ScheduleRegistryError` `invalid`)
   * rather than coercing, so a UI can show the reason the user typed.
   */
  async create(input: ScheduleCreateInput): Promise<ScheduleRecord> {
    const name = normaliseName(input?.name);
    const cwd = normaliseCwd(input?.cwd);
    const model = normaliseModel(input?.model);
    const prompt = normalisePrompt(input?.prompt);
    const trigger = normaliseTrigger({ everyMinutes: input?.everyMinutes, dailyAt: input?.dailyAt });
    if (input?.enabled !== undefined && typeof input.enabled !== "boolean") {
      throw invalid("enabled must be a boolean");
    }
    const enabled = input?.enabled ?? true;
    return this.run(async () => {
      const staged = new Map(this.records);
      let id = newScheduleId();
      while (staged.has(id)) id = newScheduleId();
      const now = this.now();
      const created: ScheduleRecord = { id, name, cwd, model, prompt, enabled, createdAt: now, updatedAt: now };
      if (trigger.everyMinutes !== undefined) created.everyMinutes = trigger.everyMinutes;
      if (trigger.dailyAt !== undefined) created.dailyAt = trigger.dailyAt;
      staged.set(created.id, created);
      await this.commit(staged);
      return clone(created);
    });
  }

  /**
   * Patch what the user owns. A trigger switch must say what it is replacing:
   * `update(id, { everyMinutes: 30 })` on a daily record is rejected as "both
   * set", and `{ everyMinutes: 30, dailyAt: undefined }` is the switch. Run state
   * (`lastRunAt`, `lastOutcome`, …) is not patchable — that is `markRun`'s job.
   */
  async update(id: string, patch: SchedulePatch): Promise<ScheduleRecord> {
    if (patch?.enabled !== undefined && typeof patch.enabled !== "boolean") {
      throw invalid("enabled must be a boolean");
    }
    return this.run(async () => {
      const staged = new Map(this.records);
      const existing = staged.get(id);
      if (!existing) throw notFound(id);
      const next = clone(existing);
      if ("name" in patch) next.name = normaliseName(patch.name);
      if ("cwd" in patch) next.cwd = normaliseCwd(patch.cwd as string);
      if ("model" in patch) next.model = normaliseModel(patch.model);
      if ("prompt" in patch) next.prompt = normalisePrompt(patch.prompt);
      if ("enabled" in patch) next.enabled = patch.enabled as boolean;
      if ("everyMinutes" in patch || "dailyAt" in patch) {
        const trigger = normaliseTrigger({
          everyMinutes: "everyMinutes" in patch ? patch.everyMinutes : existing.everyMinutes,
          dailyAt: "dailyAt" in patch ? patch.dailyAt : existing.dailyAt,
        });
        delete next.everyMinutes;
        delete next.dailyAt;
        if (trigger.everyMinutes !== undefined) next.everyMinutes = trigger.everyMinutes;
        if (trigger.dailyAt !== undefined) next.dailyAt = trigger.dailyAt;
      }
      next.updatedAt = this.now();
      staged.set(next.id, next);
      await this.commit(staged);
      return clone(next);
    });
  }

  /** Hard delete. False when the schedule was already gone. */
  async remove(id: string): Promise<boolean> {
    return this.run(async () => {
      if (!this.records.has(id)) return false;
      const staged = new Map(this.records);
      staged.delete(id);
      await this.commit(staged);
      return true;
    });
  }

  /** Next due time (epoch ms) or `undefined` when disabled. See `computeNextRun` for the roll-forward. */
  nextRunAt(record: ScheduleTiming, from?: number): number | undefined {
    return computeNextRun(record, from ?? this.now());
  }

  /**
   * Records whose next run is at or before `at` — what the device loop asks for.
   *
   * The slot is measured from the record's own base (`lastRunAt ?? createdAt`),
   * not from `at`: a device that was off for a week sees the missed slot once,
   * runs it, and `markRun` pushes the next slot into the future. Using
   * `nextRunAt(at)` here instead would roll the slot past `at` and the schedule
   * would never fire at all.
   */
  due(at?: number): ScheduleRecord[] {
    const now = at ?? this.now();
    return this.list().filter((record) => {
      if (!record.enabled) return false;
      const base = record.lastRunAt ?? record.createdAt;
      const next = computeNextRun(record, base);
      return next !== undefined && next <= now;
    });
  }

  /**
   * Record one run. Two call shapes:
   *
   * - BEFORE the dispatch, the intent marker `{ outcome: "started" }`: it stamps
   *   `lastRunAt` immediately, so a crash in the create→outcome window cannot
   *   re-fire the same minute after a restart (the next slot is a full interval
   *   out) and the restart surfaces the gap via `recoverInterrupted` (R8 2.4).
   * - when the run lands, `{ sessionId, outcome }` with the terminal state.
   *
   * `lastRunAt` is the base the next interval counts from, so this is also what
   * makes an offline catch-up land once instead of in a burst. A non-`ok`
   * outcome records `error`; `ok` (and a fresh intent) clears the previous
   * failure reason.
   */
  async markRun(
    id: string,
    result: { sessionId?: string; outcome: ScheduleRunOutcome; error?: string; at?: number },
  ): Promise<ScheduleRecord> {
    if (!isOutcome(result?.outcome)) throw invalid(`unknown run outcome ${String(result?.outcome)}`);
    const at = result.at ?? this.now();
    if (!Number.isFinite(at)) throw invalid("at must be an epoch-millisecond timestamp");
    return this.run(async () => {
      const staged = new Map(this.records);
      const existing = staged.get(id);
      if (!existing) throw notFound(id);
      const next = clone(existing);
      next.lastRunAt = at;
      next.lastOutcome = result.outcome;
      next.updatedAt = this.now();
      const sessionId = nonEmptyString(result.sessionId);
      if (sessionId) next.lastSessionId = sessionId;
      else delete next.lastSessionId;
      const error = nonEmptyString(result.error);
      if (result.outcome !== "ok" && error) next.lastError = error;
      else delete next.lastError; // a success (or a fresh intent) clears the reason the last one failed
      staged.set(next.id, next);
      await this.commit(staged);
      return clone(next);
    });
  }

  /**
   * Boot-time recovery (R8 2.4): a run still marked `started` never recorded its
   * outcome — the daemon died between the intent marker and the write-back. Flip
   * it to `interrupted` so the gap is VISIBLE (the hub shows why the last run has
   * no outcome) instead of silently re-firing: `lastRunAt` was already stamped
   * by the intent marker, so `due()` holds the schedule until its next full
   * slot. Deliberately at-most-once with a visible gap.
   */
  async recoverInterrupted(): Promise<ScheduleRecord[]> {
    return this.run(async () => {
      const staged = new Map(this.records);
      const touched: ScheduleRecord[] = [];
      const at = this.now();
      for (const record of staged.values()) {
        if (record.lastOutcome !== "started") continue;
        const next = clone(record);
        next.lastOutcome = "interrupted";
        next.lastError =
          nonEmptyString(next.lastError) ?? "run was interrupted by a device restart before it recorded an outcome";
        next.updatedAt = at;
        staged.set(next.id, next);
        touched.push(next);
      }
      if (touched.length) await this.commit(staged);
      return touched.map(clone);
    });
  }

  private async load(): Promise<void> {
    // Same guard as `Store.open`/`ProjectRegistry.open`: the data dir holds
    // credentials-adjacent state, so it is created 0700 or tightened first.
    ensurePrivateDir(dirname(this.filePath));
    const now = this.now();

    const main = await readRegistryFile(this.filePath, now);
    if (main.ok) {
      this.adopt(main.records);
      this.mainIsGood = true;
      return;
    }
    if (main.missing) return; // fresh device: nothing to load, nothing to complain about

    this.warn(`${this.filePath} is unusable (${describeError(main.error)}); moving it aside`);
    await this.setAside();

    const backup = await readRegistryFile(this.backupPath, now);
    if (backup.ok) {
      this.adopt(backup.records);
      this.warn(`recovered ${backup.records.length} schedule(s) from ${this.backupPath}`);
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

  private adopt(records: readonly ScheduleRecord[]): void {
    this.records.clear();
    for (const record of records) this.records.set(record.id, record);
  }

  /** Stage → persist → swap. A failed write leaves memory exactly as it was. */
  private async commit(staged: Map<string, ScheduleRecord>): Promise<void> {
    await this.persist([...staged.values()]);
    this.records = staged;
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
  private async persist(records: readonly ScheduleRecord[]): Promise<void> {
    const dir = dirname(this.filePath);
    ensurePrivateDir(dir); // re-tightened on every write, like the pairing files
    if (this.mainIsGood) await this.backUpMain();

    const payload = `${JSON.stringify(
      { version: SCHEDULE_REGISTRY_VERSION, schedules: [...records] } satisfies ScheduleRegistryFile,
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
