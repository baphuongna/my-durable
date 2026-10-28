/**
 * The welcome screen: the app opens first, connection is a state — not a
 * precondition. With no explicit device/url/pair argument, `dpi` boots here
 * instead of printing usage: pick how to connect, in the UI.
 *
 * Pure decision/probe logic lives here so it is unit-testable; the UI reuses
 * the Picker/Prompt idioms and the exact code paths the flags use:
 * - pairing  → parsePairArgs + runPairing (LocalPairing, unchanged semantics)
 * - saving   → registry.upsert({... kind: "url", source: "ui"}) — the --save path
 * - local    → 127.0.0.1:DPI_PORT with DPI_TOKEN from env or DPI_HOME/backend.env
 */
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { matchesKey, type SelectItem } from "@earendil-works/pi-tui";
import { startBackendDetached } from "../../dpi-backend/src/daemon.ts";
import { DpiClient } from "../../dpi-sdk/src/client.ts";
import type { DeviceInfo } from "../../dpi-sdk/src/api.ts";
import { isDpiError } from "../../dpi-sdk/src/errors.ts";
import { DEVICE_ID, dpiHome, normalizeUrl, validateToken, type DeviceRow } from "../../dpi-sdk/src/node/registry.ts";
import type { App, DeviceRef } from "./app.ts";
import { Picker } from "./pickers.ts";
import { parsePairArgs, runPairing, type PairArgs } from "./pairing.ts";
import { c } from "./theme.ts";
import { sanitizeTerminal } from "./sanitize.ts";

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

// ------------------------------------------------------------------ startup decision

export interface StartupArgs {
  deviceRef?: string;
  url?: string;
  pair?: string;
}

export type StartupAction =
  | { kind: "explicit" }
  | { kind: "auto-open"; device: DeviceRow }
  | { kind: "picker"; devices: DeviceRow[] }
  | { kind: "welcome" };

/**
 * What bare `dpi` does at boot. Explicit arguments (device positional, --url,
 * --pair, DPI_DEVICE/DPI_URL) keep their dedicated path; otherwise the registry
 * decides: one connectable device opens it, several open the device picker,
 * none (or none usable) open the welcome screen.
 */
export function resolveStartupAction(input: {
  devices: DeviceRow[];
  env?: NodeJS.ProcessEnv;
  args?: StartupArgs;
}): StartupAction {
  const { devices, env = {}, args = {} } = input;
  if (args.deviceRef || args.url || args.pair !== undefined || env.DPI_DEVICE || env.DPI_URL) return { kind: "explicit" };
  const connectable = devices.filter((d) => d.url && d.token);
  if (connectable.length === 1) return { kind: "auto-open", device: connectable[0]! };
  if (connectable.length > 1) return { kind: "picker", devices: connectable };
  return { kind: "welcome" };
}

/** The device the App is built around while no real one exists yet. */
export const WELCOME_DEVICE: DeviceRef = { id: "no-device", name: "No device", url: "http://127.0.0.1:9", token: "" };

/** A minimal DeviceInfo for the welcome state — no models, nothing callable. */
export function emptyDeviceInfo() {
  return {
    uid: "",
    name: "",
    hostname: "",
    platform: "",
    apiVersion: 1 as const,
    durableVersion: "",
    startedAt: 0,
    startDirs: [],
    models: [],
    defaultModel: "",
    storage: { dataDir: "", catalogPath: "", appStatePath: "" },
    capabilities: [],
  };
}

// ------------------------------------------------------------------ pair-arg assembly (from the prompted values)

/**
 * Assemble PairArgs from what the user pasted/answered: a pair URL carries its
 * own origin; a plain code needs the hub from the answer — no hardcoded default.
 * Undefined when there is nothing to drive (no code/URL) or no origin at all.
 */
