/**
 * Device-side notification delivery fan-out — "Notification delivery fan-out",
 * Wave 2 of docs/host-project-checklist.md.
 *
 * A device that hosts durable sessions already knows when something happens
 * (a turn failed, a schedule ran, a session finished). This module is the piece
 * that can *tell someone* without the hub in the middle: one event in, zero or
 * more configured sinks out — a generic `webhook` (JSON POST) and `ntfy`
 * (a push to an ntfy server, `<server>/<topic>`).
 *
 * Modelled on orca's `notification-delivery-service.ts:15-49` (tray → mobile →
 * desktop fan-out behind a burst cooldown) and piggery's `setup notify` hooks
 * (`docs/reference.md:15`, desktop/herdr/ntfy). Two deliberate adaptations:
 * sinks are *records in a file* instead of a fixed tray/mobile/desktop ladder,
 * so the operator opts in per target; and the cooldown is keyed per sink **and
 * per event kind**, because "the disk is full" arriving ten times in a burst is
 * one notification while "backup ok" and "backup failed" are not the same news.
 *
 * The file handling is lifted from `projects.ts` on purpose — same atomic
 * temp+rename, same `.bak` rolling backup, same "unreadable file is moved aside,
 * never overwritten" rule, same 0600/0700 perms, same serialised mutation queue
 * and the same typed errors. Delivery state (`lastDeliveryAt`, `lastError`,
 * `lastStatus`) lives in that same file: a sink whose webhook has been dead for a
 * week should say so on the next boot, not forget it.
 *
 * `deliver()` never throws. A dead webhook must not break a session turn — the
 * caller gets a per-sink `failed` result and the reason lands on the record.
 *
 * Everything here is Node builtins only: `node:fs/promises`, `node:crypto`,
 * `node:path`. No shell, no zod, no HTTP client of its own — the `fetchImpl`
 * seam is injected (default `globalThis.fetch`).
 */
