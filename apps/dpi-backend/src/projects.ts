/**
 * Device-side project registry — "Project entity + labels + archive", Wave 2 of
 * docs/host-project-checklist.md.
 *
 * Sessions already carry a cwd; this registry gives that cwd an identity: a
 * stable id, a display name, labels to filter by and an archive bit. The point is
 * to promote the TUI's group-by-cwd (`views.ts`) into an entity instead of
 * re-deriving project groups from path strings on every render.
 *
 * Modelled on paseo's `packages/server/src/server/workspace-registry.ts` — the
 * record shape, the "customName wins, reconciliation never touches it" rule, the
 * atomic write and the serialised mutation queue. Two deliberate differences: zod
 * is replaced by hand-written validation (the device ships no zod), and the file
 * is a versioned `{ version, projects }` document whose `migrate()` also reads
 * the legacy `{ projects: { [rootPath]: { name, labels } } }` map. A registry
 * must never lose records silently, so an unreadable file is moved aside rather
 * than overwritten and a `.bak` of the last good file rides along — the same
 * rolling-backup idea orca's `rolling-file-backup.ts` uses ahead of migrations.
 *
 * Everything here is Node builtins only: `node:fs/promises`, `node:crypto`,
 * `node:path`. No shell, no zod, no SDK imports beyond the shared private-dir guard.
 */
