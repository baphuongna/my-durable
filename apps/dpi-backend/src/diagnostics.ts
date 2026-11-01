/**
 * `dpi diagnostics` — a redacted diagnostic bundle as one zip — "Diagnostic
 * bundle" (SHOULD), Wave 3 of docs/host-project-checklist.md.
 *
 * Modelled on orca's PrivacyDiagnosticBundleControls idea: everything an
 * operator would paste into a bug report, with secrets stripped. Every text
 * that enters the bundle passes `redact`/`redactJson` (dpi_ tokens, Bearer
 * headers, sk-/pk-/rk- keys, and any 32+ char token-shaped run); the bundle
 * contains no transcripts by construction, so the raw-long-run rule cannot
 * eat base64 payload it was never meant to see.
 *
 * Each section is INDEPENDENT: one that fails records `{"error": ...}` and the
 * bundle still builds — a broken device is exactly when diagnostics matter
 * most. The API sections talk to the LOCAL device the same way `dpi doctor`
 * does (`deviceEndpoint` + `authHeaders`, `$DPI_HOST|$DPI_PORT`, token from
 * the env file), and `doctor.json` is literally doctor's runner re-run through
 * this module's io — not a reimplementation.
 *
 * Every fs/clock/network access goes through `DiagnosticsIo` (the `backup.ts`
 * pattern: async fs + injectable fetch + clock). doctor.ts's own fs surface is
 * synchronous (`existsSync`/`readFileSync`/`accessSync`), so the io carries
 * that surface too and `diagnosticsDoctorIo` bridges the two worlds — one
 * object to fake in tests, never the real fs or network.
 *
 * R9 caps (run-8 u7): every collected byte has a ceiling — device.log is read
 * tail-bounded (`readFileTail`, at most DEVICE_LOG_TAIL_BYTES off disk), API
 * bodies over API_BODY_MAX_BYTES are refused unparsed, every section's final
 * text is capped at SECTION_MAX_BYTES with an explicit truncation marker, and
 * the whole bundle answers to BUNDLE_MAX_BYTES export-refusal style. The
 * `shareable` mode goes further: no device.log at all and env VALUES hard-
 * redacted — the operator-shareable bundle never carries env/log payloads.
 */
