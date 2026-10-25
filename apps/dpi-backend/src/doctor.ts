/**
 * `dpi doctor` — one-shot health check for THIS machine's device.
 *
 * Five checks, each printed as ok / warn / fail / skip with a one-line detail:
 *
 *   1. node          — the one hard block in the project (>= 22.19.0, the
 *                      engines floor; the comparison is `satisfiesEngine` from
 *                      bin/update.mjs so both surfaces cannot drift).
 *   2. healthz       — is the device daemon actually answering on its port.
 *   3. start_dirs    — every configured start dir must exist and be writable;
 *                      a device whose sessions cannot write is a broken device.
 *   4. model probe   — the local-only `/v1/device/probe-model` route. A dead
 *                      provider is a WARN, never a fail: the UI rotates past
 *                      dead providers, and doctor is not a provider pager.
 *   5. hub           — the paired/configured hub's /healthz, only when this
 *                      device has a hub at all (otherwise `skip`).
 *
 * Exit code: 1 when any check FAILED, 0 otherwise (warnings included).
 * Everything is injectable (env, fetch, fs, node version) so the unit tests run
 * against fakes and never touch the network or the real filesystem.
 */
import { accessSync, constants as fsConstants, existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { basename, join, resolve } from "node:path";
// Reuse the updater's engine comparison instead of a second semver implementation.
import { satisfiesEngine } from "../../../bin/update.mjs";
import { listCrashReports } from "./crash.js";

export type DoctorStatus = "ok" | "warn" | "fail" | "skip";

export interface DoctorCheck {
  id: string;
  label: string;
  status: DoctorStatus;
  /** One line, already human shaped — the printer adds nothing but the marker. */
  detail: string;
}

export interface DoctorReport {
  checks: DoctorCheck[];
  /** False when at least one check FAILED (warnings do not fail a report). */
  ok: boolean;
}

/** The floor from package.json `engines` — declared here so a test can lower it. */
export const REQUIRED_NODE = ">=22.19.0";

/** The check ids in report order — stable for machine consumers.
 *  (start dirs carry an index suffix when more than one is configured.) */
export const DOCTOR_HEALTH_IDS = ["node", "healthz", "start_dir", "model_probe", "hub"] as const;

/** Narrow fetch surface: fakes stay three lines, no Response mock needed. */
export interface HttpResponse {
  ok: boolean;
  status: number;
  json(): Promise<unknown>;
}
export type FetchLike = (
  url: string,
  init?: { method?: string; headers?: Record<string, string>; body?: string; signal?: AbortSignal },
) => Promise<HttpResponse>;

export interface DoctorIo {
  env: Record<string, string | undefined>;
  nodeVersion: string;
  fetchImpl: FetchLike;
  /** fs.accessSync-shaped: throws when the path is missing or not writable. */
  access: (path: string, mode?: number) => void;
  exists: (path: string) => boolean;
  readFile: (path: string) => string;
  homedir: () => string;
  /** healthz timeout. */
  timeoutMs: number;
  /** The hub may be across an ocean and behind TLS — a loopback-sized timeout would lie. */
  hubTimeoutMs: number;
  /** probe-model timeout: it runs one throwaway turn, so it is not a health ping. */
  probeTimeoutMs: number;
  requiredNode: string;
}

const realFetch: FetchLike = async (url, init) => fetch(url, init as RequestInit);

export const defaultDoctorIo = (): DoctorIo => ({
  env: process.env,
  nodeVersion: process.versions.node,
  fetchImpl: realFetch,
  access: (path, mode) => accessSync(path, mode),
  exists: existsSync,
  readFile: (path) => readFileSync(path, "utf8"),
  homedir,
  timeoutMs: 3_000,
  /** The hub may be across an ocean, behind TLS and a cold proxy — 8s keeps the
   *  check honest without turning flaky latency into daily warnings. */
  hubTimeoutMs: 8_000,
  probeTimeoutMs: 60_000,
  requiredNode: REQUIRED_NODE,
});

// --------------------------------------------------------------- config bits

/** `~` / `~/x` expansion — same rule as config.ts and daemon.ts. */
export const expand = (p: string, hd: string = homedir()): string =>
  p === "~" ? hd : p.startsWith("~/") ? join(hd, p.slice(2)) : p;

/**
 * The start dirs exactly as `config.ts` sees them: ":"-separated, expanded and
 * resolved. Doctor must report the dirs the DEVICE uses, so the rule is copied
 * rather than invented (a comma is not a separator for the device either).
 */
export const parseStartDirs = (raw: string, hd: string = homedir()): string[] =>
  raw
    .split(":")
    .filter(Boolean)
    .map((p) => resolve(expand(p, hd)));

/** KEY=VALUE lines of backend.env (the daemon's own file, no shell quoting). */
export function readEnvFile(text: string): Record<string, string> {
  const out: Record<string, string> = {};
  for (const line of text.split(/\r?\n/)) {
    const m = /^\s*(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)$/.exec(line);
    if (!m) continue;
    out[m[1]] = m[2].trim().replace(/^(['"])(.*)\1$/, "$2");
  }
  return out;
}

/** "provider/modelId" → the two halves probe-model wants. OpenRouter ids carry their own slash. */
export function splitModel(
  defaultModel: string,
  models?: ReadonlyArray<{ provider: string; id: string }>,
): { provider: string; modelId: string } | undefined {
  const exact = models?.find((m) => `${m.provider}/${m.id}` === defaultModel);
  if (exact) return { provider: exact.provider, modelId: exact.id };
  const i = defaultModel.indexOf("/");
  if (i <= 0 || i === defaultModel.length - 1) return undefined;
  return { provider: defaultModel.slice(0, i), modelId: defaultModel.slice(i + 1) };
}

/** Why a request failed, in words an operator can act on. */
export function describeError(error: unknown, ms: number): string {
  const e = error as { name?: string; message?: string; cause?: { code?: string; message?: string } };
  const cause = e?.cause?.code ?? e?.cause?.message;
  if (e?.name === "TimeoutError" || e?.name === "AbortError") return `timed out after ${ms}ms`;
  const message = e?.message ?? String(error);
  if (!cause || message.includes(cause)) return message;
  return `${message} (${cause})`;
}

// ------------------------------------------------------------------- checks

/** Where the local device is and how to authenticate — shared by every CLI that
 *  talks to it (`dpi doctor`, `dpi schedule`). */
export interface DeviceEndpoint {
  /** process env wins over the env file, like loadConfig's `process.loadEnvFile`. */
  env: Record<string, string | undefined>;
  home: string;
  envFile: string;
  token: string;
  baseUrl: string;
}

export function deviceEndpoint(io: DoctorIo): DeviceEndpoint {
  const hd = io.homedir();
  // `||` not `??`: an empty DPI_HOME/DPI_ENV_FILE means "unset", never the cwd.
  const home = resolve(expand(io.env.DPI_HOME || join(hd, ".dpi"), hd));
  const envFile = resolve(expand(io.env.DPI_ENV_FILE || join(home, "backend.env"), hd));
  let fileEnv: Record<string, string> = {};
  if (io.exists(envFile)) {
    try {
      fileEnv = readEnvFile(io.readFile(envFile));
    } catch {
      /* unreadable env file: fall back to process env */
    }
  }
  const env: Record<string, string | undefined> = { ...fileEnv, ...io.env };
  const host = env.DPI_HOST || "127.0.0.1";
  // A device listening on every interface is still reached over loopback here.
  const probeHost = host === "0.0.0.0" || host === "::" ? "127.0.0.1" : host;
  const port = Number(env.DPI_PORT || "4780");
  return {
    env,
    home,
    envFile,
    token: env.DPI_TOKEN || "",
    baseUrl: `http://${probeHost}:${Number.isInteger(port) && port > 0 ? port : 4780}`,
  };
}

export const authHeaders = (token: string): Record<string, string> =>
  token ? { authorization: `Bearer ${token}` } : {};

async function getJson(
  io: DoctorIo,
  url: string,
  headers: Record<string, string>,
  ms: number,
): Promise<{ ok: true; status: number; body: Record<string, unknown> } | { ok: false; detail: string }> {
  let res: HttpResponse;
  try {
    res = await io.fetchImpl(url, { headers, signal: AbortSignal.timeout(ms) });
  } catch (error) {
    return { ok: false, detail: `${url} unreachable — ${describeError(error, ms)}` };
  }
  let body: Record<string, unknown> = {};
  try {
    body = (await res.json()) as Record<string, unknown>;
  } catch {
    /* non-JSON */
  }
  return { ok: true, status: res.status, body };
}

/** 1. node — the only hard block. */
function nodeCheck(io: DoctorIo): DoctorCheck {
  const required = io.requiredNode;
  const status: DoctorStatus = satisfiesEngine(io.nodeVersion, required) ? "ok" : "fail";
  return {
    id: "node",
    label: `node ${io.nodeVersion}`,
    status,
    detail:
      status === "ok"
        ? `satisfies engines node ${required}`
        : `below engines node ${required} — upgrade Node (nvm install --lts / winget upgrade OpenJS.NodeJS.LTS)`,
  };
}

/** 3. start dirs — one check per dir so the failing one is named. */
function startDirChecks(io: DoctorIo, cfg: DeviceEndpoint): DoctorCheck[] {
  const raw = cfg.env.DPI_START_DIRS || "~/dpi-work";
  const dirs = parseStartDirs(raw, io.homedir());
  if (!dirs.length)
    return [{ id: "start_dirs", label: "start dirs", status: "warn", detail: "DPI_START_DIRS is empty — no cwd is browsable or writable" }];
  return dirs.map((dir, i) => {
    const check = (status: DoctorStatus, detail: string): DoctorCheck => ({
      id: `start_dir${dirs.length > 1 ? `_${i + 1}` : ""}`,
      label: `start dir ${dir}`,
      status,
      detail,
    });
    if (!io.exists(dir)) return check("fail", "missing — create it or fix DPI_START_DIRS");
    try {
      io.access(dir, fsConstants.W_OK);
    } catch (error) {
      return check("fail", `not writable — ${describeError(error, 0)}`);
    }
    return check("ok", "writable");
  });
}

/** 4. model probe — the device's own default model, through the local-only route. */
async function probeCheck(io: DoctorIo, cfg: DeviceEndpoint, reachable: boolean): Promise<DoctorCheck> {
  const id = "model_probe";
  if (!reachable) return { id, label: "model probe", status: "skip", detail: "device unreachable" };
  if (!cfg.token) return { id, label: "model probe", status: "skip", detail: `no DPI_TOKEN (looked in ${cfg.envFile})` };

  const headers = authHeaders(cfg.token);
  const device = await getJson(io, `${cfg.baseUrl}/v1/device`, headers, Math.min(io.timeoutMs * 2, 10_000));
  if (!device.ok) return { id, label: "model probe", status: "warn", detail: device.detail };
  if (device.status !== 200)
    return {
      id,
      label: "model probe",
      status: "warn",
      detail: `GET /v1/device → ${device.status}${device.status === 401 ? " (token mismatch?)" : ""}`,
    };

  const defaultModel = typeof device.body.defaultModel === "string" ? device.body.defaultModel : "";
  const models = Array.isArray(device.body.models)
    ? (device.body.models as Array<{ provider: string; id: string }>).filter((m) => m && m.provider && m.id)
    : undefined;
  const target = defaultModel ? splitModel(defaultModel, models) : undefined;
  const label = `model probe ${defaultModel || "(no default)"}`;
  if (!target) return { id, label, status: "warn", detail: "device reports no usable defaultModel" };

  let res: HttpResponse;
  try {
    res = await io.fetchImpl(`${cfg.baseUrl}/v1/device/probe-model`, {
      method: "POST",
      headers: { ...headers, "content-type": "application/json" },
      body: JSON.stringify(target),
      signal: AbortSignal.timeout(io.probeTimeoutMs),
    });
  } catch (error) {
    return { id, label, status: "warn", detail: describeError(error, io.probeTimeoutMs) };
  }
  let body: Record<string, unknown> = {};
  try {
    body = (await res.json()) as Record<string, unknown>;
  } catch {
    /* non-JSON */
  }
  if (!res.ok) return { id, label, status: "warn", detail: `probe-model → ${res.status}` };
  const detail = typeof body.detail === "string" && body.detail ? body.detail : body.ok === true ? "answered" : "no answer";
  // A dead provider is a WARN by design: the FE rotates past it, the device is fine.
  if (body.ok === true) return { id, label, status: "ok", detail: detail.slice(0, 160) };
  // Say what the failure means when the device classified it: "wait 30s" is a
  // different instruction from "fix the key" or "pick another model".
  const status = typeof body.status === "string" ? body.status : "error";
  const retryMs = typeof body.retryAfterMs === "number" ? body.retryAfterMs : undefined;
  const meaning =
    status === "rate_limited"
      ? `rate limited${retryMs ? ` — retry in ${Math.max(1, Math.round(retryMs / 1000))}s` : " — retry later"}`
      : status === "auth"
        ? "provider key rejected — fix the credential"
        : status === "missing"
          ? "model not in the provider's catalog"
          : "";
  return {
    id,
    label,
    status: "warn",
    detail: `${detail.slice(0, 110)}${meaning ? ` (${meaning})` : ""}`.slice(0, 200),
  };
}

/** 5. hub — only when this device actually has one. */
async function hubCheck(io: DoctorIo, cfg: DeviceEndpoint): Promise<DoctorCheck> {
  const id = "hub";
  let origin = (cfg.env.DPI_HUB_URL ?? "").trim().replace(/\/+$/, "");
  const source = origin ? "DPI_HUB_URL" : "pairing.json";
  if (!origin) {
    const file = join(cfg.home, "pairing.json");
    try {
      if (io.exists(file)) {
        const paired = JSON.parse(io.readFile(file)) as { hubOrigin?: unknown };
        if (typeof paired.hubOrigin === "string") origin = paired.hubOrigin.trim().replace(/\/+$/, "");
      }
    } catch {
      /* unreadable/garbled pairing file: report as not configured */
    }
  }
  if (!origin) return { id, label: "hub", status: "skip", detail: "no hub configured (no DPI_HUB_URL, no saved pairing)" };

  const label = `hub ${origin}`;
  const url = `${origin}/healthz`;
  const ms = Math.max(io.hubTimeoutMs, io.timeoutMs);
  let res: HttpResponse;
  try {
    res = await io.fetchImpl(url, { signal: AbortSignal.timeout(ms) });
  } catch (error) {
    return { id, label, status: "warn", detail: `${url} unreachable — ${describeError(error, ms)} (${source})` };
  }
  if (!res.ok) return { id, label, status: "warn", detail: `${url} → ${res.status} (${source})` };
  return { id, label, status: "ok", detail: `${url} answered (${source})` };
}

/** 2. healthz — is the daemon there at all. */
async function healthzCheck(
  io: DoctorIo,
  cfg: DeviceEndpoint,
): Promise<{ check: DoctorCheck; reachable: boolean }> {
  const url = `${cfg.baseUrl}/healthz`;
  const label = `healthz ${url}`;
  let res: HttpResponse;
  try {
    res = await io.fetchImpl(url, { signal: AbortSignal.timeout(io.timeoutMs) });
  } catch (error) {
    return {
      check: { id: "healthz", label, status: "fail", detail: `unreachable — ${describeError(error, io.timeoutMs)} (is the device running? "dpi device start")` },
      reachable: false,
    };
  }
  if (!res.ok) return { check: { id: "healthz", label, status: "fail", detail: `responded ${res.status}` }, reachable: false };
  return { check: { id: "healthz", label, status: "ok", detail: "device answered" }, reachable: true };
}

// ------------------------------------------------------------------- driver

/** Run every check. Warnings never make `ok` false; only a FAIL does. */
/**
 * Local crash reports (policy gate #1): a warn, never a fail — a past crash is
 * information for the operator, not a broken device. Latest first, filename
 * timestamps only, no file bodies parsed.
 */
function crashReportCheck(home: string): DoctorCheck {
  const reports = listCrashReports(home);
  const detail = !reports.length
    ? "none — the daemon has not crashed"
    : `${reports.length} report${reports.length === 1 ? "" : "s"} — newest ${reports[0]!.ageLabel} (${basename(reports[0]!.file)})`;
  return { id: "crash-reports", status: reports.length ? "warn" : "ok", label: "crash reports", detail };
}

export async function runDoctor(opts: Partial<DoctorIo> = {}): Promise<DoctorReport> {
  const io: DoctorIo = { ...defaultDoctorIo(), ...opts };
  const cfg = deviceEndpoint(io);

  const checks: DoctorCheck[] = [nodeCheck(io)];
  const health = await healthzCheck(io, cfg);
  checks.push(health.check);
  checks.push(...startDirChecks(io, cfg));
  checks.push(await probeCheck(io, cfg, health.reachable));
  checks.push(await hubCheck(io, cfg));
  checks.push(crashReportCheck(cfg.home));

  return { checks, ok: checks.every((c) => c.status !== "fail") };
}

/** 1 when anything FAILED, 0 otherwise — the only thing that touches process.exit. */
export const exitCode = (report: DoctorReport): 0 | 1 => (report.ok ? 0 : 1);

const MARK: Record<DoctorStatus, string> = { ok: "ok  ", warn: "warn", fail: "fail", skip: "skip" };

/** Human lines. `quiet` keeps warnings and failures (and always the verdict). */
export function formatReport(report: DoctorReport, opts: { quiet?: boolean } = {}): string[] {
  const shown = opts.quiet ? report.checks.filter((c) => c.status === "warn" || c.status === "fail") : report.checks;
  const lines = shown.map((c) => `${MARK[c.status]}  ${c.label} — ${c.detail}`);
  const failed = report.checks.filter((c) => c.status === "fail").length;
  const warned = report.checks.filter((c) => c.status === "warn").length;
  if (report.ok) {
    const counts = `${report.checks.length} checks`;
    const tail = warned ? `${warned} warning${warned === 1 ? "" : "s"}` : "all good";
    if (!lines.length) lines.push(`doctor: OK — ${counts}, ${tail}`);
    else lines.push("", `doctor: OK — ${counts}, ${tail}`);
    return lines;
  }
  lines.push("", `doctor: ${failed} check${failed === 1 ? "" : "s"} failed${warned ? `, ${warned} warning${warned === 1 ? "" : "s"}` : ""}`);
  return lines;
}

export interface DoctorCliDeps extends Partial<DoctorIo> {
  print?: (line: string) => void;
  printErr?: (line: string) => void;
}

/**
 * `dpi doctor [--json] [--quiet]` — parse, run, print, return the exit code.
 * Kept here (not in bin/dpi.mjs) so the exit-code derivation is unit-testable.
 */
export async function doctorCli(argv: string[] = [], deps: DoctorCliDeps = {}): Promise<0 | 1> {
  const print = deps.print ?? ((line: string) => process.stdout.write(`${line}\n`));
  const printErr = deps.printErr ?? ((line: string) => process.stderr.write(`${line}\n`));
  const json = argv.includes("--json");
  const quiet = argv.includes("--quiet") || argv.includes("-q");
  const unknown = argv.filter((a) => !["--json", "--quiet", "-q", "--help", "-h"].includes(a));
  if (argv.includes("--help") || argv.includes("-h")) {
    print(DOCTOR_HELP);
    return 0;
  }
  if (unknown.length) {
    printErr(`dpi doctor: unknown flag '${unknown[0]}'\n\n${DOCTOR_HELP}`);
    return 1;
  }

  const { print: _p, printErr: _e, ...io } = deps;
  const report = await runDoctor(io);
  if (json) print(JSON.stringify(report, null, 2));
  else for (const line of formatReport(report, { quiet })) print(line);
  return exitCode(report);
}

export const DOCTOR_HELP = `dpi doctor [--json] [--quiet]

One-shot health check for this machine's device: node >= 22.19.0, healthz,
start-dir writability, the default-model probe and the hub's /healthz.

  --json    machine-readable { checks: [{ id, label, status, detail }], ok }
  --quiet   print only warnings and failures

Exit code: 1 when a check fails, 0 otherwise (warnings are not failures).
`;