import { randomBytes } from "node:crypto";
import { chmod, copyFile, readFile, rename, unlink, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { ensurePrivateDir } from "../../dpi-sdk/src/node/private-dir.js";

/** Bumped only when the on-disk shape changes; `migrate` owns the upgrade path. */
export const PROJECT_REGISTRY_VERSION = 1;

/** A human filters projects by labels, so the list is short and the reason to cap it is a UI one. */
export const MAX_LABELS = 12;
/** Long enough for "waiting-on-review", short enough to fit a chip. */
export const MAX_LABEL_LENGTH = 32;
/** A display override, not a description. */
export const MAX_CUSTOM_NAME_LENGTH = 80;

/** Labels are filter keys: lowercase, no leading punctuation, spaces inside are fine. */
const LABEL_PATTERN = /^[a-z0-9][a-z0-9 _-]*$/;

/** Detected by the caller (it owns the filesystem probe — see `git.ts`), never by this module. */
export type ProjectKind = "git" | "plain";

/**
 * One project. `name` is always derived from `rootPath` and is rewritten by
 * `ensure`; `customName` is the user's override and is never touched by
 * reconciliation (paseo's rule: `resolveProjectDisplayName` = customName ?? name).
 */
export interface ProjectRecord {
  /** `prj_<12 hex>`; stable across renames of the directory. */
  id: string;
  /** Absolute project root, normalised (no trailing separator). */
  rootPath: string;
  /** Display name derived from `basename(rootPath)`. */
  name: string;
  /** User override; absent means "use `name`". */
  customName?: string;
  /** Free-form filter keys, lowercase and de-duplicated. */
  labels: string[];
  /** Default model for sessions started under this project (Wave 2: per-project settings). */
  model?: { provider: string; modelId: string };
  kind: ProjectKind;
  createdAt: string;
  updatedAt: string;
  archivedAt: string | null;
}

/** What `update` accepts: no `rootPath`/`name`/`kind` — those belong to detection, not to the user. */
export interface ProjectPatch {
  /** `""` (or `undefined`) clears the override back to the derived name. */
  customName?: string;
  /** Replaces the whole list; validated and normalised before it lands. */
  labels?: string[];
  /** Default model for new sessions in this project; `""` clears it back to the device default. */
  model?: { provider: string; modelId: string } | "";
}

/** The on-disk document. `version` exists so a future shape can be migrated instead of discarded. */
export interface ProjectRegistryFile {
  version: number;
  projects: ProjectRecord[];
}

export type ProjectRegistryErrorCode = "invalid" | "not_found";

/** Typed failure so routes can answer 400 (`invalid`) or 404 (`not_found`) without string matching. */
export class ProjectRegistryError extends Error {
  readonly code: ProjectRegistryErrorCode;

  constructor(code: ProjectRegistryErrorCode, message: string) {
    super(message);
    this.name = "ProjectRegistryError";
    this.code = code;
  }
}

export interface ProjectRegistryOptions {
  /** Where unreadable-file / recovery notices go. Defaults to `console.warn`. */
  warn?: (message: string, error?: unknown) => void;
  /** Injectable clock (ISO string) — tests pin timestamps instead of sleeping. */
  now?: () => string;
}

const invalid = (message: string) => new ProjectRegistryError("invalid", message);
const notFound = (id: string) => new ProjectRegistryError("not_found", `no project ${id}`);
const describeError = (error: unknown) => (error instanceof Error ? error.message : String(error));
const defaultWarn = (message: string, error?: unknown) =>
  console.warn(`[projects] ${message}`, error === undefined ? "" : describeError(error));

const clone = (record: ProjectRecord): ProjectRecord => ({
  ...record,
  labels: [...record.labels],
  ...(record.model ? { model: { ...record.model } } : {}),
});

/** `prj_` + 12 hex: short enough to type in a URL, wide enough that collisions are not a real risk. */
export function newProjectId(): string {
  return `prj_${randomBytes(6).toString("hex")}`;
}

/**
 * Absolute-ise and strip the trailing separator so `/a/b/` and `/a/b` are the
 * same project. Symlinks are deliberately not resolved: a session cwd should
 * match the string the user opened, and two mounts of one repo are two projects.
 */
export function normaliseRootPath(rootPath: string): string {
  const trimmed = rootPath.trim();
  if (!trimmed) throw invalid("rootPath is required");
  return resolve(trimmed);
}

/** The display name a project falls back to: its directory name. "/" stays "/". */
export function deriveProjectName(rootPath: string): string {
  const parts = rootPath.split(/[\\/]+/).filter(Boolean);
  return parts[parts.length - 1] ?? (rootPath.trim() || "project");
}

/** `customName ?? name` — the one place the override rule is written down. */
export function resolveProjectName(record: ProjectRecord): string {
  return record.customName ?? record.name;
}

/**
 * Strict label validation for `update`: lowercase, trim, drop blanks, de-dupe,
 * then reject what is left if it is too long, too many or not a filter key.
 * Throwing (rather than silently dropping) is right for user input — a label
 * that never lands must be told to the human who typed it.
 */
export function normaliseLabels(labels: readonly string[]): string[] {
  const out: string[] = [];
  for (const raw of labels) {
    if (typeof raw !== "string") throw invalid("labels must be strings");
    const label = raw.trim().toLowerCase();
    if (!label) continue; // a trailing comma is not an error worth a 400
    if (label.length > MAX_LABEL_LENGTH) {
      throw invalid(`label "${label}" is ${label.length} characters; the limit is ${MAX_LABEL_LENGTH}`);
    }
    if (!LABEL_PATTERN.test(label)) {
      throw invalid(`label "${label}" must start with a letter or digit and use only a-z, 0-9, space, "_" or "-"`);
    }
    if (out.includes(label)) continue;
    out.push(label);
  }
  if (out.length > MAX_LABELS) {
    throw invalid(`${out.length} labels; the limit is ${MAX_LABELS} per project`);
  }
  return out;
}

/**
 * Lenient variant for the load path: a file written by an older build may hold
 * labels today's rules reject, and dropping one label beats discarding the whole
 * registry (or refusing to boot on it).
 */
export function coerceLabels(labels: readonly unknown[]): string[] {
  const out: string[] = [];
  for (const raw of labels) {
    if (typeof raw !== "string") continue;
    const label = raw.trim().toLowerCase();
    if (!label || label.length > MAX_LABEL_LENGTH || !LABEL_PATTERN.test(label)) continue;
    if (out.includes(label)) continue;
    out.push(label);
    if (out.length === MAX_LABELS) break;
  }
  return out;
}

/** `""` and `undefined` both mean "no override"; anything else is trimmed and length-capped. */
export function normaliseCustomName(value: string | undefined): string | undefined {
  if (value === undefined) return undefined;
  if (typeof value !== "string") throw invalid("customName must be a string");
  const trimmed = value.trim();
  if (!trimmed) return undefined;
  if (trimmed.length > MAX_CUSTOM_NAME_LENGTH) {
    throw invalid(`customName is ${trimmed.length} characters; the limit is ${MAX_CUSTOM_NAME_LENGTH}`);
  }
  return trimmed;
}

const isKind = (value: unknown): value is ProjectKind => value === "git" || value === "plain";
const nonEmptyString = (value: unknown): string | undefined =>
  typeof value === "string" && value.trim() ? value.trim() : undefined;

/**
 * One stored record → a record we can trust. Missing `id`/`name`/timestamps are
 * repaired rather than fatal (a hand-edited file should not wipe the registry);
 * a record with no `rootPath` is unusable and fails the file, which is then moved
 * aside instead of silently forgotten.
 */
function coerceRecord(raw: unknown, now: string): ProjectRecord {
  if (!raw || typeof raw !== "object") throw invalid("project record is not an object");
  const source = raw as Record<string, unknown>;
  const rootPath = nonEmptyString(source.rootPath);
  if (!rootPath) throw invalid("project record has no rootPath");
  const normalisedRoot = normaliseRootPath(rootPath);
  const id = nonEmptyString(source.id) ?? newProjectId();
  const derived = deriveProjectName(normalisedRoot);
  const name = nonEmptyString(source.name) ?? derived;
  // Truncate rather than reject: an over-long override is still the user's word.
  const rawCustom = nonEmptyString(source.customName);
  const customName = rawCustom ? rawCustom.slice(0, MAX_CUSTOM_NAME_LENGTH).trim() || undefined : undefined;
  const record: ProjectRecord = {
    id,
    rootPath: normalisedRoot,
    name,
    labels: Array.isArray(source.labels) ? coerceLabels(source.labels) : [],
    kind: isKind(source.kind) ? source.kind : "plain",
    createdAt: nonEmptyString(source.createdAt) ?? now,
    updatedAt: nonEmptyString(source.updatedAt) ?? now,
    archivedAt: nonEmptyString(source.archivedAt) ?? null,
  };
  if (customName) record.customName = customName;
  // Per-project default model: parse strictly so a corrupted pair cannot enter
  // the registry, but never drop a good one (caught live: the field allowlist
  // here silently erased every project's model on each device boot).
  const rawModel = source.model;
  if (rawModel !== undefined && rawModel !== null && rawModel !== "") {
    if (
      rawModel &&
      typeof rawModel === "object" &&
      nonEmptyString((rawModel as Record<string, unknown>).provider) &&
      nonEmptyString((rawModel as Record<string, unknown>).modelId)
    ) {
      const model = rawModel as { provider: string; modelId: string };
      record.model = { provider: model.provider, modelId: model.modelId };
    }
  }
  return record;
}

/**
 * v0 → v1. v0 was a map keyed by rootPath (`{ projects: { "/a/b": { name, labels } } }`);
 * v1 is a list of records with ids. The legacy `name` carried user meaning, so it
 * becomes `customName` when it differs from the directory name — the display name
 * the human saw is preserved either way.
 */
function migrateV0(projects: Record<string, unknown>, now: string): ProjectRecord[] {
  const out: ProjectRecord[] = [];
  for (const [rootPath, value] of Object.entries(projects)) {
    const entry = (value && typeof value === "object" ? value : {}) as Record<string, unknown>;
    const normalisedRoot = normaliseRootPath(rootPath);
    const derived = deriveProjectName(normalisedRoot);
    const legacyName = nonEmptyString(entry.name);
    const record: ProjectRecord = {
      id: newProjectId(),
      rootPath: normalisedRoot,
      name: derived,
      labels: Array.isArray(entry.labels) ? coerceLabels(entry.labels) : [],
      // The kind needs the filesystem; `ensure` refreshes it on the next sighting.
      kind: "plain",
      createdAt: now,
      updatedAt: now,
      archivedAt: null,
    };
    if (legacyName && legacyName !== derived) record.customName = legacyName;
    out.push(record);
  }
  return out;
}

/**
 * Turn whatever is on disk into v1 records. Accepts the current document, the
 * legacy rootPath-keyed map, and a bare record array (what paseo writes); an
 * unknown `version` is refused so a newer build's file is not read as garbage.
 */
export function migrate(raw: unknown, options: { now?: string } = {}): ProjectRecord[] {
  const now = options.now ?? new Date().toISOString();
  if (raw === null || raw === undefined) return [];
  if (Array.isArray(raw)) return raw.map((entry) => coerceRecord(entry, now));
  if (typeof raw !== "object") throw invalid("registry file is not a JSON object");
  const file = raw as Record<string, unknown>;
  const version = file.version;
  if (version !== undefined && version !== null && version !== 0 && version !== 1) {
    throw invalid(`unsupported registry version ${String(version)}`);
  }
  const projects = file.projects;
  if (projects === undefined || projects === null) return [];
  if (Array.isArray(projects)) return projects.map((entry) => coerceRecord(entry, now));
  if (typeof projects === "object") return migrateV0(projects as Record<string, unknown>, now);
  throw invalid("registry `projects` is neither a list nor a map");
}

type ReadResult =
  | { ok: true; records: ProjectRecord[] }
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
    return { ok: true, records: migrate(JSON.parse(text), { now }) };
  } catch (error) {
    return { ok: false, missing: false, error };
  }
}