import { randomBytes } from "node:crypto";
import { chmod, copyFile, readFile, rename, unlink, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { ensurePrivateDir } from "../../dpi-sdk/src/node/private-dir.js";

/** Bumped only when the on-disk shape changes; `migrate` owns the upgrade path. */
export const NOTIFY_REGISTRY_VERSION = 1;

/** One delivery per (sink, event kind) per window. orca's `NOTIFICATION_COOLDOWN_MS` lesson, per kind. */
export const DEFAULT_COOLDOWN_MS = 10_000;
/** A notification is not worth holding a session turn open for; the sink is retried on the next event. */
export const DEFAULT_TIMEOUT_MS = 5_000;

/** A human label, not a description. */
export const MAX_LABEL_LENGTH = 60;
/** ntfy turns more than this into noise in a phone's status bar. */
export const MAX_TAGS = 5;
/** ntfy tags are short words or emoji shortcodes. */
export const MAX_TAG_LENGTH = 20;
/** Filter patterns are hand-written; past this the list is a routing table, not a subscription. */
export const MAX_EVENT_PATTERNS = 32;
/** `lastError` is shown in a UI row; a stack of nested fetch causes helps nobody there. */
const MAX_ERROR_LENGTH = 300;

/** Patterns are event kinds: loose tokens, optionally ending in `.*`. `*` alone means "everything". */
const EVENT_PATTERN = /^(\*|[A-Za-z0-9][A-Za-z0-9._-]*(\.\*)?)$/;
/** ntfy joins tags with commas, so a tag cannot contain one. */
const TAGS_FORBIDDEN = /[\s,]/;

export type SinkKind = "webhook" | "ntfy";

/** ntfy's five priorities, spelled the way its HTTP API spells them. */
export type NotifyPriority = "min" | "low" | "default" | "high" | "max";

const PRIORITIES: readonly NotifyPriority[] = ["min", "low", "default", "high", "max"];

/**
 * One event to fan out. `kind` is the filter key (free-form — the device emits
 * `session.failed`, `schedule.ok`, `schedule.failed`, `test` today), `title` and
 * `body` are what a human reads, and `data` is extra structure a webhook
 * consumer may want.
 */
export interface NotifyEvent {
  /** "session.failed" | "schedule.ok" | "schedule.failed" | "test" — free-form, used for filtering. */
  kind: string;
  title: string;
  body: string;
  /** Extra structured fields; delivered as-is in the webhook JSON. */
  data?: Record<string, unknown>;
}

/** What `create` takes and what `update` patches. `id`/timestamps belong to the registry. */
export interface SinkInput {
  kind: SinkKind;
  /** `http(s)://…`. For an `ntfy` sink the path *is* the topic (`https://ntfy.sh/dpi`). */
  url: string;
  /** Defaults to `true`: a sink that exists is a sink the operator asked for. */
  enabled?: boolean;
  /** Event kinds this sink wants; absent or empty means every kind. */
  events?: string[];
  label?: string;
  /** ntfy only: the priority header. Absent lets ntfy decide (`default`). */
  priority?: NotifyPriority;
  /** ntfy only: `Tags` header entries. */
  tags?: string[];
}

/**
 * One configured sink plus the outcome of its last attempt. Delivery state is
 * written by `deliver` — it is not part of `SinkInput`.
 */
export interface SinkRecord {
  /** `snk_<12 hex>`; stable for the life of the sink. */
  id: string;
  kind: SinkKind;
  /** Normalised: no trailing slash on the path, no userinfo (both are rejected at write time). */
  url: string;
  enabled: boolean;
  /** Absent/empty = every event; otherwise exact kind match or a `prefix.*` wildcard. */
  events: string[];
  label?: string;
  priority?: NotifyPriority;
  tags?: string[];
  createdAt: number;
  updatedAt: number;
  /** When the last delivery *attempt* finished — success or failure. */
  lastDeliveryAt?: number;
  /** Why that attempt failed, as one line (≤ 300 chars). Cleared by a success. */
  lastError?: string;
  /** HTTP status of that attempt; absent when the request never got a response. */
  lastStatus?: number;
  /** The per-sink grant this record was created (or last patched) with — a LAN
   *  sink must survive its own patches: re-validating the SAME url on a later
   *  PATCH reuses this flag instead of 400ing. Pointing the sink at a NEW url
   *  is judged like a fresh create: env default or an explicit opt-in. */
  allowPrivateHosts?: boolean;
}

/** The on-disk document. `version` exists so a future shape can be migrated instead of discarded. */
export interface NotifyRegistryFile {
  version: number;
  sinks: SinkRecord[];
}

/** One sink's verdict for one event. `deliver` returns these in sink order. */
export interface DeliveryResult {
  id: string;
  kind: SinkKind;
  status: "sent" | "skipped" | "failed";
  /** `filtered` | `cooldown` for skips, `HTTP 500` / the fetch error for failures. */
  detail?: string;
  /** Wall-clock duration of the request, on attempts that actually left the device. */
  ms?: number;
}

/** The sliver of `fetch` this module uses — injected so tests never open a socket. */
export interface FetchResponseLike {
  readonly ok: boolean;
  readonly status: number;
}

export type FetchLike = (
  url: string,
  init: {
    method: string;
    headers: Record<string, string>;
    body: string;
    signal?: AbortSignal;
    /** R19 (run-5 h7, leader-confirmed): redirects are refused — see attempt(). */
    redirect?: "error" | "follow" | "manual";
  },
) => Promise<FetchResponseLike>;

export type NotifySinkErrorCode = "invalid" | "not_found";

/** Typed failure so routes can answer 400 (`invalid`) or 404 (`not_found`) without string matching. */
export class NotifySinkError extends Error {
  readonly code: NotifySinkErrorCode;

  constructor(code: NotifySinkErrorCode, message: string) {
    super(message);
    this.name = "NotifySinkError";
    this.code = code;
  }
}

export interface NotifySinksOptions {
  /** Where unreadable-file / recovery / delivery-write notices go. Defaults to `console.warn`. */
  warn?: (message: string, error?: unknown) => void;
  /** Injectable clock (epoch ms) — tests pin timestamps and cooldowns instead of sleeping. */
  now?: () => number;
  /** Defaults to `globalThis.fetch`. */
  fetchImpl?: FetchLike;
  /** Minimum gap between two deliveries of the same event kind to one sink. */
  cooldownMs?: number;
  /** Per-request timeout handed to `AbortSignal.timeout`. */
  timeoutMs?: number;
  /**
   * Allow `localhost`, loopback, link-local and private-range hosts. Default
   * `false`: a sink URL is user input, and a device that will POST to
   * `http://169.254.169.254/` on request is an SSRF primitive. The reverse case
   * is real, though — an ntfy server on the LAN is the common self-hosted
   * setup — so the operator can turn it on deliberately.
   */
  allowPrivateHosts?: boolean;
}

const invalid = (message: string) => new NotifySinkError("invalid", message);
const notFound = (id: string) => new NotifySinkError("not_found", `no notification sink ${id}`);
const describeError = (error: unknown) => (error instanceof Error ? error.message : String(error));
const defaultWarn = (message: string, error?: unknown) =>
  console.warn(`[notify] ${message}`, error === undefined ? "" : describeError(error));

const clone = (record: SinkRecord): SinkRecord => ({
  ...record,
  events: [...record.events],
  ...(record.tags ? { tags: [...record.tags] } : {}),
});

/** `snk_` + 12 hex: short enough for a URL, wide enough that collisions are not a real risk. */
export function newSinkId(): string {
  return `snk_${randomBytes(6).toString("hex")}`;
}

const isKind = (value: unknown): value is SinkKind => value === "webhook" || value === "ntfy";
const isPriority = (value: unknown): value is NotifyPriority =>
  typeof value === "string" && (PRIORITIES as readonly string[]).includes(value);
const nonEmptyString = (value: unknown): string | undefined =>
  typeof value === "string" && value.trim() ? value.trim() : undefined;

/**
 * Is this host one the device must not POST to by default? Judged on the literal
 * host in the URL — `localhost`/`.localhost`, decimal-encoded IPv4, every
 * private/loopback/link-local/CGNAT range, IPv6 `::`/`::1`/`fc00::/7`/`fe80::/10`
 * and IPv4-mapped forms of the above.
 *
 * Known limit, on purpose: no DNS is resolved here (this module must not do I/O
 * to validate input). A public-looking name that resolves to `127.0.0.1` passes
 * the check — the flag exists to stop the obvious cases, not to be a firewall.
 */
export function isPrivateHost(hostname: string): boolean {
  const host = hostname.trim().toLowerCase().replace(/^\[|\]$/g, "");
  if (!host) return true;
  if (host === "localhost" || host.endsWith(".localhost")) return true;
  if (/^\d+$/.test(host)) return true; // decimal-encoded IPv4 (2130706433 → 127.0.0.1)
  if (isPrivateIPv4(host)) return true;
  if (host.includes(":")) {
    if (host === "::" || host === "::1") return true;
    if (/^f[cd][0-9a-f]{2}:/.test(host)) return true; // fc00::/7 unique-local
    if (/^fe[89ab][0-9a-f]:/.test(host)) return true; // fe80::/10 link-local
    if (host.startsWith("::ffff:")) {
      const mapped = host.slice("::ffff:".length);
      if (isPrivateIPv4(mapped)) return true; // dotted-quad mapped form
      // R19 (run-5 h7, leader-confirmed): hex-group mapped spellings
      // ("::ffff:7f00:1" = 127.0.0.1, "::ffff:a9fe:a9fe" = 169.254.169.254)
      // classify as PUBLIC unless decoded here — WHATWG URL keeps the hex
      // groups and the kernel maps the literal's low 32 bits to the IPv4
      // destination. Decode by the LAST two groups (the kernel-mapped half).
      const groups = mapped.split(":").filter(Boolean);
      if (groups.length >= 1 && groups.every((g) => /^[0-9a-f]{1,4}$/i.test(g))) {
        const value = ipv4FromLastGroups(groups);
        if (value !== null && isPrivateIPv4(value)) return true;
      }
      return false;
    }
    // IPv4-compatible ::/96 spellings ("::7f00:1") — deprecated but connectable.
    if (/^::[0-9a-f:]+$/.test(host) && host.includes(":")) {
      const groups = host.slice(2).split(":").filter(Boolean);
      if (groups.length >= 1 && groups.every((g) => /^[0-9a-f]{1,4}$/i.test(g))) {
        const value = ipv4FromLastGroups(groups);
        if (value !== null && isPrivateIPv4(value)) return true;
      }
    }
    return false;
  }
  return false;
}

/** R19: decode the low 32 bits of a hex-group IPv6 tail into dotted-quad (null on overflow). */
function ipv4FromLastGroups(groups: string[]): string | null {
  const last = groups[groups.length - 1]!;
  const prev = groups[groups.length - 2];
  const hi = prev !== undefined ? parseInt(prev, 16) : 0;
  const lo = parseInt(last, 16);
  const value = ((hi & 0xffff) << 16) | (lo & 0xffff);
  return `${(value >>> 24) & 255}.${(value >>> 16) & 255}.${(value >>> 8) & 255}.${value & 255}`;
}

function isPrivateIPv4(host: string): boolean {
  const parts = host.split(".");
  if (parts.length !== 4) return false;
  const nums = parts.map((part) => (/^\d{1,3}$/.test(part) ? Number(part) : Number.NaN));
  if (nums.some((n) => !Number.isInteger(n) || n < 0 || n > 255)) return false;
  const [a, b] = nums as [number, number, number, number];
  if (a === 0 || a === 10 || a === 127) return true;
  if (a === 169 && b === 254) return true; // link-local, incl. the cloud metadata address
  if (a === 172 && b >= 16 && b <= 31) return true;
  if (a === 192 && b === 168) return true;
  if (a === 192 && b === 0) return true; // 192.0.0.0/24 protocol assignments
  if (a === 100 && b >= 64 && b <= 127) return true; // CGNAT
  return a >= 224; // multicast + reserved
}

/**
 * Validate and normalise a sink URL: `http`/`https` only (so `file:`, `gopher:`,
 * `data:` and every other scheme is out), no embedded credentials, and no
 * loopback/private host unless `allowPrivateHosts`. The trailing slash on the
 * path is dropped so `https://ntfy.sh/dpi/` and `https://ntfy.sh/dpi` are one
 * sink and one request URL.
 */
export function normaliseSinkUrl(raw: string, options: { allowPrivateHosts?: boolean } = {}): string {
  const trimmed = typeof raw === "string" ? raw.trim() : "";
  if (!trimmed) throw invalid("url is required");
  let parsed: URL;
  try {
    parsed = new URL(trimmed);
  } catch {
    throw invalid(`url "${trimmed}" is not a URL`);
  }
  if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
    throw invalid(`url scheme "${parsed.protocol}" is not allowed; use http: or https:`);
  }
  // `new URL("http://user:pw@host")` parses happily; those credentials would be
  // sent on every event and end up in the registry file, so they are refused.
  if (parsed.username || parsed.password) throw invalid("url must not embed credentials (user:password@)");
  if (!parsed.hostname) throw invalid(`url "${trimmed}" has no host`);
  if (!options.allowPrivateHosts && isPrivateHost(parsed.hostname)) {
    throw invalid(
      `url host "${parsed.hostname}" is local/private; pass allowPrivateHosts to reach a LAN sink (e.g. a self-hosted ntfy)`,
    );
  }
  const path = parsed.pathname.replace(/\/+$/, "");
  return `${parsed.origin}${path}${parsed.search}`;
}