export function assemblePairArgs(codeOrUrl: string, hubAnswer?: string): PairArgs | undefined {
  const parsed = parsePairArgs(codeOrUrl);
  if (!parsed.code && !parsed.pairUrl) return undefined;
  const hub = parsed.hub ?? (parsed.pairUrl ? undefined : hubAnswer?.trim() || undefined);
  if (!parsed.pairUrl && !hub) return undefined;
  return { code: parsed.code, pairUrl: parsed.pairUrl, hub, force: parsed.force };
}

// ------------------------------------------------------------------ local backend discovery

/** Minimal KEY=VALUE env-file parser (comments, quotes, junk lines ignored). */
export function parseEnvFile(text: string): Record<string, string> {
  const out: Record<string, string> = {};
  for (const line of text.split("\n")) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#")) continue;
    const eq = trimmed.indexOf("=");
    if (eq <= 0) continue;
    const key = trimmed.slice(0, eq).trim();
    let value = trimmed.slice(eq + 1).trim();
    if (
      (value.startsWith('"') && value.endsWith('"') && value.length > 1) ||
      (value.startsWith("'") && value.endsWith("'") && value.length > 1)
    )
      value = value.slice(1, -1);
    out[key] = value;
  }
  return out;
}

export interface LocalEnv {
  token?: string;
  port: number;
  envFile: string;
}

/**
 * Resolve the local backend's token/port: env first, then DPI_HOME/backend.env
 * (written by `dpi device`). Primes `env` in place so LocalPairing.fromEnv()
 * and the probe agree; never overwrites values the caller already set.
 */
export function applyBackendEnv(env: NodeJS.ProcessEnv = process.env, home = dpiHome()): LocalEnv {
  const envFile = join(home, "backend.env");
  const file = existsSync(envFile) ? parseEnvFile(readFileSync(envFile, "utf8")) : {};
  if (!env.DPI_TOKEN && file.DPI_TOKEN) env.DPI_TOKEN = file.DPI_TOKEN;
  if (!env.DPI_PORT && file.DPI_PORT) env.DPI_PORT = file.DPI_PORT;
  return { token: env.DPI_TOKEN || undefined, port: Number(env.DPI_PORT ?? 4780) || 4780, envFile };
}

export type LocalProbe = { ok: true; info: DeviceInfo } | { ok: false; reason: "unreachable" | "unauthorized" };

export function localBackendUrl(port: number) {
  return `http://127.0.0.1:${port}`;
}

/** Probe the local backend's /v1/device with its token; never throws. */
export async function probeLocalBackend(url: string, token: string, fetchImpl: typeof fetch = fetch): Promise<LocalProbe> {
  try {
    const r = await fetchImpl(`${url}/v1/device`, { headers: { authorization: `Bearer ${token}` } });
    if (r.status === 401) return { ok: false, reason: "unauthorized" };
    if (!r.ok) return { ok: false, reason: "unreachable" };
    return { ok: true, info: (await r.json()) as DeviceInfo };
  } catch {
    return { ok: false, reason: "unreachable" };
  }
}

/** Plain words for the probe outcome — the failure says exactly how to start one. */
export function describeLocalProbe(probe: LocalProbe, port: number): string {
  if (probe.ok) return `local dpi-backend on 127.0.0.1:${port}: ${probe.info.name || probe.info.hostname || "unnamed device"}`;
  if (probe.reason === "unauthorized")
    return `the local dpi-backend on 127.0.0.1:${port} rejected the token — check DPI_TOKEN (env or ${join(dpiHome(), "backend.env")})`;
  return `no local dpi-backend on 127.0.0.1:${port} — auto-start failed; run \`dpi device start\` and check ${join(dpiHome(), "device.log")}`;
}

export type EnsureStarter = () => { ok: boolean; log: string; pid?: number; reason?: string };
export type EnsureResult = { probe: LocalProbe; started: boolean; log?: string; reason?: string };

/**
 * Probe the local backend and, if nothing answers, START one the way
 * `dpi device start` does (detached, log to <home>/device.log) and wait for it.
 * herdr spawns its own server; we do the same for the loopback device. A token
 * rejection is never auto-started away — that's a credential problem.
 */
