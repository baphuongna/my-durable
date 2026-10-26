/**
 * Navigation redesign (v0.0.52) — real PTY regression for the digit keys.
 * Digits 5-9 must notify (src/app.ts jump(): "views are 1-4 …") and never
 * switch views; digits typed into an open input line (/, :) land in the line;
 * digits while the help overlay (?) is open close it without switching views.
 * Same harness pattern as tests/keymap-ui.mjs (backend + tuistory).
 * Run: node tests/navredesign-ui.mjs (requires tuistory).
 */
import assert from "node:assert/strict";
import { execFile, spawn } from "node:child_process";
import { mkdir, rm } from "node:fs/promises";
import { mkdtempSync, openSync } from "node:fs";
import { join, resolve } from "node:path";
import { tmpdir } from "node:os";
import { createServer } from "node:net";
import { once } from "node:events";

const root = mkdtempSync(join(tmpdir(), "dpi-nav-"));
for (const dir of ["alpha", "beta"]) await mkdir(join(root, "work", dir), { recursive: true });
const backendDir = resolve(import.meta.dirname, "../../dpi-backend");

const freePort = async () => {
  const probe = createServer();
  probe.listen(0, "127.0.0.1");
  await once(probe, "listening");
  const { port } = probe.address();
  await new Promise((r) => probe.close(r));
  return port;
};
const port = await freePort();
const token = "dpi_" + "K".repeat(43);
const url = `http://127.0.0.1:${port}`;
const auth = { authorization: `Bearer ${token}`, "content-type": "application/json" };

const dev = spawn(process.execPath, ["--import", "tsx", "src/main.ts", "--port", String(port), "--host", "127.0.0.1"], {
  cwd: backendDir,
  env: {
    PATH: process.env.PATH,
    HOME: process.env.HOME,
    DPI_HOME: join(root, "home"),
    DPI_ENV_FILE: join(root, "home", "none.env"),
    DPI_TOKEN: token,
    DPI_PROVIDER: "faux",
    DPI_START_DIRS: join(root, "work"),
    DPI_DEVICE_NAME: "navbox",
  },
  stdio: ["ignore", openSync(join(root, "dev.log"), "a"), openSync(join(root, "dev.log"), "a")],
});
const devExit = new Promise((r) => dev.on("exit", r));
const run = (cmd, args) =>
  new Promise((res, rej) =>
    execFile(cmd, args, { cwd: resolve(import.meta.dirname, "..") }, (e, out) => (e ? rej(e) : res(String(out)))),
  );

const session = `dpi-nav-${Date.now()}`;
const tui = (...args) => run("tuistory", ["-s", session, ...args]);
const snap = () => tui("snapshot", "--trim");
const press = async (...keys) => {
  await tui("press", ...keys);
  await new Promise((r) => setTimeout(r, 450));
};
const type = async (text) => {
  await tui("type", text);
  await new Promise((r) => setTimeout(r, 200));
};