/**
 * The project registry: one JSON file, loaded once at `open`, mutated through an
 * in-memory map that is only committed after the file write lands.
 *
 * Writes are serialised (`run`) so two concurrent `ensure` calls cannot
 * interleave: each stages a copy of the map, persists it, then swaps it in —
 * paseo's mutation queue, without the zod parsing around it.
 */
export class ProjectRegistry {
  /** Absolute path of the main JSON file. */
  readonly filePath: string;
  /** The rolling backup restored by `open` when `filePath` is unusable. */
  readonly backupPath: string;

  private readonly warn: (message: string, error?: unknown) => void;
  private readonly now: () => string;
  private records = new Map<string, ProjectRecord>();
  /** False until a good file is read or written: while false we must not overwrite `.bak` with junk. */
  private mainIsGood = false;
  private queue: Promise<unknown> = Promise.resolve();

  private constructor(filePath: string, options: ProjectRegistryOptions) {
    this.filePath = resolve(filePath);
    this.backupPath = `${this.filePath}.bak`;
    this.warn = options.warn ?? defaultWarn;
    this.now = options.now ?? (() => new Date().toISOString());
  }

  /**
   * Load the registry, or start from an empty one. A missing file is normal
   * (fresh device). An unreadable one is moved to `<file>.corrupt-<ts>` and the
   * `.bak` is tried before giving up, because the alternative — carrying on with
   * an empty map over a file we could not parse — loses the user's labels on the
   * next write.
   */
  static async open(filePath: string, options: ProjectRegistryOptions = {}): Promise<ProjectRegistry> {
    const registry = new ProjectRegistry(filePath, options);
    await registry.load();
    return registry;
  }