export async function ensureLocalBackend(
  opts: { port?: number; token?: string; fetchImpl?: typeof fetch; start?: EnsureStarter; waitMs?: number } = {},
): Promise<EnsureResult> {
  const port = opts.port ?? applyBackendEnv().port;
  const probeOf = async (): Promise<LocalProbe> => {
    // a first boot WRITES backend.env, so the token can appear mid-wait
    const token = opts.token ?? applyBackendEnv({ ...process.env, ...(opts.token ? { DPI_TOKEN: opts.token } : {}) }).token;
    if (!token) return { ok: false, reason: "unreachable" };
    return probeLocalBackend(localBackendUrl(port), token, opts.fetchImpl);
  };
  const first = await probeOf();
  if (first.ok || first.reason === "unauthorized") return { probe: first, started: false };
  const start: EnsureStarter = opts.start ?? (() => startBackendDetached(process.env));
  const r = start();
  if (!r.ok) return { probe: first, started: false, reason: r.reason, log: r.log };
  const deadline = Date.now() + (opts.waitMs ?? 15_000);
  let last: LocalProbe = first;
  while (Date.now() < deadline) {
    await new Promise((res) => setTimeout(res, 400));
    last = await probeOf();
    if (last.ok) return { probe: last, started: true, log: r.log, reason: `pid ${r.pid}` };
  }
  return { probe: last, started: true, log: r.log };
}

// ------------------------------------------------------------------ ids and device input

/** Suggest a registry id from a hostname/device name; dashes for the rest. */
export function suggestDeviceId(...sources: Array<string | undefined>): string {
  for (const source of sources) {
    if (!source) continue;
    const id = source
      .toLowerCase()
      .replace(/[^a-z0-9-]+/g, "-")
      .replace(/^-+/, "")
      .replace(/-+$/, "")
      .slice(0, 32)
      .replace(/-+$/, "");
    if (DEVICE_ID.test(id)) return id;
  }
  return "device";
}

/** URL + token validation for "add a device by URL", reusing the registry's own rules. */
export function validateDeviceInput(urlAnswer: string, tokenAnswer: string): { url: string; token: string } | { error: string } {
  try {
    const url = normalizeUrl(urlAnswer);
    try {
      return { url, token: validateToken(tokenAnswer) };
    } catch (e) {
      return { error: `token: ${(e as Error).message}` };
    }
  } catch (e) {
    return { error: (e as Error).message };
  }
}

// ------------------------------------------------------------------ the welcome screen

export function welcomeItems(deviceCount: number, port: number, hub = false): SelectItem[] {
  // The bracket letter is a real shortcut (see WelcomePicker) — typing it runs
  // the action instead of relying on filter order.
  const items: SelectItem[] = [
    { value: "pair", label: "[p] Pair this machine", description: "code or pair URL from the hub wizard" },
    { value: "add-url", label: "[a] Add a device by URL", description: "http://host:port + its DPI_TOKEN" },
    { value: "detect-local", label: "[d] Detect the local backend", description: `probe 127.0.0.1:${port} (DPI_TOKEN or ~/.dpi/backend.env)` },
  ];
  // Hub mode (live-caught): the network is one key away — before this the
  // welcome offered only local pairing and quit, with the hub feed invisible
  // behind the overlay and no way to browse it.
  if (hub)
    items.unshift({
      value: "hub-network",
      label: "[h] Browse the hub network",
      description: "devices and sessions the hub can see",
    });
  if (deviceCount > 0)
    items.push({
      value: "switch-device",
      label: "[s] Switch device",
      description: `${deviceCount} saved device${deviceCount === 1 ? "" : "s"}`,
    });
  return items;
}

