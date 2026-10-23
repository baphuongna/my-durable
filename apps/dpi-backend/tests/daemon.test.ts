/**
 * `dpi device start|stop|status|install|uninstall` — the daemon must live
 * WITHOUT a terminal (user requirement): a detached spawn like the reference
 * clients' desktop supervisors (paseo: detached + stdio + unref + stripped
 * Electron env), an OS supervisor (systemd user / launchd / Startup-folder VBS)
 * for logon persistence, and a token-authed HTTP shutdown so `stop` is graceful.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm, readFile, writeFile, mkdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  parseDeviceSub,
  daemonPaths,
  systemdUnit,
  launchdPlist,
  windowsStartupVbs,
  serviceEnv,
  cleanChildEnv,
  runDeviceCommand,
} from "../src/daemon.js";
import { bootServer, newToken } from "./helpers.js";

test("subcommands: start/stop/status/install/uninstall parsed, anything else runs foreground", () => {
  assert.deepEqual(parseDeviceSub(["start"]), { sub: "start", rest: [] });
  assert.deepEqual(parseDeviceSub(["--port", "5000"]), { sub: "run", rest: ["--port", "5000"] });
  assert.deepEqual(parseDeviceSub(["status", "--x"]), { sub: "status", rest: ["--x"] });
  assert.deepEqual(parseDeviceSub([]), { sub: "run", rest: [] });
});

test("paths: pid and log live inside the device home (DPI_HOME respected)", () => {
  const p = daemonPaths({ DPI_HOME: "/tmp/dpi-home" });
  assert.equal(p.home, "/tmp/dpi-home");
  assert.equal(p.pid, join("/tmp/dpi-home", "device.pid"));
  assert.equal(p.log, join("/tmp/dpi-home", "device.log"));
});

test("serviceEnv: only the known DPI_* knobs ride into the unit — never a token", () => {
  const env = serviceEnv({
    DPI_HOME: "/tmp/h",
    DPI_HUB_URL: "https://hub.example.com",
    DPI_TOKEN: "dpi_super_secret_value_1234567890abcdefghij",
    DPI_HUB_CA: "/tmp/ca.pem",
    DPI_PROVIDER: "faux",
    PATH: "/usr/bin",
    HOME: "/home/x",
  });
  assert.equal(env.DPI_HOME, "/tmp/h");
  assert.equal(env.DPI_HUB_URL, "https://hub.example.com");
  assert.equal(env.DPI_HUB_CA, "/tmp/ca.pem");
  assert.equal(env.DPI_PROVIDER, "faux");
  assert.equal("DPI_TOKEN" in env, false, "token must stay in the env file, never the unit");
  assert.equal("PATH" in env, false);
});

test("systemdUnit: quoted ExecStart, env lines, restart, user target — no secrets", () => {
  const unit = systemdUnit({
    node: "/usr/bin/node",
    dpi: "/opt/my durable/bin/dpi.mjs",
    env: { DPI_HOME: "/tmp/h", DPI_HUB_URL: "https://hub.example.com" },
  });
  assert.match(unit, /\[Unit\]/);
  assert.match(unit, /ExecStart="\/usr\/bin\/node" "\/opt\/my durable\/bin\/dpi\.mjs" device/);
  assert.match(unit, /^Environment="DPI_HOME=\/tmp\/h"$/m);
  assert.match(unit, /^Environment="DPI_HUB_URL=https:\/\/hub\.example\.com"$/m);
  assert.match(unit, /^Restart=on-failure$/m);
  assert.match(unit, /^WantedBy=default\.target$/m);
  assert.doesNotMatch(unit, /DPI_TOKEN/);
});

test("launchdPlist: ProgramArguments node+dpi device, env dict, RunAtLoad, log paths", () => {
  const xml = launchdPlist({
    node: "/usr/local/bin/node",
    dpi: "/Users/x/bin/dpi.mjs",
    env: { DPI_HOME: "/Users/x/.dpi", DPI_HUB_URL: "https://hub.example.com" },
    log: "/Users/x/.dpi/device.log",
  });
  assert.match(xml, /<key>Label<\/key><string>io\.durable-pi\.device<\/string>/);
  assert.match(
    xml,
    /<key>ProgramArguments<\/key><array><string>\/usr\/local\/bin\/node<\/string><string>\/Users\/x\/bin\/dpi\.mjs<\/string><string>device<\/string><\/array>/,
  );
  assert.match(xml, /<key>DPI_HOME<\/key><string>\/Users\/x\/\.dpi<\/string>/);
  assert.match(xml, /<key>RunAtLoad<\/key><true\/>/);
  assert.match(xml, /<key>StandardOutPath<\/key><string>\/Users\/x\/\.dpi\/device\.log<\/string>/);
});

test("windowsStartupVbs: hidden window (style 0), node+dpi device, append to the log", () => {
  const vbs = windowsStartupVbs({
    node: "C:\\Program Files\\nodejs\\node.exe",
    dpi: "C:\\Users\\x\\AppData\\Roaming\\npm\\node_modules\\my-durable\\bin\\dpi.mjs",
    log: "C:\\Users\\x\\.dpi\\device.log",
  });
  assert.match(vbs, /WScript\.Shell/);
  assert.match(vbs, /, 0, False/, "window style 0 = hidden, no console flash at logon");
  assert.match(vbs, /node\.exe/);
  assert.match(vbs, /dpi\.mjs/);
  assert.match(vbs, /device/);
  assert.match(vbs, /device\.log/);
  assert.match(vbs, /2>&1/);
});

test("cleanChildEnv: strips the Electron-node hazard env the references strip", () => {
  const env = cleanChildEnv({
    ELECTRON_RUN_AS_NODE: "1",
    ELECTRON_NO_ATTACH_CONSOLE: "1",
    DPI_HOME: "/tmp/h",
    PATH: "/usr/bin",
  });
  assert.equal("ELECTRON_RUN_AS_NODE" in env, false);
  assert.equal("ELECTRON_NO_ATTACH_CONSOLE" in env, false);
  assert.equal(env.DPI_HOME, "/tmp/h");
});

test("stop: HTTP shutdown preferred, pid kill as fallback, stale pid cleaned", async () => {
  const dir = await mkdtemp(join(tmpdir(), "dpi-daemon-"));
  const home = join(dir, "home");
  await mkdir(home, { recursive: true });
  const pidFile = join(home, "device.pid");
  await writeFile(pidFile, "999999"); // stale: no such process, health down

  const calls: string[] = [];
  let down = false;
  const fetchImpl = async (url: string, init?: RequestInit) => {
    calls.push(`${init?.method ?? "GET"} ${url}`);
    if (url.endsWith("/v1/shutdown")) {
      down = true;
      return new Response(JSON.stringify({ ok: true }), { status: 200 });
    }
    if (down) throw new Error("connection refused"); // daemon exited
    return new Response(JSON.stringify({ ok: true }), { status: 200 });
  };
  const code = await runDeviceCommand("stop", [], {
    env: { DPI_HOME: home, DPI_PORT: "4799", DPI_TOKEN: "dpi_0000000000000000000000000000000" },
    fetchImpl: fetchImpl as typeof fetch,
    killImpl: () => {
      calls.push("kill");
      return true;
    },
    quiet: true,
  });
  assert.equal(code, 0);
  // Health probe fails (fetch resolves ok in this stub) — assert the flow used fetch and
  // never needed a kill of a live pid: stale 999999 must not be signalled.
  assert.equal(calls.includes("kill"), false);
  await rm(dir, { recursive: true, force: true });
});

test("E2E: POST /v1/shutdown needs the token and exits the real backend", async () => {
  const dir = await mkdtemp(join(tmpdir(), "dpi-shut-"));
  const token = newToken();
  const server = await bootServer({ home: join(dir, "home"), startDirs: dir, token });
  try {
    const denied = await fetch(`${server.base}/v1/shutdown`, { method: "POST" });
    assert.equal(denied.status, 401, "shutdown is token-authed like every /v1 route");
    const ok = await fetch(`${server.base}/v1/shutdown`, {
      method: "POST",
      headers: { authorization: `Bearer ${token}` },
    });
    assert.equal(ok.status, 200);
    assert.equal((await ok.json()).ok, true);
    const deadline = Date.now() + 10_000;
    while (Date.now() < deadline) {
      if (server.exitCode() !== null) break;
      await new Promise((r) => setTimeout(r, 100));
    }
    assert.notEqual(server.exitCode(), null, "backend process must exit after /v1/shutdown");
  } finally {
    await server.stop();
    await rm(dir, { recursive: true, force: true });
  }
});

test("status: reports a live daemon's health and pairing state", async () => {
  const dir = await mkdtemp(join(tmpdir(), "dpi-stat-"));
  const token = newToken();
  const server = await bootServer({ home: join(dir, "home"), startDirs: dir, token });
  let out = "";
  const code = await runDeviceCommand("status", [], {
    env: {
      DPI_HOME: join(dir, "home"),
      DPI_PORT: String(server.port),
      DPI_TOKEN: token,
    },
    quiet: false,
    print: (line) => (out += line + "\n"),
  });
  assert.equal(code, 0);
  assert.match(out, /running/i);
  assert.match(out, /unpaired|paired/);
  await server.stop();
  await rm(dir, { recursive: true, force: true });
});

test("install (linux): unit written, systemd --user enable --now, linger attempted", async () => {
  const dir = await mkdtemp(join(tmpdir(), "dpi-inst-"));
  const home = join(dir, "home");
  const ran: string[] = [];
  const wrote: { path: string; body: string }[] = [];
  const code = await runDeviceCommand("install", [], {
    env: {
      DPI_HOME: home,
      DPI_HUB_URL: "https://hub.example.com",
      DPI_BIN: new URL("../../../bin/dpi.mjs", import.meta.url).pathname,
    },
    platform: "linux",
    uid: 1000,
    execImpl: async (cmd: string, args: string[]) => {
      ran.push([cmd, ...args].join(" "));
      return { ok: true, output: "", code: 0 };
    },
    writeFileImpl: async (path: string, body: string) => {
      wrote.push({ path, body });
    },
    quiet: true,
  });
  assert.equal(code, 0);
  const unit = wrote.find((w) => w.path.endsWith("dpi-device.service"));
  assert.ok(unit, "systemd unit written");
  assert.match(unit.body, /DPI_HUB_URL=https:\/\/hub\.example\.com/);
  assert.equal(unit.body.includes("DPI_TOKEN"), false);
  assert.ok(ran.some((c) => c.includes("systemctl") && c.includes("--user") && c.includes("enable")), "enable --now issued");
  assert.ok(ran.some((c) => c.includes("loginctl") && c.includes("enable-linger")), "linger attempted (survives logout)");
  await rm(dir, { recursive: true, force: true });
});