/**
 * Does `kind` match the sink's filter? A bare `*`, an exact kind, or a
 * `prefix.*` wildcard (`schedule.*` matches `schedule.ok`). An absent or empty
 * list means the sink wants everything.
 */
export function matchesEventFilter(patterns: readonly string[], kind: string): boolean {
  if (patterns.length === 0) return true;
  for (const pattern of patterns) {
    if (pattern === "*" || pattern === kind) return true;
    if (pattern.endsWith(".*") && kind.startsWith(pattern.slice(0, -1))) return true;
  }
  return false;
}

/** Strict validation for the write path: a pattern that never matches must be told to whoever typed it. */
export function normaliseEventPatterns(patterns: readonly string[] | undefined): string[] {
  if (patterns === undefined) return [];
  if (!Array.isArray(patterns)) throw invalid("events must be a list of event kinds");
  const out: string[] = [];
  for (const raw of patterns) {
    if (typeof raw !== "string") throw invalid("events must be strings");
    const pattern = raw.trim();
    if (!pattern) continue; // a trailing comma is not an error worth a 400
    if (pattern.length > MAX_LABEL_LENGTH) throw invalid(`event pattern "${pattern}" is too long`);
    if (!EVENT_PATTERN.test(pattern)) {
      throw invalid(`event pattern "${pattern}" must be an event kind, optionally ending in ".*"`);
    }
    if (out.includes(pattern)) continue;
    out.push(pattern);
  }
  if (out.length > MAX_EVENT_PATTERNS) {
    throw invalid(`${out.length} event patterns; the limit is ${MAX_EVENT_PATTERNS}`);
  }
  return out;
}

