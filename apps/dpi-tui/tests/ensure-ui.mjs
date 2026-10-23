// Real PTY regression for the "Vào nhưng báo không kết nối đến dpi-backend"
// report: on a machine where nothing is listening, [d] must START the local
// backend itself (herdr spawns its server; so do we) and open it — not print
// "run dpi device" and strand the user in another shell.
// Launched via bin/dpi.mjs (the real launcher) so the detached spawn resolves
// the same way it does in a user's hands. Run: node tests/ensure-ui.mjs
import assert from "node:assert/strict";
import { execFile, spawn } from "node:child_process";
import { mkdtemp, rm, readFile } from "node:fs/promises";
import { createServer } from "node:net";
import { once } from "node:events";
import { join, resolve } from "node:path";
import { tmpdir } from "node:os";

const run = (cmd, args, opts) =>
  new Promise((res, rej) => execFile(cmd, args, opts, (e, out) => (e ? rej(e) : res(String(out)))));
const root = await mkdtemp(join(tmpdir(), "dpi-ensure-pty-"));
const session = `dpi-ensure-${Date.now()}`;
const tui = (...args) => run("tuistory", ["-s", session, ...args], { cwd: resolve(import.meta.dirname, "..") }).then((r) => r.stdout);
const waitMatch = async (pattern, timeout = 20000) => {
  const rx = pattern.source.replace(/\//g, "");
  await tui("wait", `/${rx}/`, "--timeout", String(timeout));
  await new Promise((r) => setTimeout(r, 400)); // let the frame settle after the match
  return tui("snapshot", "--trim");
};

const freePort = async () => {
  const probe = createServer();
  probe.listen(0, "127.0.0.1");
  await once(probe, "listening");
  const { port } = probe.address();
  await new Promise((r) => probe.close(r));
  return port;
};
const port = await freePort();
const pkgRoot = resolve(import.meta.dirname, "../../..");
const home = join(root, "home");

let backendPid;
try {
  // The user's exact entry point: dpi tui, empty registry, nothing listening.
  await tui(
    "launch",
    `env -u DPI_TOKEN -u DPI_URL -u DPI_DEVICE DPI_PORT=${port} DPI_HOME=${home} INIT_CWD=${root} DPI_PROVIDER=faux DPI_START_DIRS=${root} DPI_DEVICE_NAME=ensurebox node ${pkgRoot}/bin/dpi.mjs tui`,
    "--background",
    "--cols",
    "120",
    "--rows",
    "34",
  );
  await tui("wait", "No device yet.", "--timeout", "20000");
  console.log("PASS empty machine boots the welcome screen");

  // [d]: probe fails → TUI starts the backend itself → save+open appears → enter opens it.
  // Content asserts use `tuistory wait` (output-buffer match): the backend's boot
  // lines race the PTY emulator and a snapshot taken right then can read "undefined".
  await tui("type", "d");
  await waitMatch(/Local backend: ensurebox/, 30000);
  await waitMatch(/Save as/, 5000);
  console.log("PASS [d] auto-started the local dpi-backend and offers to save it");
  await tui("press", "enter");
  await waitMatch(/OVERVIEW/, 15000);
  await waitMatch(/ensurebox/, 5000);
  console.log("PASS enter saved + opened the auto-started device");

  // The backend must be a real detached process, alive after the TUI closes.
  await tui("press", "q");
  await new Promise((r) => setTimeout(r, 600));
  await tui("close").catch(() => {});
  const r = await fetch(`http://127.0.0.1:${port}/healthz`);
  assert.equal(r.status, 200, "backend still serving after the TUI exited");
  const env = await readFile(join(home, "backend.env"), "utf8");
  assert.match(env, /DPI_TOKEN=/, "first boot wrote backend.env with a token");
  console.log("PASS backend survives the TUI and bootstrapped its token");
} catch (error) {
  const screen = await tui("snapshot", "--trim").catch(() => "");
  const raw = await tui("read", "--all").catch(() => "");
  console.error(`screen at failure:\n${screen}`);
  console.error(`raw output (last 2000 chars):\n${String(raw).slice(-2000)}`);
  console.error(`device log:\n${await readFile(join(home, "device.log"), "utf8").catch(() => "(none)")}`);
  throw error;
} finally {
  // Leave nothing behind: token-authed shutdown like `dpi device stop`.
  try {
    const env = await readFile(join(home, "backend.env"), "utf8");
    const token = env.match(/DPI_TOKEN=(\S+)/)?.[1];
    if (token) await fetch(`http://127.0.0.1:${port}/v1/shutdown`, { method: "POST", headers: { authorization: `Bearer ${token}` } });
  } catch {}
  if (!process.env.ENSURE_KEEP) {
    await tui("close").catch(() => {});
    await rm(root, { recursive: true, force: true }).catch(() => {});
  }
  void backendPid;
  void spawn;
}