import { accessSync, existsSync, readFileSync } from "node:fs";
import { access, chmod, mkdir, open, readFile, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";
import {
  authHeaders,
  defaultDoctorIo,
  describeError,
  deviceEndpoint,
  expand,
  runDoctor,
  type DoctorIo,
} from "./doctor.js";
import { PACKAGE_VERSION } from "./store.js";
import { zipRawBytes, zipSync, type ZipEntry } from "./zip.js";

export type DiagnosticsErrorCode = "invalid";

/** Typed failure, same shape as `BackupError`: a CLI picks its exit code from `code`, not from message matching. */
export class DiagnosticsError extends Error {
  readonly code: DiagnosticsErrorCode;

  constructor(code: DiagnosticsErrorCode, message: string) {
    super(message);
    this.name = "DiagnosticsError";
    this.code = code;
  }
}

const invalid = (message: string) => new DiagnosticsError("invalid", message);

/** The io carries the same 0700/0600 rule `backup.ts` does (`ensurePrivateDir` is sync and not injectable). */
const DIR_MODE = 0o700;
const FILE_MODE = 0o600;
/** Per-section fetch budget: a hung device must not hang the bundle. */
const SECTION_TIMEOUT_MS = 10_000;
/** The device.log tail: the last 400 lines, never the whole file. */
export const DEVICE_LOG_LINES = 400;

// ------------------------------------------------------------------ R9 caps
// The run-8 u7 finding: a hostile device (or a huge log) could blow up RAM and
// the bundle — whole device.log into RAM, uncapped apiSection bodies, zipSync
// with no total ceiling. Every collected byte now has a ceiling:

/** Max UTF-8 bytes of any ONE section's final text (post-redaction, pre-zip). */
export const SECTION_MAX_BYTES = 256 * 1024;
/** Max raw bytes of an API response body BEFORE it is parsed — bounds the
 * JSON.parse amplification a hostile device could otherwise force. */
export const API_BODY_MAX_BYTES = 512 * 1024;
/** Max raw bytes ever read from device.log — the tail read's ceiling. */
export const DEVICE_LOG_TAIL_BYTES = 512 * 1024;
/** Aggregate ceiling: total raw section bytes (and, as a backstop, the zipped
 * bytes) a bundle may hold. With per-section caps this cannot trip in practice
 * — it is the named backstop the same style zip.ts's export guards use. */
export const BUNDLE_MAX_BYTES = 8 * 1024 * 1024;

/** Byte-safe truncation with an explicit marker — a section never silently
 * exceeds its ceiling. The marker's bytes come out of the budget, so the
 * truncated text is still ≤ maxBytes. */
function capSectionText(name: string, text: string): { text: string; truncated: boolean } {
  if (Buffer.byteLength(text, "utf8") <= SECTION_MAX_BYTES) return { text, truncated: false };
  const marker = `\n[${name}: truncated at ${SECTION_MAX_BYTES} bytes]\n`;
  const budget = Math.max(0, SECTION_MAX_BYTES - Buffer.byteLength(marker, "utf8"));
  // subarray + toString drops an invalid trailing multibyte fragment
  const cut = Buffer.from(text, "utf8").subarray(0, budget).toString("utf8");
  return { text: `${cut}${marker}`, truncated: true };
}

/** Shareable bundles never carry env VALUES: every string becomes a fixed
 * marker (key names stay — they are schema, and what a bug report needs). */
function hardRedactValues(value: unknown): unknown {
  if (typeof value === "string") return "«redacted»";
  if (Array.isArray(value)) return value.map(hardRedactValues);
  if (value && typeof value === "object") {
    const out: Record<string, unknown> = {};
    for (const [key, entry] of Object.entries(value as Record<string, unknown>)) out[key] = hardRedactValues(entry);
    return out;
  }
  return value;
}

/** Narrow fetch surface, `doctor.ts`'s init shape so its checks pass through unchanged. */
export interface DiagnosticsFetchInit {
  method?: string;
  headers?: Record<string, string>;
  body?: string;
  signal?: AbortSignal;
}

export interface DiagnosticsResponse {
  ok: boolean;
  status: number;
  text(): Promise<string>;
}

export interface DiagnosticsIo {
  readFile(path: string): Promise<string>;
  /** R9 tail-bounded read: at most `maxBytes` from the END of the file,
   * line-aligned (a partial first line is dropped — tail semantics). Optional
   * for io compatibility; production's default io implements it, and callers
   * without it fall back to `readFile` (still line- and byte-capped after). */
  readFileTail?(path: string, maxBytes: number): Promise<string>;
  /** `mode` applies when the file is created; an explicit `chmod` follows, like backup.ts's persist. */
  writeFile(path: string, data: Uint8Array, mode?: number): Promise<void>;
  chmod(path: string, mode: number): Promise<void>;
  /** Recursive; `mode` (0700 by default) applies to the directories it creates. */
  mkdir(path: string, mode?: number): Promise<void>;
  exists(path: string): Promise<boolean>;
  fetch(url: string, init?: DiagnosticsFetchInit): Promise<DiagnosticsResponse>;
  now(): number;
  env: Record<string, string | undefined>;
  homedir: () => string;
  nodeVersion: string;
  /** doctor.ts's fs surface is synchronous; the io carries it so `runDoctor` runs through the same fake. */
  existsSync(path: string): boolean;
  readFileSync(path: string): string;
  accessSync(path: string, mode?: number): void;
}

export const defaultDiagnosticsIo = (): DiagnosticsIo => ({
  readFile: (path) => readFile(path, "utf8"),
  writeFile: (path, data, mode) => writeFile(path, data, { mode }),
  chmod: (path, mode) => chmod(path, mode),
  // fs/promises mkdir(recursive) resolves with the first created path — dropped, the io promises void.
  mkdir: async (path, mode) => {
    await mkdir(path, { recursive: true, mode: mode ?? DIR_MODE });
  },
  exists: async (path) => {
    try {
      await access(path);
      return true;
    } catch {
      return false;
    }
  },
  // R9: never read a whole file to keep its tail — stat, then read only the
  // last maxBytes (a file at or under the ceiling still comes back whole).
  readFileTail: async (path, maxBytes) => {
    const handle = await open(path, "r");
    try {
      const { size } = await handle.stat();
      if (size <= maxBytes) return await handle.readFile("utf8");
      const buf = Buffer.alloc(maxBytes);
      await handle.read(buf, 0, maxBytes, size - maxBytes);
      const text = buf.toString("utf8");
      const nl = text.indexOf("\n");
      return nl >= 0 ? text.slice(nl + 1) : text; // drop the partial first line
    } finally {
      await handle.close();
    }
  },
  fetch: (url, init) => fetch(url, init as RequestInit | undefined),
  now: () => Date.now(),
  env: process.env as Record<string, string | undefined>,
  homedir,
  existsSync,
  readFileSync: (path) => readFileSync(path, "utf8"),
  accessSync,
  nodeVersion: process.versions.node,
});

// ---------------------------------------------------------------- redaction

/**
 * Mask secret-shaped runs in any text: dpi_ tokens, bearer headers, long
 * key-looking strings. Order matters — the prefixed shapes run first so the
 * raw 32+ catch-all only sees what is left. NEVER the words themselves, only
 * the values.
 */
export function redact(text: string): string {
  return text
    .replace(/dpi_[A-Za-z0-9_-]{20,}/g, "dpi_••••")
    .replace(/Bearer\s+[A-Za-z0-9._-]{16,}/g, "Bearer ••••")
    .replace(/\b(sk|pk|rk)-[A-Za-z0-9]{16,}/g, "$1-••••")
    .replace(/[A-Za-z0-9_-]{32,}/g, "••••");
}

/** Walk a parsed JSON value and redact every string in it (values, not keys — keys are schema). */
export function redactJson(value: unknown): unknown {
  if (typeof value === "string") return redact(value);
  if (Array.isArray(value)) return value.map(redactJson);
  if (value && typeof value === "object") {
    const out: Record<string, unknown> = {};
    for (const [key, entry] of Object.entries(value as Record<string, unknown>)) out[key] = redactJson(entry);
    return out;
  }
  return value;
}

// ----------------------------------------------------------------- sections

/** One zip entry plus the outcome the CLI prints. */
export interface DiagnosticsSection {
  name: string;
  ok: boolean;
  bytes: number;
  /** Present when the section failed: what the CLI prints after the colon. */
  error?: string;
  /** Present when the section's text was capped at SECTION_MAX_BYTES. */
  truncated?: boolean;
}

/** The `GET /v1/...` routes that become json sections, in bundle order. `shareable`
 * marks sections whose VALUES never enter a shareable bundle (env). */
const API_SECTIONS: ReadonlyArray<{ name: string; route: string; shareable?: boolean }> = [
  { name: "device.json", route: "/v1/device" },
  { name: "vitals.json", route: "/v1/device/vitals" },
  { name: "env.json", route: "/v1/device/env", shareable: true },
  { name: "sessions.json", route: "/v1/sessions" },
  { name: "projects.json", route: "/v1/projects" },
  { name: "schedules.json", route: "/v1/schedules" },
  { name: "notify.json", route: "/v1/notify/sinks" },
];

const jsonText = (value: unknown): string => `${JSON.stringify(value, null, 2)}\n`;

/** `runDoctor` over this module's io: same checks, same fakes, doctor's own timeouts and engine floor. */
function diagnosticsDoctorIo(io: DiagnosticsIo): DoctorIo {
  return {
    ...defaultDoctorIo(),
    env: io.env,
    nodeVersion: io.nodeVersion,
    // doctor's FetchLike wants json(); this io speaks text() — adapt, never reimplement.
    // r10 h2-1: the adapter used to res.text() the WHOLE body — the doctor
    // section was the one diagnostics read that bypassed the R9 byte caps
    // ("duration is not a byte budget"). Route through the capped reader.
    fetchImpl: async (url, init) => {
      const res = await io.fetch(url, init);
      return {
        ok: res.ok,
        status: res.status,
        json: async () => {
          const raw = await readCappedBody(res, API_BODY_MAX_BYTES);
          if (raw.length > API_BODY_MAX_BYTES) throw Error(`doctor body over ${API_BODY_MAX_BYTES} bytes`);
          return JSON.parse(raw);
        },
      };
    },
    access: io.accessSync,
    exists: io.existsSync,
    readFile: io.readFileSync,
    homedir: io.homedir,
  };
}

/** One JSON section from the device API: ok → redacted body; failure → `{"error": ...}` and the bundle carries on.
 * R9: a body over API_BODY_MAX_BYTES is refused with the size named — it is
 * never parsed — and a `shareable` section's string VALUES never survive. */
async function apiSection(
  io: DiagnosticsIo,
  url: string,
  route: string,
  headers: Record<string, string>,
  opts: { hardRedact?: boolean } = {},
): Promise<{ text: string; ok: boolean; error?: string }> {
  let ok: boolean;
  let status: number;
  let raw: string;
  try {
    const res = await io.fetch(url, { headers, signal: AbortSignal.timeout(SECTION_TIMEOUT_MS) });
    ok = res.ok;
    status = res.status;
    // R9 cold review: never buffer the whole body before the cap — a hostile
    // device can stream gigabytes inside the 10s section timeout (duration is
    // not a byte budget). Precheck content-length, then read at most the cap.
    const declared = Number(res.headers?.get?.("content-length") ?? "");
    if (Number.isFinite(declared) && declared > API_BODY_MAX_BYTES) {
      const detail = `body over ${API_BODY_MAX_BYTES} bytes (content-length ${declared})`;
      return { text: jsonText({ error: `GET ${route} → ${detail}` }), ok: false, error: detail };
    }
    raw = await readCappedBody(res, API_BODY_MAX_BYTES);
  } catch (error) {
    const detail = describeError(error, SECTION_TIMEOUT_MS);
    return { text: jsonText({ error: `GET ${route} unreachable — ${detail}` }), ok: false, error: detail };
  }
  if (!ok) {
    return { text: jsonText({ error: `GET ${route} → ${status}` }), ok: false, error: String(status) };
  }
  if (Buffer.byteLength(raw, "utf8") > API_BODY_MAX_BYTES) {
    const detail = `body over ${API_BODY_MAX_BYTES} bytes`;
    return { text: jsonText({ error: `GET ${route} → ${detail}` }), ok: false, error: detail };
  }
  let body: unknown;
  try {
    body = JSON.parse(raw);
  } catch {
    return { text: jsonText({ error: `GET ${route} → non-JSON body` }), ok: false, error: "non-JSON body" };
  }
  return { text: jsonText(redactJson(opts.hardRedact ? hardRedactValues(body) : body)), ok: true };
}

/** Read at most `cap` bytes off the wire, cancelling the stream past that (R9
 * cold-review finding 1: the old `res.text()` buffered the entire body first).
 * Non-stream bodies (test mocks) fall back to `text()` — the post-read byte
 * check still refuses those. Over-cap returns a `cap+1`-byte marker string so
 * the existing refusal names the cap without having buffered the payload. */
async function readCappedBody(
  res: { body?: unknown; text(): Promise<string> },
  cap: number,
): Promise<string> {
  const body = res.body as ReadableStream<Uint8Array> | undefined;
  if (!body || typeof body.getReader !== "function") return res.text();
  const reader = body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    total += value.byteLength;
    chunks.push(value);
    if (total > cap) {
      try {
        await reader.cancel();
      } catch {
        /* already closed */
      }
      return "\u0000".repeat(cap + 1); // marker: byteLength === cap+1 → the refusal fires
    }
  }
  const merged = new Uint8Array(total);
  let off = 0;
  for (const c of chunks) {
    merged.set(c, off);
    off += c.byteLength;
  }
  return new TextDecoder("utf-8").decode(merged);
}