/** Lenient variant for the load path: a hand-edited file must not lose its sink over one bad pattern. */
function coerceEventPatterns(patterns: readonly unknown[]): string[] {
  const out: string[] = [];
  for (const raw of patterns) {
    if (typeof raw !== "string") continue;
    const pattern = raw.trim();
    if (!pattern || !EVENT_PATTERN.test(pattern) || out.includes(pattern)) continue;
    out.push(pattern);
    if (out.length === MAX_EVENT_PATTERNS) break;
  }
  return out;
}

function normaliseLabel(value: string | undefined): string | undefined {
  if (value === undefined) return undefined;
  if (typeof value !== "string") throw invalid("label must be a string");
  const trimmed = value.trim();
  if (!trimmed) return undefined;
  if (trimmed.length > MAX_LABEL_LENGTH) {
    throw invalid(`label is ${trimmed.length} characters; the limit is ${MAX_LABEL_LENGTH}`);
  }
  return trimmed;
}

function normaliseTags(value: readonly string[] | undefined): string[] | undefined {
  if (value === undefined) return undefined;
  if (!Array.isArray(value)) throw invalid("tags must be a list of strings");
  const out: string[] = [];
  for (const raw of value) {
    if (typeof raw !== "string") throw invalid("tags must be strings");
    const tag = raw.trim();
    if (!tag) continue;
    if (tag.length > MAX_TAG_LENGTH) {
      throw invalid(`tag "${tag}" is ${tag.length} characters; the limit is ${MAX_TAG_LENGTH}`);
    }
    if (TAGS_FORBIDDEN.test(tag)) throw invalid(`tag "${tag}" must not contain spaces or commas`);
    if (out.includes(tag)) continue;
    out.push(tag);
  }
  if (out.length > MAX_TAGS) throw invalid(`${out.length} tags; the limit is ${MAX_TAGS}`);
  return out.length > 0 ? out : undefined;
}

/**
 * Validate input against the sink kind. `priority`/`tags` are ntfy's headers, so
 * on a webhook they are a mistake worth reporting rather than a silently
 * dropped field.
 */
function validateInput(
  input: SinkInput,
  options: { allowPrivateHosts?: boolean },
): {
  kind: SinkKind;
  url: string;
  enabled: boolean;
  events: string[];
  label?: string;
  priority?: NotifyPriority;
  tags?: string[];
} {
  if (!input || typeof input !== "object") throw invalid("sink input is required");
  if (!isKind(input.kind)) throw invalid(`kind must be "webhook" or "ntfy"`);
  const kind = input.kind;
  // Scalar fields first, so a patch that carries both a bad label and a url
  // problem reports the label — the field the caller can fix without deciding
  // the url question again.
  if (input.enabled !== undefined && typeof input.enabled !== "boolean") {
    throw invalid("enabled must be true or false");
  }
  if (input.priority !== undefined && !isPriority(input.priority)) {
    throw invalid(`priority must be one of ${PRIORITIES.join(", ")}`);
  }
  if (input.priority !== undefined && kind !== "ntfy") throw invalid("priority is ntfy-only");
  if (input.tags !== undefined && kind !== "ntfy") throw invalid("tags are ntfy-only");
  const label = normaliseLabel(input.label);
  const tags = normaliseTags(input.tags);
  const priority = input.priority;
  const url = normaliseSinkUrl(input.url, { allowPrivateHosts: options.allowPrivateHosts === true });
  if (kind === "ntfy") {
    // ntfy publishes to <server>/<topic>; a bare server URL would 404 on every event.
    const path = new URL(url).pathname.replace(/^\/+|\/+$/g, "");
    if (!path) throw invalid(`ntfy url must include the topic: https://ntfy.sh/<topic>`);
  }
  return {
    kind,
    url,
    enabled: input.enabled !== false,
    events: normaliseEventPatterns(input.events),
    ...(label ? { label } : {}),
    ...(priority ? { priority } : {}),
    ...(tags ? { tags } : {}),
  };
}

