/**
 * Real Caddy child process pinned at tools/caddy (v2.10.2, sha256 recorded in
 * the verification report). Terminates HTTPS in front of the loopback hub,
 * strips client-supplied XFF/XFP and re-attaches values from the actual
 * connection (05 §4). Direct-PID lifecycle only — no pkill patterns.
 */
import { spawn, type ChildProcess } from "node:child_process";
import { once } from "node:events";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { createServer } from "node:net";
import { BoundedLog } from "./logs.js";

export const CADDY_BINARY = resolve(import.meta.dirname, "../../../../tools/caddy");

export async function freePort(): Promise<number> {
  const probe = createServer();
  probe.listen(0, "127.0.0.1");
  await once(probe, "listening");
  const port = (probe.address() as { port: number }).port;
  await new Promise<void>((r) => probe.close(() => r()));
  return port;
}

export interface CaddyHandle {
  port: number;
  httpsBase: string;
  log: BoundedLog;
  stop: (signal?: NodeJS.Signals) => Promise<void>;
  exited: () => boolean;
}

export const DEPLOY_CADDYFILE = resolve(import.meta.dirname, "../../../../deploy/Caddyfile");

/**
 * Run the REFERENCE deploy/Caddyfile (P2-21) with {$ENV} placeholders fed by
 * the harness: test-CA cert/key, admin bcrypt hash from `caddy hash-password`.
 */
export async function bootCaddyDeploy(opts: {
  hubPort: number;
  certFile: string;
  keyFile: string;
  adminHash: string;
  port?: number;
}): Promise<CaddyHandle> {
  const port = opts.port ?? (await freePort());
  const dir = await mkdtemp(join(tmpdir(), "dpi-caddy-deploy-"));
  const log = new BoundedLog("caddy-deploy", 400);
  const env = {
    ...process.env,
    DPI_PUBLIC_HOST: `127.0.0.1:${port}`,
    DPI_TLS_CERT: opts.certFile,
    DPI_TLS_KEY: opts.keyFile,
    DPI_HUB_ADDR: `127.0.0.1:${opts.hubPort}`,
    DPI_ADMIN_HASH: opts.adminHash,
    XDG_CONFIG_HOME: join(dir, "config"),
    XDG_DATA_HOME: join(dir, "data"),
  };
  const child = spawn(CADDY_BINARY, ["run", "--config", DEPLOY_CADDYFILE, "--adapter", "caddyfile"], { env, stdio: ["ignore", "pipe", "pipe"] });
  child.stdout?.on("data", (x) => log.push(String(x)));
  child.stderr?.on("data", (x) => log.push(String(x)));
  const base = `https://127.0.0.1:${port}`;
  // Readiness: an HTTPS probe that ignores certs — we only need the TLS/HTTP
  // listener to answer, client trust is the caller's business.
  const https = await import("node:https");
  const deadline = Date.now() + 15_000;
  for (;;) {
    if (child.exitCode !== null) throw new Error(`caddy exited early:\n${log.tail(30)}`);
    const up = await new Promise<boolean>((done) => {
      const req = https.get(`${base}/healthz`, { rejectUnauthorized: false, timeout: 1500 }, (res) => {
        res.resume();
        done(true);
      });
      req.on("error", () => done(false));
      req.on("timeout", () => {
        req.destroy();
        done(false);
      });
    });
    if (up) break;
    if (Date.now() > deadline) throw new Error(`caddy not serving:\n${log.tail(30)}`);
    await new Promise((r) => setTimeout(r, 150));
  }
  const stop = async (signal: NodeJS.Signals = "SIGTERM") => {
    if (child.exitCode !== null) return;
    const exited = once(child, "exit");
    child.kill(signal);
    await exited;
    await rm(dir, { recursive: true, force: true });
  };
  return { port, httpsBase: base, log, stop, exited: () => child.exitCode !== null };
}

export async function bootCaddy(opts: {
  hubPort: number;
  certFile: string;
  keyFile: string;
  port?: number;
}): Promise<CaddyHandle> {
  const port = opts.port ?? (await freePort());
  const dir = await mkdtemp(join(tmpdir(), "dpi-caddy-"));
  const caddyfile = join(dir, "Caddyfile");
  await writeFile(
    caddyfile,
    `{
  admin off
  auto_https off
  log {
    output file ${join(dir, "caddy-run.log")}
  }
}
https://127.0.0.1:${port} {
  tls ${opts.certFile} ${opts.keyFile}
  reverse_proxy 127.0.0.1:${opts.hubPort} {
    header_up X-Forwarded-For {remote_host}
    header_up X-Forwarded-Proto https
  }
}
`,
  );
  const log = new BoundedLog("caddy", 400);
  const child: ChildProcess = spawn(CADDY_BINARY, ["run", "--config", caddyfile, "--adapter", "caddyfile"], {
    stdio: ["ignore", "pipe", "pipe"],
    cwd: dir,
  });
  child.stdout?.on("data", (x) => log.push(String(x)));
  child.stderr?.on("data", (x) => log.push(String(x)));
  const exited = () => child.exitCode !== null;
  // Bounded readiness wait: caddy must serve TLS on the port.
  const end = Date.now() + 15_000;
  const net = await import("node:net");
  for (;;) {
    if (exited()) throw new Error(`caddy exited during startup:\n${log.tail(40)}`);
    if (Date.now() > end) {
      child.kill("SIGKILL");
      throw new Error(`caddy did not become ready:\n${log.tail(40)}`);
    }
    const ready = await new Promise<boolean>((resolve) => {
      const sock = net.connect(port, "127.0.0.1");
      sock.once("connect", () => {
        sock.destroy();
        resolve(true);
      });
      sock.once("error", () => resolve(false));
      setTimeout(() => {
        sock.destroy();
        resolve(false);
      }, 500);
    });
    if (ready) break;
    await new Promise((r) => setTimeout(r, 100));
  }
  const waitExit = async (ms: number) => {
    const end = Date.now() + ms;
    while (child.exitCode === null && Date.now() < end) await new Promise((r) => setTimeout(r, 50));
  };
  const stop = async (signal: NodeJS.Signals = "SIGTERM") => {
    if (!exited()) {
      child.kill(signal);
      await waitExit(5000);
      if (child.exitCode === null) {
        child.kill("SIGKILL");
        await waitExit(5000);
      }
    }
    await rm(dir, { recursive: true, force: true });
  };
  return { port, httpsBase: `https://127.0.0.1:${port}`, log, stop, exited };
}