// Per-view screen markers (same ones keymap-ui.mjs asserts on).
const onNetwork = async (s) => assert.match(s ?? (await snap()), /navbox/, "expected the network view");
const onHerd = async (s) => assert.match(s ?? (await snap()), /NAME\s+STATE\s+AGENTS/, "expected the herd table");
const onAgent = async (s) => assert.match(s ?? (await snap()), /› \S+ › #1/, "expected the agent view");
const onLog = async (s) => assert.match(s ?? (await snap()), /events · this client/, "expected the log view");
const notNetwork = (s) => assert.doesNotMatch(s, /navbox.*\[local\]/, "view switched to network unexpectedly");

const reset = async () => {
  for (let i = 0; i < 4; i += 1) {
    await tui("press", "esc").catch(() => {});
    await new Promise((r) => setTimeout(r, 120));
  }
  await press("1"); // a known home: the network view
};

let failures = 0;
const check = async (name, fn) => {
  try {
    await reset();
    await fn();
    console.log(`PASS ${name}`);
  } catch (error) {
    failures += 1;
    console.log(`FAIL ${name}: ${error.message.split("\n")[0]}`);
    const screen = await snap().catch(() => "");
    console.log(screen.split("\n").slice(0, 14).join("\n"));
  }
};

try {
  let up = false;
  for (let i = 0; i < 120 && !up; i++) {
    try {
      up = (await fetch(`${url}/healthz`)).ok;
    } catch {
      await new Promise((r) => setTimeout(r, 100));
    }
  }
  assert.ok(up, "backend booted");
  for (const name of ["alpha", "beta"]) {
    const res = await fetch(`${url}/v1/sessions`, {
      method: "POST",
      headers: auth,
      body: JSON.stringify({ name, cwd: join(root, "work", name), model: { provider: "faux", modelId: "echo" } }),
    });
    assert.equal(res.status, 201, await res.text());
  }

  await tui("launch", `node --import tsx src/main.ts --url ${url} --token ${token}`, "--background", "--cols", "120", "--rows", "26");
  await tui("wait", "1 network", "--timeout", "20000");

  // -------------------------------------------------- (a pty) digits 1-4 switch
  await check("digits: 2 herd, 1 network, 4 log, 3 agent — in VIEW_TABS order", async () => {
    await press("2");
    await onHerd();
    // Open a session so the agent view has something to show (enter on the row).
    await press("enter");
    await press("1");
    await onNetwork();
    await press("4");
    await onLog();
    await press("3");
    await onAgent();
  });

  // -------------------------------------------------- (b) digits 5-9: notify only
  await check("digits: 5 shows the 'views are 1-4' hint and never switches views", async () => {
    await press("5");
    const screen = await snap();
    assert.match(screen, /views are 1-4/, "digit 5 produced no hint");
    await onNetwork(screen);
  });

  await check("digits: 6-9 each hint and never switch views", async () => {
    for (const d of ["6", "7", "8", "9"]) {
      await press(d);
      const screen = await snap();
      assert.match(screen, /views are 1-4/, `digit ${d} produced no hint`);
      assert.doesNotMatch(screen, /NAME\s+STATE\s+AGENTS/, `digit ${d} switched to the herd`);
      assert.doesNotMatch(screen, /events · this client/, `digit ${d} switched to the log`);
    }
    await onNetwork();
  });

  // --------------------------------- (c) digits go into an open message input
  await check("digits: '3' typed after / lands in the input line, view unchanged", async () => {
    await press("/");
    await type("3");
    const screen = await snap();
    assert.match(screen, /follow-up ❯ \/3/, "'3' did not land in the message line");
    notNetwork(screen);
    await press("escape");
  });

  // ------------------------------------------- (d) overlays swallow the digits
  await check("digits: '?' help overlay open — a digit closes help but never switches views", async () => {
    await press("?");
    let screen = await snap();
    assert.match(screen, /keys|help/i, "help overlay did not open");
    await press("2");
    screen = await snap();
    assert.doesNotMatch(screen, /NAME\s+STATE\s+AGENTS/, "digit switched views from under the help overlay");
    assert.match(screen, /navbox/, "not back on the network view");
    await onNetwork(screen);
  });

  await check("digits: ':' palette open — a digit lands in the palette line, never switches views", async () => {
    await press(":");
    let screen = await snap();
    assert.match(screen, /palette/i, "palette line did not open");
    await type("3");
    screen = await snap();
    assert.match(screen, /:.*3/, "digit did not land in the palette input");
    assert.doesNotMatch(screen, /NAME\s+STATE\s+AGENTS/, "digit switched views from under the palette");
    assert.doesNotMatch(screen, /events · this client/, "digit switched to the log from under the palette");
    await press("escape");
  });

  // ------------------------------------------- (e) t cycles the agent's tabs
  await check("t: agent view — advances the tab, same observable as ]", async () => {
    await press("3"); // digit 3 returns to the open session's agent view
    const s0 = await snap();
    await onAgent(s0);
    const body = (s) => s.split("\n").slice(6, 12).join("\n");
    const home = body(s0);
    await press("]");
    const afterBracket = body(await snap());
    assert.notEqual(afterBracket, home, "] did not advance the agent tab");
    await press("["); // rewind, then t must land exactly where ] did
    await press("t");
    assert.equal(body(await snap()), afterBracket, "t did not advance the agent tab like ]");
  });

  // ------------------------------------- (f) help overlay teaches the new model
  // Live against the RENDERED overlay: panelLine/place clip by visible
  // width now (src/app.ts), so the right column — "views: net/herd/agent/log",
  // "same views, aliases" — must actually be on screen, not just in src.
  await check("help: '?' teaches 1-4 views + aliases, not 'jump to session'", async () => {
    await press("?");
    const screen = await snap();
    assert.match(screen, /views: net\/herd\/agent\/log/, "help's right column did not render");
    assert.match(screen, /same views, aliases/, "the alias row did not render");
    assert.match(screen, /\[ \] t\s+agent tabs/, "rendered help does not teach t for agent tabs");
    assert.doesNotMatch(screen, /jump to session/, "help still teaches the old digit model");
    assert.doesNotMatch(screen, /1-9/, "old digit range still on screen");
  });
} finally {
  await tui("close").catch(() => {});
  await rm(root, { recursive: true, force: true }).catch(() => {});
  if (dev.exitCode === null) {
    dev.kill("SIGTERM");
    await Promise.race([devExit, new Promise((r) => setTimeout(r, 3000))]);
  }
}
if (failures) {
  console.error(`\nnavredesign-ui: ${failures} check(s) broken`);
  process.exit(1);
}
console.log("\nnavredesign-ui: ALL PASS");