/** The device.log tail: last 400 lines, redacted. Missing → skipped (undefined); unreadable → a failed section.
 * R9: the READ is tail-bounded — at most DEVICE_LOG_TAIL_BYTES raw bytes come
 * off disk (io.readFileTail); ios without the tail surface fall back to
 * readFile, and the per-section cap still bounds what enters the bundle. */
async function logSection(io: DiagnosticsIo, home: string): Promise<{ text: string; ok: boolean; error?: string } | undefined> {
  const logPath = join(home, "device.log");
  if (!(await io.exists(logPath))) return undefined;
  let raw: string;
  try {
    raw = io.readFileTail ? await io.readFileTail(logPath, DEVICE_LOG_TAIL_BYTES) : await io.readFile(logPath);
  } catch (error) {
    const detail = describeError(error, 0);
    return { text: `# cannot read ${logPath}: ${detail}\n`, ok: false, error: detail };
  }
  const lines = raw.split(/\r?\n/);
  if (lines.length && lines[lines.length - 1] === "") lines.pop(); // the split's trailing "" is not a line
  const tail = lines.slice(-DEVICE_LOG_LINES);
  return { text: tail.length ? `${redact(tail.join("\n"))}\n` : "", ok: true };
}

// ----------------------------------------------------------------- collect