/** The welcome picker: same idioms as every other picker; q/esc quits. */
export class WelcomePicker extends Picker {
  private cancel: () => void;
  constructor(items: SelectItem[], onPick: (item: SelectItem) => void, onCancel: () => void, subtitle?: string) {
    super("No device yet.", items, onPick, onCancel, "↑↓ move │ enter select │ q quit", subtitle);
    this.cancel = onCancel;
  }
  handleInput(data: string) {
    if (data === "q" || matchesKey(data, "escape")) return this.cancel();
    // Letters in the labels are shortcuts, not filter text: "[d] Detect" must
    // DETECT regardless of which other label happens to contain a "d".
    if (data.length === 1) {
      const item = this.items().find((i) => i.label.startsWith(`[${data}]`));
      if (item) return this.pick(item);
    }
    return super.handleInput(data);
  }
}

/** Open the welcome screen overlay. `notice` names an unreachable auto-connect. */
export function showWelcome(app: App, opts: { notice?: string } = {}) {
  const devices = app.registry?.list() ?? [];
  const subtitle = opts.notice
    ? c.err(sanitizeTerminal(opts.notice))
    : c.muted("This is the app — connect a device to get started:");
  let picked = false; // an action was chosen: closing the overlay is a step, not a quit
  app.overlay(
    new WelcomePicker(
      welcomeItems(devices.length, applyBackendEnv().port, Boolean(app.hubUrl)),
      (item) => {
        picked = true;
        app.closeOverlay();
        void runWelcomeAction(app, String(item.value));
      },
      () => {
        picked = true;
        // Usability pass: Esc must never surprise-quit. With a hub configured
        // it lands in the network view (the feed is one key away); without one
        // the old quit behavior stands — there is nothing else to show.
        if (app.hubUrl) {
          app.closeOverlay();
          app.setView("network");
        } else {
          app.exit();
        }
      },
      subtitle,
    ),
    () => {
      if (!picked) app.exit(); // ctrl+c on the welcome screen quits the app
    },
  );
}

/**
 * A welcome sub-picker (switch device, confirm local…): picking runs the action;
 * every other close — esc, ctrl+c — comes back to the welcome screen.
 */
function stepPicker(app: App, label: string, items: SelectItem[], onPickValue: (value: string) => void, subtitle?: string) {
  let picked = false;
  app.overlay(
    new Picker(
      label,
      items,
      (item) => {
        picked = true;
        app.closeOverlay();
        onPickValue(String(item.value));
      },
      () => {
        picked = true;
        app.closeOverlay();
        showWelcome(app);
      },
      undefined,
      subtitle,
    ),
    () => {
      if (!picked) showWelcome(app);
    },
  );
}

async function runWelcomeAction(app: App, action: string) {
  if (action === "pair") return welcomePair(app);
  if (action === "add-url") return welcomeAddUrl(app);
  if (action === "detect-local") return welcomeLocal(app);
  if (action === "switch-device") return welcomeSwitch(app);
  if (action === "hub-network") {
    // Close into the network view; the hub feed keeps it current.
    app.closeOverlay();
    app.setView("network");
    return;
  }
}

/** [p] Pair this machine — the same LocalPairing path as `--pair` and /pair. */
async function welcomePair(app: App) {
  const pasted = await app.prompt("Pairing code or pair URL", "");
  if (pasted === undefined) return showWelcome(app);
  let hub: string | undefined;
  const first = parsePairArgs(pasted);
  if (first.code && !first.hub && !first.pairUrl) {
    const answer = await app.prompt("Hub origin (https://hub.example.com)", "");
    if (answer === undefined) return showWelcome(app);
    hub = answer.trim() || undefined;
  }
  const args = assemblePairArgs(pasted, hub);
  if (!args) {
    app.flash("Need a pair URL, or a code plus its hub origin — mint a code in the hub wizard.", true);
    return showWelcome(app);
  }
  // Prime DPI_TOKEN/DPI_PORT from ~/.dpi/backend.env so LocalPairing.fromEnv() finds them.
  applyBackendEnv();
  await runPairing(app, args);
  // The pairing panel stays open on its terminal state; welcome returns once it closes.
  while (app.overlayCount > 0) await sleep(150);
  showWelcome(app);
}

