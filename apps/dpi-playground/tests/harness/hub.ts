/**
 * Hub child-process lifecycle: start / health-timeout / restart on the SAME
 * port / direct-PID kill / child-exit detection. Own DPI_HOME per boot (own
 * registry DB), own port, no global state.
 */
import { spawn, type ChildProcess } from "node:child_process";
import { once } from "node:events";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { BoundedLog } from "./logs.js";
import { freePort } from "./caddy.js";

const HUB_MAIN = resolve(import.meta.dirname, "../../apps/dpi-playground-hub/src/main.ts");
const PLAYGROUND_ROOT = resolve(import.meta.dirname, "../..");

/**
 * The hub child must measure what THESE tests intend, not what the caller's shell
 * happens to export: an ambient DPI_HUB_REQUIRE_TLS or DPI_HUB_PUBLIC_HOST would
 * silently turn a "plain" hub boot into something else. Start from a minimal safe
 * base and let only the DPI_* variables the harness itself passes (opts.env +
 * DPI_HOME) through.
 */
const SAFE_CHILD_ENV_KEYS = ["PATH", "HOME", "TMPDIR", "TZ"] as const;
const childEnv = (intended: Record<string, string>): Record<string, string> => {
  const env: Record<string, string> = {};
  for (const key of SAFE_CHILD_ENV_KEYS) {
    const value = process.env[key];
    if (value !== undefined) env[key] = value;
  }
  return { ...env, ...intended };
};

export interface HubHandle {
  port: number;
  base: string; // http://127.0.0.1:<port>
  home: string;
  log: BoundedLog;
  start: () => Promise<void>; // restart after stop, same port/home
  stop: (signal?: NodeJS.Signals) => Promise<void>;
  kill: () => Promise<void>; // SIGKILL — crash simulation
  exited: () => boolean;
  exitCode: () => number | null;
  cleanup: () => Promise<void>;
}

export async function bootHub(
  opts: { port?: number; publicHost?: string; healthTimeoutMs?: number; env?: Record<string, string> } = {},
): Promise<HubHandle> {
  const port = opts.port ?? (await freePort());
  const home = await mkdtemp(join(tmpdir(), "dpi-hub-"));
  const log = new BoundedLog("hub", 500);
  let child: ChildProcess | undefined;

  const start = async () => {
    const args = ["--import", "tsx", HUB_MAIN, "--port", String(port), "--host", "127.0.0.1"];
    if (opts.publicHost) args.push("--public-host", opts.publicHost);
    child = spawn(process.execPath, args, {
      env: childEnv({ ...opts.env, DPI_HOME: home }),
      stdio: ["ignore", "pipe", "pipe"],
      cwd: PLAYGROUND_ROOT,
    });
    child.stdout?.on("data", (x) => log.push(String(x)));
    child.stderr?.on("data", (x) => log.push(String(x)));
    const deadline = Date.now() + (opts.healthTimeoutMs ?? 20_000);
    for (;;) {
      if (child.exitCode !== null) throw new Error(`hub child exited early (${child.exitCode}):\n${log.tail(40)}`);
      if (Date.now() > deadline) {
        const gone = once(child, "exit");
        child.kill("SIGKILL");
        await gone;
        throw new Error(`hub health timeout:\n${log.tail(40)}`);
      }
      try {
        const res = await fetch(`http://127.0.0.1:${port}/healthz`);
        if (res.ok) return;
      } catch {}
      await new Promise((r) => setTimeout(r, 100));
    }
  };

  const waitForExit = async (signal: NodeJS.Signals, timeoutMs: number) => {
    const c = child;
    if (!c || c.exitCode !== null) return;
    c.kill(signal);
    const end = Date.now() + timeoutMs;
    while (c.exitCode === null && Date.now() < end) await new Promise((r) => setTimeout(r, 50));
    if (c.exitCode === null) {
      c.kill("SIGKILL");
      const end2 = Date.now() + timeoutMs;
      while (c.exitCode === null && Date.now() < end2) await new Promise((r) => setTimeout(r, 50));
    }
  };

  try {
    await start();
  } catch (err) {
    // A failed boot must not leak the child or the mkdtemp home it was given.
    if (child && child.exitCode === null) await waitForExit("SIGKILL", 5000);
    await rm(home, { recursive: true, force: true });
    throw err;
  }
  return {
    port,
    base: `http://127.0.0.1:${port}`,
    home,
    log,
    start,
    stop: (signal = "SIGTERM") => waitForExit(signal, 5000),
    kill: () => waitForExit("SIGKILL", 5000),
    exited: () => !child || child.exitCode !== null,
    exitCode: () => child?.exitCode ?? null,
    cleanup: async () => {
      if (child && child.exitCode === null) await waitForExit("SIGKILL", 5000);
      await rm(home, { recursive: true, force: true });
    },
  };
}
