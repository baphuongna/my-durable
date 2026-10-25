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
 */
import { accessSync, existsSync, readFileSync } from "node:fs";
import { access, chmod, mkdir, readFile, writeFile } from "node:fs/promises";
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
import { zipSync, type ZipEntry } from "./zip.js";

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
}

/** The `GET /v1/...` routes that become json sections, in bundle order. */
const API_SECTIONS: ReadonlyArray<{ name: string; route: string }> = [
  { name: "device.json", route: "/v1/device" },
  { name: "vitals.json", route: "/v1/device/vitals" },
  { name: "env.json", route: "/v1/device/env" },
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
    fetchImpl: async (url, init) => {
      const res = await io.fetch(url, init);
      return { ok: res.ok, status: res.status, json: async () => JSON.parse(await res.text()) };
    },
    access: io.accessSync,
    exists: io.existsSync,
    readFile: io.readFileSync,
    homedir: io.homedir,
  };
}

/** One JSON section from the device API: ok → redacted body; failure → `{"error": ...}` and the bundle carries on. */
async function apiSection(
  io: DiagnosticsIo,
  url: string,
  route: string,
  headers: Record<string, string>,
): Promise<{ text: string; ok: boolean; error?: string }> {
  let ok: boolean;
  let status: number;
  let raw: string;
  try {
    const res = await io.fetch(url, { headers, signal: AbortSignal.timeout(SECTION_TIMEOUT_MS) });
    ok = res.ok;
    status = res.status;
    raw = await res.text();
  } catch (error) {
    const detail = describeError(error, SECTION_TIMEOUT_MS);
    return { text: jsonText({ error: `GET ${route} unreachable — ${detail}` }), ok: false, error: detail };
  }
  if (!ok) {
    return { text: jsonText({ error: `GET ${route} → ${status}` }), ok: false, error: String(status) };
  }
  let body: unknown;
  try {
    body = JSON.parse(raw);
  } catch {
    return { text: jsonText({ error: `GET ${route} → non-JSON body` }), ok: false, error: "non-JSON body" };
  }
  return { text: jsonText(redactJson(body)), ok: true };
}

/** The device.log tail: last 400 lines, redacted. Missing → skipped (undefined); unreadable → a failed section. */
async function logSection(io: DiagnosticsIo, home: string): Promise<{ text: string; ok: boolean; error?: string } | undefined> {
  const logPath = join(home, "device.log");
  if (!(await io.exists(logPath))) return undefined;
  let raw: string;
  try {
    raw = await io.readFile(logPath);
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
    entries.push({ path: name, text });
    sections.push({ name, ok, bytes: Buffer.byteLength(text, "utf8"), ...(error ? { error } : {}) });
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

  // the seven registry/summary routes — summaries by design (no transcripts)
  for (const section of API_SECTIONS) {
    const r = await apiSection(io, `${cfg.baseUrl}${section.route}`, section.route, headers);
    push(section.name, r.text, r.ok, r.error);
  }

  // device.log — on-disk facts, tail only, redacted
  {
    const r = await logSection(io, home);
    if (r) push("device.log", r.text, r.ok, r.error);
  }

  // The manifest is entry 0 (backup.ts's rule), so it lists the sections that
  // actually made it in — including device.log only when the log was there.
  const manifest = redactJson({
    createdAt: new Date(io.now()).toISOString(),
    packageVersion: PACKAGE_VERSION,
    node: io.nodeVersion,
    platform: process.platform,
    arch: process.arch,
    home,
    sections: sections.map((s) => s.name),
  });
  entries.unshift({ path: "manifest.json", text: jsonText(manifest) });
  sections.unshift({ name: "manifest.json", ok: true, bytes: Buffer.byteLength(jsonText(manifest), "utf8") });

  const zip = zipSync(entries, new Date(io.now()));
  await io.mkdir(dirname(out), DIR_MODE);
  await io.writeFile(out, zip, FILE_MODE);
  await io.chmod(out, FILE_MODE);
  return { path: out, sections, bytes: zip.length };
}