/** [a] Add a device by URL — verify against the device, then the --save path. */
async function welcomeAddUrl(app: App) {
  const urlAnswer = await app.prompt("Device URL (http://host:port)", "");
  if (urlAnswer === undefined || !urlAnswer.trim()) return showWelcome(app);
  const token = await app.promptSecret("Device token (DPI_TOKEN)");
  if (token === undefined || !token) return showWelcome(app);
  const input = validateDeviceInput(urlAnswer, token);
  if ("error" in input) {
    app.flash(input.error, true);
    return showWelcome(app);
  }
  app.flash(`Connecting to ${input.url}…`);
  let info;
  try {
    // 20s, not 8: a HUB-proxied device URL pays the tunnel's first-hit cost
    // (15s observed live) — 8s reported "cannot reach" on a healthy device.
    info = await new DpiClient(input.url, input.token).device({ timeoutMs: 20000 });
  } catch (e) {
    app.flash(
      isDpiError(e) && e.code === "unauthorized"
        ? `token rejected by ${input.url}`
        : `cannot reach ${input.url} (${(e as Error).message})`,
      true,
    );
    return showWelcome(app);
  }
  const suggested = suggestDeviceId(new URL(input.url).hostname, info.name, info.hostname);
  const id = await app.prompt("Save as", suggested);
  if (id === undefined || !id.trim()) return showWelcome(app);
  if (!DEVICE_ID.test(id.trim())) {
    app.flash(`Device id must match ${DEVICE_ID} (got "${id.trim()}")`, true);
    return showWelcome(app);
  }
  await saveAndOpen(app, id.trim(), input.url, input.token, info.name);
}

/** [d] Detect the local backend — probe, then offer to save + open it. */
async function welcomeLocal(app: App) {
  const local = applyBackendEnv();
  app.flash(`Probing 127.0.0.1:${local.port}…`);
  const ensured = await ensureLocalBackend({ port: local.port, token: local.token });
  if (ensured.started && ensured.probe.ok) app.flash(`started the local dpi-backend (${ensured.reason})`);
  if (!ensured.probe.ok) {
    app.flash(describeLocalProbe(ensured.probe, local.port), true);
    return showWelcome(app);
  }
  const probe = ensured.probe;
  const url = localBackendUrl(local.port);
  const id = suggestDeviceId(probe.info.hostname, probe.info.name);
  stepPicker(
    app,
    `Local backend: ${sanitizeTerminal(probe.info.name || probe.info.hostname || url)}`,
    [{ value: "open", label: `Save as "${id}" and open`, description: `${url} │ token from DPI_TOKEN / backend.env` }],
    // local.token was read BEFORE a first boot may have written backend.env —
    // re-resolve, the file exists now.
    () => void saveAndOpen(app, id, url, applyBackendEnv().token!, probe.info.name),
  );
}

/** [s] Switch device — the saved list; cancel comes back to the welcome screen. */
function welcomeSwitch(app: App) {
  const devices = app.registry?.list() ?? [];
  if (!devices.length) return showWelcome(app);
  stepPicker(
    app,
    "Devices",
    devices.map((d) => ({
      value: d.id,
      label: d.id,
      description: `${d.kind} │ ${d.url ?? "tunnel"}${d.token ? "" : " │ no token"}`,
    })),
    (id) => void app.switchDevice(id),
  );
}

/** The --save mechanism (registry.upsert, kind "url", source "ui"), then open. */
async function saveAndOpen(app: App, id: string, url: string, token: string, name?: string) {
  if (!app.registry) return app.flash("No registry — start with --url/--token.", true);
  try {
    app.registry.upsert({ id, name: name || id, url, kind: "url", source: "ui", token });
  } catch (e) {
    app.flash((e as Error).message, true);
    return showWelcome(app);
  }
  await app.switchDevice(id);
}