  /**
   * Active projects by default — archived ones are out of the way until the UI
   * asks for them. Sorted by the name a human reads (`customName ?? name`).
   */
  list(options: { includeArchived?: boolean } = {}): ProjectRecord[] {
    const includeArchived = options.includeArchived === true;
    const records = [...this.records.values()].filter(
      (record) => includeArchived || record.archivedAt === null,
    );
    return records
      .map(clone)
      .sort(
        (left, right) =>
          resolveProjectName(left).localeCompare(resolveProjectName(right), undefined, { sensitivity: "base" }) ||
          left.id.localeCompare(right.id),
      );
  }

  /** One record by id (archived included), or undefined when it does not exist. */
  get(id: string): ProjectRecord | undefined {
    const record = this.records.get(id);
    return record ? clone(record) : undefined;
  }

  /**
   * Lookup by directory — the join sessions need, since a session only knows its
   * cwd. Archived records are returned too; filtering is the caller's call.
   */
  findByPath(rootPath: string): ProjectRecord | undefined {
    const normalised = normaliseRootPath(rootPath);
    return this.findByNormalisedPath(this.records.values(), normalised);
  }

  /**
   * Idempotent "this directory is a project" — the reconciler entry point.
   * Creates on first sighting, refreshes `kind` when a plain directory becomes a
   * git repo, and leaves an archived record archived: a cwd showing up in a
   * session list is not the user asking to un-archive.
   */
  async ensure(input: { rootPath: string; kind: ProjectKind }): Promise<ProjectRecord> {
    const rootPath = normaliseRootPath(input.rootPath);
    if (!isKind(input.kind)) throw invalid(`unknown project kind ${String(input.kind)}`);
    const kind = input.kind;
    return this.run(async () => {
      const staged = new Map(this.records);
      const now = this.now();
      const existing = this.findByNormalisedPath(staged.values(), rootPath);
      if (existing) {
        if (existing.kind === kind) return clone(existing); // nothing to persist: idempotent sighting
        const refreshed: ProjectRecord = { ...existing, kind, updatedAt: now };
        staged.set(refreshed.id, refreshed);
        await this.commit(staged);
        return clone(refreshed);
      }
      let id = newProjectId();
      while (staged.has(id)) id = newProjectId();
      const created: ProjectRecord = {
        id,
        rootPath,
        name: deriveProjectName(rootPath),
        labels: [],
        kind,
        createdAt: now,
        updatedAt: now,
        archivedAt: null,
      };
      staged.set(created.id, created);
      await this.commit(staged);
      return clone(created);
    });
  }