export interface CollectDiagnosticsOptions {
  home: string;
  out: string;
  /** R9 shareable mode: the bundle operators paste into bug reports. Strips
   * device.log entirely (not even read) and hard-redacts env section values —
   * the run-8 "redaction boundary no unit owns" now has an owner. Default
   * false: the local bundle keeps the (masked) log and env sections. */
  shareable?: boolean;
  /** R9 aggregate-ceiling override (raw section bytes); tests use tiny values
   * to prove enforcement. Default BUNDLE_MAX_BYTES. */
  maxBundleBytes?: number;
}

export interface CollectDiagnosticsResult {
  path: string;
  sections: DiagnosticsSection[];
  /** Total zip size in bytes — the CLI's "total". */
  bytes: number;
}

/**
 * Collect the bundle into `opts.out` (0600, parent dirs 0700) and touch nothing
 * else. The timestamped default name is the CLI's decision, not this module's.
 */
export async function collectDiagnostics(
  io: DiagnosticsIo,
  opts: CollectDiagnosticsOptions,
): Promise<CollectDiagnosticsResult> {
  if (!opts.home) throw invalid("home is required");
  if (!opts.out) throw invalid("out is required");
  const home = resolve(expand(opts.home, io.homedir()));
  const out = resolve(expand(opts.out, io.homedir()));

  // The device API the way doctor sees it: $DPI_HOST|$DPI_PORT, token from the env file.
  const doctorIo = diagnosticsDoctorIo(io);
  const cfg = deviceEndpoint(doctorIo);
  const headers = authHeaders(cfg.token);

  const sections: DiagnosticsSection[] = [];
  const entries: ZipEntry[] = [];
  const push = (name: string, text: string, ok: boolean, error?: string): void => {
    // R9: every section is byte-capped on its way in — the marker is explicit.
    const capped = capSectionText(name, text);
    entries.push({ path: name, text: capped.text });
    sections.push({
      name,
      ok,
      bytes: Buffer.byteLength(capped.text, "utf8"),
      ...(error ? { error } : {}),
      ...(capped.truncated ? { truncated: true } : {}),
    });
  };

  // doctor.json — doctor's own runner, through this module's io.
  {
    let report: unknown;
    let ok = true;
    let error: string | undefined;
    try {
      report = redactJson(await runDoctor(doctorIo));
    } catch (e) {
      error = describeError(e, 0);
      report = { error: `doctor failed — ${error}` };
      ok = false;
    }
    push("doctor.json", jsonText(report), ok, error);
  }

  // the seven registry/summary routes — summaries by design (no transcripts);
  // env values are hard-redacted in shareable mode
  for (const section of API_SECTIONS) {
    const r = await apiSection(io, `${cfg.baseUrl}${section.route}`, section.route, headers, {
      hardRedact: Boolean(section.shareable && opts.shareable),
    });
    push(section.name, r.text, r.ok, r.error);
  }

  // device.log — on-disk facts, tail only, redacted; NEVER in a shareable bundle
  if (!opts.shareable) {
    const r = await logSection(io, home);
    if (r) push("device.log", r.text, r.ok, r.error);
  }

  // The manifest is entry 0 (backup.ts's rule), so it lists the sections that
  // actually made it in — including device.log only when the log was there.
  // R9: it is a section like any other, so it passes the same byte cap.
  const manifest = redactJson({
    createdAt: new Date(io.now()).toISOString(),
    packageVersion: PACKAGE_VERSION,
    node: io.nodeVersion,
    platform: process.platform,
    arch: process.arch,
    home,
    sections: sections.map((s) => s.name),
  });
  const manifestCapped = capSectionText("manifest.json", jsonText(manifest));
  entries.unshift({ path: "manifest.json", text: manifestCapped.text });
  sections.unshift({
    name: "manifest.json",
    ok: true,
    bytes: Buffer.byteLength(manifestCapped.text, "utf8"),
    ...(manifestCapped.truncated ? { truncated: true } : {}),
  });

  // R9 aggregate ceiling — the refusal style zip.ts's export guards use: the
  // size is named and nothing is written. With per-section caps this cannot
  // trip at defaults; it is the backstop that makes that true by construction.
  const ceiling = opts.maxBundleBytes ?? BUNDLE_MAX_BYTES;
  const rawBytes = zipRawBytes(entries);
  if (rawBytes > ceiling)
    throw invalid(`diagnostic bundle refused: sections are ${rawBytes} bytes, over the ${ceiling} byte ceiling`);

  const zip = zipSync(entries, new Date(io.now()));
  if (zip.length > ceiling)
    throw invalid(`diagnostic bundle refused: zip is ${zip.length} bytes, over the ${ceiling} byte ceiling`);
  await io.mkdir(dirname(out), DIR_MODE);
  await io.writeFile(out, zip, FILE_MODE);
  await io.chmod(out, FILE_MODE);
  return { path: out, sections, bytes: zip.length };
}