/**
 * One stored record → a record we can trust. A row with no usable url is dropped
 * (the caller warns) instead of failing the whole file: one hand-edited sink must
 * not cost the operator the others.
 */
function coerceRecord(raw: unknown, now: number): SinkRecord | undefined {
  if (!raw || typeof raw !== "object") return undefined;
  const source = raw as Record<string, unknown>;
  if (!isKind(source.kind)) return undefined;
  const rawUrl = nonEmptyString(source.url);
  if (!rawUrl) return undefined;
  let url: string;
  try {
    // The file was written by us, so private hosts were already allowed or the
    // operator flipped the flag; re-validating the scheme is what matters here.
    url = normaliseSinkUrl(rawUrl, { allowPrivateHosts: true });
  } catch {
    return undefined;
  }
  const id = nonEmptyString(source.id) ?? newSinkId();
  const label = nonEmptyString(source.label)?.slice(0, MAX_LABEL_LENGTH).trim();
  const tags = Array.isArray(source.tags) ? normaliseTagsLenient(source.tags) : undefined;
  const record: SinkRecord = {
    id,
    kind: source.kind,
    url,
    enabled: source.enabled !== false,
    events: Array.isArray(source.events) ? coerceEventPatterns(source.events) : [],
    createdAt: typeof source.createdAt === "number" ? source.createdAt : now,
    updatedAt: typeof source.updatedAt === "number" ? source.updatedAt : now,
  };
  if (label) record.label = label;
  if (source.kind === "ntfy" && isPriority(source.priority)) record.priority = source.priority;
  if (tags) record.tags = tags;
  if (source.allowPrivateHosts === true) record.allowPrivateHosts = true;
  if (typeof source.lastDeliveryAt === "number") record.lastDeliveryAt = source.lastDeliveryAt;
  if (typeof source.lastStatus === "number") record.lastStatus = source.lastStatus;
  const lastError = nonEmptyString(source.lastError);
  if (lastError) record.lastError = lastError.slice(0, MAX_ERROR_LENGTH);
  return record;
}

/** Load-path tags: keep what ntfy will accept, drop the rest. */
function normaliseTagsLenient(tags: readonly unknown[]): string[] | undefined {
  const out: string[] = [];
  for (const raw of tags) {
    if (typeof raw !== "string") continue;
    const tag = raw.trim();
    if (!tag || tag.length > MAX_TAG_LENGTH || TAGS_FORBIDDEN.test(tag)) continue;
    if (out.includes(tag)) continue;
    out.push(tag);
    if (out.length === MAX_TAGS) break;
  }
  return out.length > 0 ? out : undefined;
}

/**
 * Turn whatever is on disk into records. Accepts the current document and a bare
 * sink array (a hand-written `notify.json`); an unknown `version` is refused so a
 * newer build's file is not read as garbage.
 */
export function migrate(raw: unknown, options: { now?: number } = {}): SinkRecord[] {
  const now = options.now ?? Date.now();
  if (raw === null || raw === undefined) return [];
  const rows = Array.isArray(raw)
    ? raw
    : typeof raw === "object"
      ? (() => {
          const file = raw as Record<string, unknown>;
          const version = file.version;
          if (version !== undefined && version !== null && version !== 0 && version !== 1) {
            throw invalid(`unsupported notify registry version ${String(version)}`);
          }
          const sinks = file.sinks;
          if (sinks === undefined || sinks === null) return [];
          if (!Array.isArray(sinks)) throw invalid("notify registry `sinks` is not a list");
          return sinks;
        })()
      : undefined;
  if (!rows) throw invalid("notify registry file is not a JSON object or a list");
  const out: SinkRecord[] = [];
  for (const entry of rows) {
    const record = coerceRecord(entry, now);
    if (record) out.push(record);
  }
  return out;
}

type ReadResult = { ok: true; records: SinkRecord[] } | { ok: false; missing: boolean; error: unknown };

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
 * The sink registry: one JSON file, loaded once at `open`, mutated through an
 * in-memory map that is only committed after the file write lands.
 *
 * Writes are serialised (`run`) so a `create` cannot interleave with a
 * `deliver`'s state write. `deliver` does its network work outside that queue and
 * merges only the delivery state, at most once per call.
 */
export class NotifySinks {
  /** Absolute path of the main JSON file. */
  readonly filePath: string;
  /** The rolling backup restored by `open` when `filePath` is unusable. */
  readonly backupPath: string;

  private readonly warn: (message: string, error?: unknown) => void;
  private readonly now: () => number;
  private readonly fetchImpl: FetchLike;
  private readonly cooldownMs: number;
  private readonly timeoutMs: number;
  private readonly allowPrivateHosts: boolean;
  private records = new Map<string, SinkRecord>();
  /** `sinkId` → `eventKind` → when that kind last reserved a delivery slot (orca's cooldown map). */
  private readonly cooldowns = new Map<string, Map<string, number>>();
  /** False until a good file is read or written: while false we must not overwrite `.bak` with junk. */
  private mainIsGood = false;
  private queue: Promise<unknown> = Promise.resolve();