  /**
   * Patch what the user owns: the display override and the labels. Validation
   * throws (`ProjectRegistryError` `invalid`) rather than coercing, so a UI can
   * show the reason; `customName: ""` clears the override back to `name`.
   */
  async update(id: string, patch: ProjectPatch): Promise<ProjectRecord> {
    return this.run(async () => {
      const staged = new Map(this.records);
      const existing = staged.get(id);
      if (!existing) throw notFound(id);
      const next = clone(existing);
      if ("customName" in patch) {
        const customName = normaliseCustomName(patch.customName);
        if (customName === undefined) delete next.customName;
        else next.customName = customName;
      }
      if ("labels" in patch) next.labels = normaliseLabels(patch.labels ?? []);
      if ("model" in patch) {
        if (patch.model === "" || patch.model === undefined) delete next.model;
        else {
          const { provider, modelId } = patch.model;
          if (typeof provider !== "string" || !provider.trim() || typeof modelId !== "string" || !modelId.trim())
            throw invalid("model needs a provider and a modelId");
          next.model = { provider: provider.trim(), modelId: modelId.trim() };
        }
      }
      next.updatedAt = this.now();
      staged.set(next.id, next);
      await this.commit(staged);
      return clone(next);
    });
  }

  /**
   * Soft delete. Archiving on an already-archived project keeps the original
   * stamp — the first archive is the fact, a second one is a double click.
   */
  async archive(id: string): Promise<ProjectRecord> {
    return this.run(async () => {
      const staged = new Map(this.records);
      const existing = staged.get(id);
      if (!existing) throw notFound(id);
      if (existing.archivedAt) return clone(existing);
      const now = this.now();
      const next: ProjectRecord = { ...existing, archivedAt: now, updatedAt: now };
      staged.set(next.id, next);
      await this.commit(staged);
      return clone(next);
    });
  }

  /** Undo `archive`. Labels and customName survived, which is the whole point of a soft delete. */
  async unarchive(id: string): Promise<ProjectRecord> {
    return this.run(async () => {
      const staged = new Map(this.records);
      const existing = staged.get(id);
      if (!existing) throw notFound(id);
      if (existing.archivedAt === null) return clone(existing);
      const next: ProjectRecord = { ...existing, archivedAt: null, updatedAt: this.now() };
      staged.set(next.id, next);
      await this.commit(staged);
      return clone(next);
    });
  }

  /**
   * Hard delete, for tests and for a project the user really wants forgotten.
   * The UI archives; nothing in the product calls this on a human's behalf.
   */
  async remove(id: string): Promise<boolean> {
    return this.run(async () => {
      if (!this.records.has(id)) return false;
      const staged = new Map(this.records);
      staged.delete(id);
      await this.commit(staged);
      return true;
    });
  }

  private async load(): Promise<void> {
    // Same guard as `Store.open`: the data dir holds credentials-adjacent state, so
    // it is created 0700 or tightened before a single byte is written into it.
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
      this.warn(`recovered ${backup.records.length} project(s) from ${this.backupPath}`);
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

  private adopt(records: readonly ProjectRecord[]): void {
    this.records.clear();
    for (const record of records) this.records.set(record.id, record);
  }

  private findByNormalisedPath(
    records: Iterable<ProjectRecord>,
    rootPath: string,
  ): ProjectRecord | undefined {
    for (const record of records) if (record.rootPath === rootPath) return record;
    return undefined;
  }

  /** Stage → persist → swap. A failed write leaves memory exactly as it was. */
  private async commit(staged: Map<string, ProjectRecord>): Promise<void> {
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
   * bytes or the complete new ones — never a torn registry (paseo `atomic-file.ts`,
   * this repo's `pairing-files.writeAtomic`).
   */
  private async persist(records: readonly ProjectRecord[]): Promise<void> {
    const dir = dirname(this.filePath);
    ensurePrivateDir(dir); // re-tightened on every write, like the pairing files
    if (this.mainIsGood) await this.backUpMain();

    const payload = `${JSON.stringify(
      { version: PROJECT_REGISTRY_VERSION, projects: [...records] } satisfies ProjectRegistryFile,
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
