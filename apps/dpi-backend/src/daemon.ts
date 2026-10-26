/**
 * `dpi device start|stop|status|install|uninstall` — run the device daemon
 * WITHOUT a terminal. The reference clients keep their daemon alive through a
 * desktop supervisor and spawn it detached (paseo `spawnDetached`: detached +
 * stdio redirect + unref + stripped Electron env). We are headless, so the OS
 * supervisor replaces the desktop app:
 *
 *   start    detached spawn, logs to <home>/device.log (paseo-style hygiene)
 *   stop     graceful: token-authed POST /v1/shutdown, pid kill as fallback
 *   status   health + pid + pairing state
 *   install  linux: systemd --user unit (+ enable-linger so logout keeps it)
 *            macOS: LaunchAgent plist
 *            windows: hidden Startup-folder VBS (no console flash at logon)
 *
 * DPI_TOKEN never lands in any unit/plist/script — it lives in the env file
 * the daemon bootstraps from.
 */
import { spawn, execFile } from "node:child_process";
import { openSync, closeSync, existsSync, readFileSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";

export type DeviceSub = "run" | "start" | "stop" | "status" | "install" | "uninstall" | "help";

/** `dpi device --help` — printed without touching the daemon or its home. */
export const DEVICE_USAGE = `dpi device — the device-side daemon

  dpi device                             run the daemon in the foreground
  dpi device start                       start it detached (no terminal, logs to device.log)
  dpi device stop                        graceful stop (token-authed shutdown, pid kill as fallback)
  dpi device status                      health + pid + pairing state
  dpi device install | uninstall         OS service (systemd --user / launchd / Startup VBS)

Any other word — or none — runs the daemon in the foreground, flags included.
Environment: DPI_HUB_URL, DPI_HOME (see dpi --help).`;

/** First argv word decides: a subcommand runs and exits, anything else = foreground daemon. */
export function parseDeviceSub(argv: string[]): { sub: DeviceSub; rest: string[] } {
  const subs: DeviceSub[] = ["start", "stop", "status", "install", "uninstall"];
  const [first, ...rest] = argv;
  if (first === "-h" || first === "--help" || first === "help") return { sub: "help", rest: [] };
  return subs.includes(first as DeviceSub)
    ? { sub: first as DeviceSub, rest }
    : { sub: "run", rest: argv };
}

const expand = (p: string) => (p === "~" ? homedir() : p.startsWith("~/") ? join(homedir(), p.slice(2)) : p);

export interface DaemonPaths {
  home: string;
  pid: string;
  log: string;
}

/** Same home rule as loadConfig: $DPI_HOME or ~/.dpi. */
export function daemonPaths(env: { DPI_HOME?: string } = {}): DaemonPaths {
  const home = expand(env.DPI_HOME ?? join(homedir(), ".dpi"));
  return { home, pid: join(home, "device.pid"), log: join(home, "device.log") };
}

/** Knobs a service file may carry. The token is deliberately absent — it stays in the env file. */
export function serviceEnv(env: Record<string, string | undefined>): Record<string, string> {
  const keys = [
    "DPI_HOME",
    "DPI_HUB_URL",
    "DPI_HUB_CA",
    "DPI_PROVIDER",
    "DPI_START_DIRS",
    "DPI_HOST",
    "DPI_PORT",
    "DPI_DEVICE_NAME",
    "DPI_DATA_DIR",
    "DPI_ENV_FILE",
  ];
  const out: Record<string, string> = {};
  for (const k of keys) if (env[k]) out[k] = env[k] as string;
  return out;
}

/** The env the detached child inherits: drop the Electron-node hazards (paseo lesson). */
export function cleanChildEnv(env: Record<string, string | undefined>): NodeJS.ProcessEnv {
  const out: NodeJS.ProcessEnv = { ...env };
  delete out.ELECTRON_RUN_AS_NODE;
  delete out.ELECTRON_NO_ATTACH_CONSOLE;
  return out;
}

const q = (s: string) => `"${s.replaceAll('"', "")}"`;

export function systemdUnit(o: { node: string; dpi: string; env: Record<string, string> }): string {
  const envLines = Object.entries(o.env)
    .map(([k, v]) => `Environment="${k}=${v.replaceAll('"', "")}"`)
    .join("\n");
  return `[Unit]
Description=Durable Pi device daemon
After=network-online.target
Wants=network-online.target

[Service]
Type=simple
ExecStart=${q(o.node)} ${q(o.dpi)} device
${envLines}
Restart=on-failure
RestartSec=2

[Install]
WantedBy=default.target
`;
}

export function launchdPlist(o: {
  node: string;
  dpi: string;
  env: Record<string, string>;
  log: string;
}): string {
  const envXml = Object.entries(o.env)
    .map(([k, v]) => `        <key>${k}</key><string>${v.replaceAll("&", "&amp;").replaceAll("<", "&lt;")}</string>`)
    .join("\n");
  return `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
  <dict>
    <key>Label</key><string>io.durable-pi.device</string>
    <key>ProgramArguments</key><array><string>${o.node}</string><string>${o.dpi}</string><string>device</string></array>
    <key>EnvironmentVariables</key>
    <dict>
${envXml}
    </dict>
    <key>RunAtLoad</key><true/>
    <key>StandardOutPath</key><string>${o.log}</string>
    <key>StandardErrorPath</key><string>${o.log}</string>
  </dict>
</plist>
`;
}

// ---------------------------------------------------------------- command IO

export interface RunOpts {
  env?: Record<string, string | undefined>;
  platform?: NodeJS.Platform;
  uid?: number;
  fetchImpl?: typeof fetch;
  execImpl?: (cmd: string, args: string[]) => Promise<{ ok: boolean; output: string; code: number }>;
  writeFileImpl?: (path: string, body: string) => Promise<void>;
  killImpl?: (pid: number) => boolean;
  print?: (line: string) => void;
  quiet?: boolean;
}

interface Io {
  env: Record<string, string | undefined>;
  platform: NodeJS.Platform;
  uid: number;
  fetchImpl: typeof fetch;
  exec: (cmd: string, args: string[]) => Promise<{ ok: boolean; output: string; code: number }>;
  writeFile: (path: string, body: string) => Promise<void>;
  kill: (pid: number) => boolean;
  print: (line: string) => void;
}

const execDefault = (cmd: string, args: string[]) =>
  new Promise<{ ok: boolean; output: string; code: number }>((resolve) => {
    execFile(cmd, args, { timeout: 30_000 }, (error, stdout, stderr) => {
      const code = (error as { code?: number } | null)?.code ?? 0;
      resolve({ ok: !error, output: String(stdout ?? "") + String(stderr ?? ""), code });
    });
  });

const delay = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

function ioOf(opts: RunOpts): Io {
  return {
    env: opts.env ?? process.env,
    platform: opts.platform ?? process.platform,
    uid: opts.uid ?? (typeof process.getuid === "function" ? process.getuid() : 0),
    fetchImpl: opts.fetchImpl ?? fetch,
    exec: opts.execImpl ?? execDefault,
    writeFile:
      opts.writeFileImpl ??
      (async (path, body) => {
        mkdirSync(dirname(path), { recursive: true });
        writeFileSync(path, body, { mode: 0o644 });
      }),
    kill:
      opts.killImpl ??
      ((pid) => {
        try {
          process.kill(pid, "SIGTERM");
          return true;
        } catch {
          return false;
        }
      }),
    print: opts.print ?? ((line) => !opts.quiet && console.log(line)),
  };
}

function portOf(io: Io): number {
  return Number(io.env.DPI_PORT ?? "4780");
}

/** Token for the local API: env first, then the env file the daemon bootstrapped from. */
function tokenOf(io: Io, paths: DaemonPaths): string {
  if (io.env.DPI_TOKEN) return io.env.DPI_TOKEN;
  const envFile = expand(io.env.DPI_ENV_FILE ?? join(paths.home, "backend.env"));
  try {
    const m = readFileSync(envFile, "utf8").match(/^DPI_TOKEN=(.+)$/m);
    if (m) return m[1].trim();
  } catch {
    /* no env file yet */
  }
  return "";
}

async function health(io: Io): Promise<Response | undefined> {
  try {
    return await io.fetchImpl(`http://127.0.0.1:${portOf(io)}/healthz`, {
      signal: AbortSignal.timeout(800),
    });
  } catch {
    return undefined;
  }
}

async function waitHealthDown(io: Io, ms: number): Promise<boolean> {
  const end = Date.now() + ms;
  while (Date.now() < end) {
    const r = await health(io);
    if (!r || !r.ok) return true;
    await delay(200);
  }
  return false;
}

async function waitHealthUp(io: Io, ms: number): Promise<boolean> {
  const end = Date.now() + ms;
  while (Date.now() < end) {
    const r = await health(io);
    if (r?.ok) return true;
    await delay(200);
  }
  return false;
}

function pidFrom(paths: DaemonPaths): number | undefined {
  try {
    const n = Number(readFileSync(paths.pid, "utf8").trim());
    return Number.isInteger(n) && n > 0 ? n : undefined;
  } catch {
    return undefined;
  }
}

// ---------------------------------------------------------------- commands

/** The spawn `dpi device start` performs — exported so the TUI can bring the
 *  local backend up itself instead of telling the user to open another shell. */
export function startBackendDetached(
  env: Record<string, string | undefined>,
  rest: string[] = [],
): { ok: boolean; pid?: number; log: string; reason?: string } {
  const paths = daemonPaths(env);
  const dpi = env.DPI_BIN ?? (process.argv[1]?.endsWith(".mjs") ? process.argv[1] : "");
  if (!dpi || !existsSync(dpi))
    return { ok: false, log: paths.log, reason: "no dpi launcher found" };
  mkdirSync(paths.home, { recursive: true, mode: 0o700 });
  const fd = openSync(paths.log, "a");
  const child = spawn(process.execPath, [dpi, "device", ...rest], {
    detached: true,
    stdio: ["ignore", fd, fd],
    env: cleanChildEnv(env),
    cwd: dirname(dpi),
  });
  child.unref();
  closeSync(fd);
  return { ok: true, pid: child.pid, log: paths.log };
}

async function cmdStart(io: Io, rest: string[]): Promise<number> {
  const paths = daemonPaths(io.env);
  if ((await health(io))?.ok) {
    io.print(`already running (pid ${pidFrom(paths) ?? "?"}) on port ${portOf(io)}`);
    return 0;
  }
  const started = startBackendDetached(io.env, rest);
  if (!started.ok) return io.print(started.reason ?? "start failed"), 1;
  io.print(`starting dpi device … (log: ${paths.log})`);
  if (await waitHealthUp(io, 20_000)) {
    io.print(`running on http://127.0.0.1:${portOf(io)} (pid ${pidFrom(paths) ?? "?"})`);
    io.print(`stop: dpi device stop    survive logon: dpi device install`);
    return 0;
  }
  io.print(`did not come up within 20s — tail the log: tail -50 ${paths.log}`);
  return 1;
}

async function cmdStop(io: Io): Promise<number> {
  const paths = daemonPaths(io.env);
  const live = (await health(io))?.ok;
  const pid = pidFrom(paths);
  if (!live) {
    if (pid) rmSync(paths.pid, { force: true });
    io.print("not running");
    return 0;
  }
  const token = tokenOf(io, paths);
  if (token) {
    try {
      const r = await io.fetchImpl(`http://127.0.0.1:${portOf(io)}/v1/shutdown`, {
        method: "POST",
        headers: { authorization: `Bearer ${token}` },
        signal: AbortSignal.timeout(3_000),
      });
      if (r.ok && (await waitHealthDown(io, 10_000))) {
        rmSync(paths.pid, { force: true });
        io.print(`stopped (graceful http shutdown, pid ${pid ?? "?"})`);
        return 0;
      }
    } catch {
      /* fall through to the pid kill */
    }
  }
  if (pid && io.kill(pid) && (await waitHealthDown(io, 10_000))) {
    rmSync(paths.pid, { force: true });
    io.print(`stopped (SIGTERM pid ${pid})`);
    return 0;
  }
  io.print(`still answering on port ${portOf(io)} — kill the process manually (pid ${pid ?? "?"})`);
  return 1;
}

async function cmdStatus(io: Io): Promise<number> {
  const paths = daemonPaths(io.env);
  const pid = pidFrom(paths);
  const h = await health(io);
  if (!h?.ok) {
    io.print(`not running (pid file: ${pid ?? "none"})`);
    return 1;
  }
  io.print(`running  pid ${pid ?? "?"}  http://127.0.0.1:${portOf(io)}`);
  const token = tokenOf(io, paths);
  if (!token) return 0;
  try {
    const auth = { authorization: `Bearer ${token}` } as Record<string, string>;
    const device = (await (await io.fetchImpl(`http://127.0.0.1:${portOf(io)}/v1/device`, { headers: auth })).json()) as {
      name?: string;
      uid?: string;
      provider?: string;
    };
    io.print(`device   ${device.name ?? "?"} (${device.uid ?? "?"})  provider ${device.provider ?? "?"}`);
    const pairing = (await (
      await io.fetchImpl(`http://127.0.0.1:${portOf(io)}/v1/pairing`, { headers: auth })
    ).json()) as { state?: string; hubOrigin?: string | null; fingerprint?: string };
    io.print(`pairing  ${pairing.state ?? "?"}${pairing.hubOrigin ? ` → ${pairing.hubOrigin}` : ""}`);
    if (pairing.fingerprint) io.print(`  fingerprint ${pairing.fingerprint}`);
  } catch {
    io.print("(local API not reachable with the saved token)");
  }
  return 0;
}

async function cmdInstall(io: Io): Promise<number> {
  const env = serviceEnv(io.env);
  const p = io.platform;
  if (p === "win32") {
    // The reference clients register NO OS autostart either: their daemon lives
    // inside a desktop app the user opens by hand. We are a console daemon with
    // no GUI host, so the honest equivalent on Windows is `dpi device start`
    // after login — no hidden scripts, no registry entries, nothing to forget
    // about at uninstall time.
    io.print("Windows: no OS autostart is installed (the reference clients install none either).");
    io.print("Start the daemon after login with:  dpi device start");
    io.print("Stop it with:                       dpi device stop");
    return 0;
  }
  const node = process.execPath;
  const dpi = io.env.DPI_BIN ?? "";
  if (!dpi || !existsSync(dpi)) return io.print("install needs the dpi launcher (run via `dpi device install`)"), 1;
  if (!env.DPI_HOME) env.DPI_HOME = daemonPaths(io.env).home;
  if (p === "linux") {
    const unit = join(homedir(), ".config/systemd/user/dpi-device.service");
    await io.writeFile(unit, systemdUnit({ node, dpi, env }));
    await io.exec("systemctl", ["--user", "daemon-reload"]);
    const enable = await io.exec("systemctl", ["--user", "enable", "--now", "dpi-device.service"]);
    if (!enable.ok) {
      io.print(`systemctl enable failed: ${enable.output}`);
      return 1;
    }
    // Logout would otherwise stop a user service; linger keeps it. Best-effort:
    // on locked-down hosts the operator adds it once by hand.
    const linger = await io.exec("loginctl", ["enable-linger", String(io.uid)]);
    io.print(`installed systemd user service (${unit})`);
    io.print(linger.ok ? "linger enabled — the daemon survives logout and starts at boot" : "note: enable-linger was refused; the service still starts at every login");
    io.print(`check: systemctl --user status dpi-device`);
    return 0;
  }
  if (p === "darwin") {
    const paths = daemonPaths(io.env);
    const plist = join(homedir(), "Library/LaunchAgents/io.durable-pi.device.plist");
    await io.writeFile(plist, launchdPlist({ node, dpi, env, log: paths.log }));
    let boot = await io.exec("launchctl", ["bootstrap", `gui/${io.uid}`, plist]);
    if (!boot.ok) boot = await io.exec("launchctl", ["load", "-w", plist]);
    if (!boot.ok) {
      io.print(`launchctl failed: ${boot.output}`);
      return 1;
    }
    await io.exec("launchctl", ["enable", `gui/${io.uid}/io.durable-pi.device`]);
    io.print(`installed LaunchAgent (${plist}) — starts at login`);
    return 0;
  }
  io.print(`no service installer for platform ${p} — use \`dpi device start\` after login`);
  return 1;
}

async function cmdUninstall(io: Io): Promise<number> {
  await cmdStop(io);
  const p = io.platform;
  if (p === "linux") {
    await io.exec("systemctl", ["--user", "disable", "--now", "dpi-device.service"]);
    const unit = join(homedir(), ".config/systemd/user/dpi-device.service");
    if (existsSync(unit)) rmSync(unit);
    await io.exec("systemctl", ["--user", "daemon-reload"]);
    await io.exec("loginctl", ["disable-linger", String(io.uid)]);
    io.print("removed systemd user service");
  } else if (p === "darwin") {
    const plist = join(homedir(), "Library/LaunchAgents/io.durable-pi.device.plist");
    let boot = await io.exec("launchctl", ["bootout", `gui/${io.uid}/io.durable-pi.device`]);
    if (!boot.ok) await io.exec("launchctl", ["unload", "-w", plist]);
    if (existsSync(plist)) rmSync(plist);
    io.print("removed LaunchAgent");
  } else if (p === "win32") {
    io.print("Windows installs nothing at the OS level — only the daemon was stopped");
  }
  return 0;
}

export async function runDeviceCommand(sub: DeviceSub, rest: string[], opts: RunOpts = {}): Promise<number> {
  const io = ioOf(opts);
  if (sub === "help") {
    io.print(DEVICE_USAGE);
    return 0;
  }
  if (sub === "start") return cmdStart(io, rest);
  if (sub === "stop") return cmdStop(io);
  if (sub === "status") return cmdStatus(io);
  if (sub === "install") return cmdInstall(io);
  if (sub === "uninstall") return cmdUninstall(io);
  return 0;
}