  private constructor(filePath: string, options: NotifySinksOptions) {
    this.filePath = resolve(filePath);
    this.backupPath = `${this.filePath}.bak`;
    this.warn = options.warn ?? defaultWarn;
    this.now = options.now ?? (() => Date.now());
    this.fetchImpl = options.fetchImpl ?? (globalThis.fetch as unknown as FetchLike);
    this.cooldownMs = options.cooldownMs ?? DEFAULT_COOLDOWN_MS;
    this.timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
    this.allowPrivateHosts = options.allowPrivateHosts === true;
  }

  /**
   * Load the registry, or start from an empty one. A missing file is normal (the
   * operator has not configured a sink yet). An unreadable one is moved to
   * `<file>.corrupt-<ts>` and the `.bak` is tried before giving up, because the
   * alternative — carrying on with an empty map over a file we could not parse —
   * loses every sink on the next write.
   */
  static async open(filePath: string, options: NotifySinksOptions = {}): Promise<NotifySinks> {
    const sinks = new NotifySinks(filePath, options);
    await sinks.load();
    return sinks;
  }

  /** Every configured sink, enabled or not, in creation order. Disabled ones are not delivered to. */
  list(): SinkRecord[] {
    return [...this.records.values()]
      .map(clone)
      .sort((left, right) => left.createdAt - right.createdAt || left.id.localeCompare(right.id));
  }

  /** One sink by id, or undefined when it does not exist. */
  get(id: string): SinkRecord | undefined {
    const record = this.records.get(id);
    return record ? clone(record) : undefined;
  }

  /**
   * Add a sink. Validation throws (`NotifySinkError` `invalid`) rather than
   * coercing, so a UI can show the reason: the URL is the one field a typo makes
   * silently useless.
   *
   * `options.allowPrivateHosts` grants this one call on top of the env default
   * (`DPI_NOTIFY_ALLOW_PRIVATE`) — a LAN sink is an explicit per-request opt-in.
   */
  async create(input: SinkInput, options: { allowPrivateHosts?: boolean } = {}): Promise<SinkRecord> {
    const fields = validateInput(input, { allowPrivateHosts: this.allowPrivateHosts || options.allowPrivateHosts === true });
    return this.run(async () => {
      const staged = new Map(this.records);
      let id = newSinkId();
      while (staged.has(id)) id = newSinkId();
      const now = this.now();
      const record: SinkRecord = { id, ...fields, createdAt: now, updatedAt: now };
      // Remember the per-request grant on the record: it is what lets later
      // patches of the SAME url re-validate instead of 400ing (the env default
      // needs no record — it applies on its own).
      if (options.allowPrivateHosts === true) record.allowPrivateHosts = true;
      staged.set(record.id, record);
      await this.commit(staged);
      return clone(record);
    });
  }

  /**
   * Patch a sink. `kind` and `url` are re-validated together, so switching a
   * webhook to ntfy (or pointing it at a LAN host) is judged on the pair that
   * will actually be used. `enabled: false` keeps the record — muting a noisy
   * sink is not the same as forgetting it.
   */
  async update(
    id: string,
    patch: Partial<SinkInput> & { enabled?: boolean },
    options: { allowPrivateHosts?: boolean } = {},
  ): Promise<SinkRecord> {
    return this.run(async () => {
      const staged = new Map(this.records);
      const existing = staged.get(id);
      if (!existing) throw notFound(id);
      const merged: SinkInput = {
        kind: patch.kind ?? existing.kind,
        url: patch.url ?? existing.url,
        enabled: patch.enabled ?? existing.enabled,
        events: "events" in patch ? (patch.events ?? []) : existing.events,
      };
      // `"field" in patch` is what distinguishes "leave it alone" from "clear it".
      if ("label" in patch) merged.label = patch.label;
      else if (existing.label) merged.label = existing.label;
      if ("priority" in patch) merged.priority = patch.priority;
      else if (existing.priority) merged.priority = existing.priority;
      if ("tags" in patch) merged.tags = patch.tags;
      else if (existing.tags) merged.tags = existing.tags;
      // The grant persisted at create re-validates the sink's OWN url on every
      // patch — {"label":"x"} on a LAN sink must not 400. A NEW url is judged
      // like a fresh create: env default or an explicit per-request opt-in
      // (B5), so the flag is not a one-time skeleton key for future hosts.
      let urlUnchanged = true;
      if (patch.url !== undefined) {
        try {
          urlUnchanged = normaliseSinkUrl(patch.url, { allowPrivateHosts: true }) === existing.url;
        } catch {
          urlUnchanged = false; // the real validation below reports why
        }
      }
      const fields = validateInput(merged, {
        allowPrivateHosts:
          this.allowPrivateHosts ||
          options.allowPrivateHosts === true ||
          (existing.allowPrivateHosts === true && urlUnchanged),
      });
      const next: SinkRecord = { ...existing, ...fields, id: existing.id, createdAt: existing.createdAt };
      next.updatedAt = this.now();
      // An explicit opt-in on this patch re-grants the record (for its new url);
      // otherwise the create-time grant rides along untouched.
      if (options.allowPrivateHosts === true || existing.allowPrivateHosts === true) next.allowPrivateHosts = true;
      else delete next.allowPrivateHosts;
      // A field that validation dropped (empty label, no tags) must not linger from the old record.
      if (!fields.label) delete next.label;
      if (!fields.priority) delete next.priority;
      if (!fields.tags) delete next.tags;
      staged.set(next.id, next);
      await this.commit(staged);
      return clone(next);
    });
  }

  /** Hard delete. Returns false when the id was already gone. */
  async remove(id: string): Promise<boolean> {
    return this.run(async () => {
      if (!this.records.has(id)) return false;
      const staged = new Map(this.records);
      staged.delete(id);
      await this.commit(staged);
      this.cooldowns.delete(id);
      return true;
    });
  }

  /**
   * Fan one event out to every enabled, matching sink — **sequentially**, in
   * `list()` order, so a slow sink cannot turn a burst into a stampede and the
   * outcome of each attempt is written down before the next one starts.
   *
   * Never throws: a sink that 500s, times out or refuses the connection becomes a
   * `failed` result plus `lastError`/`lastStatus` on its record. The caller is
   * usually a session turn that must not die because someone's webhook did.
   */
  async deliver(event: NotifyEvent, context: { device: string }): Promise<DeliveryResult[]> {
    const device = nonEmptyString(context?.device) ?? "unknown";
    const kind = nonEmptyString(event?.kind);
    if (!kind) {
      // Not a throw: the caller's event was malformed, and no sink should hear about it.
      this.warn("deliver() called without an event kind; nothing was sent");
      return [];
    }
    const normalised: NotifyEvent = {
      kind,
      title: typeof event.title === "string" ? event.title : "",
      body: typeof event.body === "string" ? event.body : "",
      ...(event.data && typeof event.data === "object" ? { data: event.data } : {}),
    };

    const results: DeliveryResult[] = [];
    const updates = new Map<string, Partial<SinkRecord>>();
    const attempted = this.now();

    for (const sink of this.list()) {
      if (!sink.enabled) continue;
      if (!matchesEventFilter(sink.events, kind)) {
        results.push({ id: sink.id, kind: sink.kind, status: "skipped", detail: "filtered" });
        continue;
      }
      const silencedUntil = this.reserveCooldown(sink.id, kind, attempted);
      if (silencedUntil !== undefined) {
        results.push({ id: sink.id, kind: sink.kind, status: "skipped", detail: "cooldown" });
        continue;
      }
      results.push(await this.attempt(sink, normalised, device, updates));
    }

    if (updates.size > 0) await this.commitDeliveryState(updates);
    return results;
  }

  /**
   * Which sinks are still inside a cooldown window. One entry per configured
   * sink: `silencedUntil` is the epoch-ms end of the longest-running window, and
   * absent when nothing is silenced. Reservations are per (sink, event kind), so
   * a sink can appear here for one kind and still be delivering another.
   */
  recent(): { id: string; silencedUntil?: number }[] {
    const now = this.now();
    return this.list().map((sink) => {
      const kinds = this.cooldowns.get(sink.id);
      let silencedUntil: number | undefined;
      if (kinds) {
        for (const [kind, reservedAt] of kinds) {
          if (now - reservedAt >= this.cooldownMs) {
            kinds.delete(kind);
            continue;
          }
          const until = reservedAt + this.cooldownMs;
          if (silencedUntil === undefined || until > silencedUntil) silencedUntil = until;
        }
        if (kinds.size === 0) this.cooldowns.delete(sink.id);
      }
      return silencedUntil === undefined ? { id: sink.id } : { id: sink.id, silencedUntil };
    });
  }

  /**
   * Claim this sink's slot for `kind`, or report that it is still cooling down.
   * Reserving *before* the attempt (orca does the same) means a dead endpoint is
   * tried once per window, not once per event.
   */
  private reserveCooldown(id: string, kind: string, now: number): number | undefined {
    const kinds = this.cooldowns.get(id) ?? new Map<string, number>();
    const last = kinds.get(kind);
    if (last !== undefined && now - last < this.cooldownMs) return last + this.cooldownMs;
    kinds.delete(kind);
    kinds.set(kind, now);
    this.cooldowns.set(id, kinds);
    return undefined;
  }

  /** One sink, one event: build the request, send it, translate the outcome into a result + state patch. */
  private async attempt(
    sink: SinkRecord,
    event: NotifyEvent,
    device: string,
    updates: Map<string, Partial<SinkRecord>>,
  ): Promise<DeliveryResult> {
    const at = this.now();
    const request = sink.kind === "ntfy" ? ntfyRequest(sink, event) : webhookRequest(sink, event, at, device);
    const startedAt = Date.now();
    try {
      const response = await this.fetchImpl(sink.url, {
        method: "POST",
        headers: request.headers,
        body: request.body,
        signal: AbortSignal.timeout(this.timeoutMs),
        // R19 (run-5 h7, leader-confirmed): without this, a sink host's 3xx
        // re-aims the daemon's POST at any loopback/LAN/metadata host the
        // create-time private-host guard refuses — the redirect target is
        // never re-validated. Refuse redirects like every other egress fetch
        // in this repo (tunnel, pairing, jev, hub transport).
        redirect: "error",
      });
      const ms = Date.now() - startedAt;
      const status = typeof response?.status === "number" ? response.status : 0;
      if (response?.ok) {
        updates.set(sink.id, { lastDeliveryAt: at, lastStatus: status, lastError: undefined });
        return { id: sink.id, kind: sink.kind, status: "sent", detail: `HTTP ${status}`, ms };
      }
      const detail = `HTTP ${status}`;
      updates.set(sink.id, { lastDeliveryAt: at, lastStatus: status, lastError: detail });
      return { id: sink.id, kind: sink.kind, status: "failed", detail, ms };
    } catch (error) {
      // Includes the AbortSignal.timeout rejection: a hung sink is a failed
      // sink, and the next event in the window will not retry it.
      const ms = Date.now() - startedAt;
      const detail = truncate(describeError(error));
      updates.set(sink.id, { lastDeliveryAt: at, lastError: detail });
      this.warn(`delivery to ${sink.id} (${sink.kind}) failed: ${detail}`, error);
      return { id: sink.id, kind: sink.kind, status: "failed", detail, ms };
    }
  }

  private async load(): Promise<void> {
    // Same guard as `Store.open`: the data dir holds credentials-adjacent state,
    // so it is created 0700 or tightened before a single byte is written into it.
    ensurePrivateDir(dirname(this.filePath));
    const now = this.now();

    const main = await readRegistryFile(this.filePath, now);
    if (main.ok) {
      this.adopt(main.records);
      this.mainIsGood = true;
      return;
    }
    if (main.missing) return; // no sinks configured yet: nothing to load, nothing to complain about

    this.warn(`${this.filePath} is unusable (${describeError(main.error)}); moving it aside`);
    await this.setAside();

    const backup = await readRegistryFile(this.backupPath, now);
    if (backup.ok) {
      this.adopt(backup.records);
      this.warn(`recovered ${backup.records.length} sink(s) from ${this.backupPath}`);
      return;
    }
    if (!backup.missing) this.warn(`${this.backupPath} is unusable too; starting with no sinks`);
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

  private adopt(records: readonly SinkRecord[]): void {
    this.records.clear();
    for (const record of records) this.records.set(record.id, record);
  }

  /** Stage → persist → swap. A failed write leaves memory exactly as it was. */
  private async commit(staged: Map<string, SinkRecord>): Promise<void> {
    await this.persist([...staged.values()]);
    this.records = staged;
  }

  /**
   * Delivery state only, merged onto whatever the registry holds *now* — a
   * `create` that landed while the requests were in flight must not be lost by a
   * stale copy of the map.
   */
  private async commitDeliveryState(updates: Map<string, Partial<SinkRecord>>): Promise<void> {
    try {
      await this.run(async () => {
        const staged = new Map(this.records);
        let changed = false;
        for (const [id, patch] of updates) {
          const existing = staged.get(id);
          if (!existing) continue; // removed mid-delivery: nothing to record
          const next: SinkRecord = { ...existing, ...patch };
          if (patch.lastError === undefined) delete next.lastError;
          else next.lastError = truncate(patch.lastError);
          staged.set(id, next);
          changed = true;
        }
        if (changed) await this.commit(staged);
      });
    } catch (error) {
      // `deliver` promised not to throw; the delivery itself already happened.
      this.warn(`could not record delivery state in ${this.filePath}`, error);
    }
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
  private async persist(records: readonly SinkRecord[]): Promise<void> {
    const dir = dirname(this.filePath);
    ensurePrivateDir(dir); // re-tightened on every write, like the pairing files
    if (this.mainIsGood) await this.backUpMain();

    const payload = `${JSON.stringify(
      { version: NOTIFY_REGISTRY_VERSION, sinks: [...records] } satisfies NotifyRegistryFile,
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

const truncate = (message: string): string =>
  message.length > MAX_ERROR_LENGTH ? `${message.slice(0, MAX_ERROR_LENGTH - 1)}…` : message;

/**
 * The webhook wire shape: `{ event, title, body, at, device }` plus the event's
 * `data` merged in at the top level ("delivered as-is"). The five base fields win
 * a collision — a webhook consumer keys on `event`, so `data` cannot rewrite it.
 * `at` is epoch ms, the same clock the registry timestamps use.
 */
function webhookRequest(
  sink: SinkRecord,
  event: NotifyEvent,
  at: number,
  device: string,
): { headers: Record<string, string>; body: string } {
  const payload: Record<string, unknown> = {
    ...(event.data ?? {}),
    event: event.kind,
    title: event.title,
    body: event.body,
    at,
    device,
  };
  return {
    headers: { "content-type": "application/json" },
    body: JSON.stringify(payload),
  };
}

/**
 * ntfy's documented HTTP shape: the message is the raw-ish body and everything
 * else rides in headers — `Title`, `Priority`, `Tags` (comma-joined). The topic
 * is the sink URL's path; the body falls back to the title because ntfy rejects
 * an empty message.
 */
function ntfyRequest(sink: SinkRecord, event: NotifyEvent): { headers: Record<string, string>; body: string } {
  const headers: Record<string, string> = {
    "content-type": "text/plain; charset=utf-8",
    title: encodeHeader(event.title || sink.label || event.kind),
  };
  if (sink.priority) headers.priority = sink.priority;
  if (sink.tags && sink.tags.length > 0) headers.tags = sink.tags.join(",");
  return { headers, body: event.body.trim() || event.title || event.kind };
}

/** Header values are bytes on the wire: newlines would split the message, so they become spaces. */
const encodeHeader = (value: string): string => value.replace(/[\r\n]+/g, " ").slice(0, 200);
