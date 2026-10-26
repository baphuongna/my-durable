// Real PTY regression for the reported Windows failure ("cannot create a
// session" → `No session "undefined"`): the box runs the REAL backend with
// provider default and NO provider key — the exact laptop configuration
// (empty model catalog). Drives `n` → name → directory → (model step must be
// SKIPPED) → thinking level → session created, and checks the empty herd
// state + overview panel render instead of a bare table with a floating
// divider.
// Run: node tests/newsession-ui.mjs (requires tuistory).
import assert from "node:assert/strict";
import { execFile, spawn } from "node:child_process";
import { mkdtemp, mkdir, rm, writeFile, readFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { tmpdir } from "node:os";
import { createServer } from "node:net";
import { once } from "node:events";

const root = await mkdtemp(join(tmpdir(), "dpi-newsess-"));
await mkdir(join(root, "work", "project"), { recursive: true });
// Isolate from the host's pi credentials: the keyless shape under test is
// "no provider key ANYWHERE", and the dev machine running this suite has a
// fully-authenticated ~/.pi/agent.
const emptyPi = join(root, "no-pi");
await mkdir(emptyPi, { recursive: true });
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
const token = "dpi_" + "N".repeat(43);
const url = `http://127.0.0.1:${port}`;

// The device env must be exactly the Windows shape: NO provider key anywhere.
const env = {
  PATH: process.env.PATH,
  HOME: process.env.HOME,
  DPI_HOME: join(root, "home"),
  DPI_ENV_FILE: join(root, "home", "none.env"),
  DPI_TOKEN: token,
  DPI_START_DIRS: join(root, "work"),
  DPI_DEVICE_NAME: "nokey-box",
  PI_AGENT_DIR: emptyPi,
};
const devLog = join(root, "device.log");
const dev = spawn(process.execPath, ["--import", "tsx", "src/main.ts", "--port", String(port), "--host", "127.0.0.1"], {
  cwd: backendDir,
  env,
  stdio: ["ignore", (await import("node:fs")).openSync(devLog, "a"), (await import("node:fs")).openSync(devLog, "a")],
});
const devExit = new Promise((r) => dev.on("exit", r));
const auth = { authorization: `Bearer ${token}` };

const run = (cmd, args, opts = {}) =>
  new Promise((res, rej) =>
    execFile(cmd, args, { cwd: resolve(import.meta.dirname, ".."), ...opts }, (e, out) => (e ? rej(e) : res(out))),
  );

try {
  // Boot the real backend.
  let up = false;
  for (let i = 0; i < 100 && !up; i++) {
    try {
      up = (await fetch(`${url}/healthz`)).ok;
    } catch {
      await new Promise((r) => setTimeout(r, 100));
    }
  }
  assert.ok(up, "backend booted: " + (await readFile(devLog, "utf8").catch(() => "")));

  // The regression ONLY reproduces with the Windows shape: openrouter, no key.
  // Since the built-in-catalog fallback, such a device lists its models and
  // flags providerKeyMissing — creation must work THROUGH the picker now.
  const info = await (await fetch(`${url}/v1/device`, { headers: auth })).json();
  assert.equal(info.provider, "openrouter", "provider default");
  assert.ok(info.models.length > 0, `the built-in catalog must show without a key (got ${info.models.length})`);
  assert.equal(info.providerKeyMissing, true, "the device says chat needs a key");

  const session = `dpi-newsess-${Date.now()}`;
  const tui = async (...args) => String(await run("tuistory", ["-s", session, ...args]));
  await writeFile(join(root, "config.json"), JSON.stringify({ url, token, id: info.uid, name: info.name }), {
    mode: 0o600,
  });

  // Wide terminal so the OVERVIEW panel column is present (the reported layout).
  await tui(
    "launch",
    `node --import tsx ${resolve(import.meta.dirname, "harness/newsession-app.ts")} ${join(root, "config.json")}`,
    "--background",
    "--cols",
    "110",
    "--rows",
    "30",
  );
  await tui("wait", "no sessions yet", "--timeout", "8000");
  const empty = await tui("snapshot", "--trim");

  assert.match(empty, /no sessions yet on this device/, "empty state, not a bare table");
  assert.match(empty, /OVERVIEW[\s\S]*nokey-box/, "overview panel carries the device, not blanks");
  assert.match(empty, /n new session/, "the empty state teaches the next move");
  console.log("PASS R01 empty herd shows a guided empty state + device overview panel");

  // n → typed name → enter: this used to run the wrong command (/new agent)
  // and die with `No session "undefined"`.
  await tui("press", "n");
  await tui("wait", "new session", "--timeout", "3000");
  await tui("type", "scratch");
  await tui("press", "enter");
  await tui("wait", "Working directory", "--timeout", "5000");
  await new Promise((r) => setTimeout(r, 400)); // let the overlay take the keyboard
  // The first screen is the virtual "start dirs" root (no Use/parent entry):
  // drilling in lands on a real folder, where "✓ Use …" is the first item.
  await tui("press", "enter");
  await tui("wait", "✓ Use", "--timeout", "5000");
  await new Promise((r) => setTimeout(r, 300));
  await tui("press", "enter");
  // The model picker now shows the BUILT-IN catalog on a keyless device, with
  // the hint that chat needs a key; enter takes the first model.
  await tui("wait", "Model (", "--timeout", "5000");
  assert.match(await tui("snapshot", "--trim"), /no API key on this device/, "the keyless hint must be visible");
  await tui("press", "enter");
  // The thinking step: after the model, before the create. The backend's
  // create default ("medium") must be preselected, and the level picked here
  // must reach the created session's agent config.
  await tui("wait", "Thinking level", "--timeout", "5000");
  assert.match(await tui("snapshot", "--trim"), /→ medium/, "medium (create default) is preselected");
  await tui("press", "j");
  assert.match(await tui("snapshot", "--trim"), /→ high/, "j moves the selection off the default");
  await tui("press", "enter");
  // A successful create attaches straight into the agent view — waiting for the
  // flash text is a race; the attached session address is the real signal.
  await tui("wait", "scratch › #1", "--timeout", "10000").catch(async (e) => {
    console.log("---- stuck screen:\n" + (await tui("snapshot", "--trim")) + "\n----");
    throw e;
  });
  const after = await tui("snapshot", "--trim");
  assert.doesNotMatch(after, /No session "undefined"/, "the reported error must be gone");
  assert.match(after, /1 session/, "the header counts the new session");
  console.log("PASS R02 n › name › directory › model › thinking (high) creates a session");

  const sessions = await (await fetch(`${url}/v1/sessions`, { headers: auth })).json();
  const created = sessions.find((s) => s.name === "scratch");
  assert.ok(created, "the session exists on the device");
  console.log("PASS R03 the created session is really on the device");
  const rootAgent = created.agents.find((a) => a.kind === "root") ?? created.agents[0];
  const config = await (
    await fetch(`${url}/v1/sessions/${created.id}/agents/${rootAgent.id}/config`, { headers: auth })
  ).json();
  assert.equal(config.thinkingLevel, "high", "the picked thinking level reached the created agent");
  console.log("PASS R04 the thinking step's choice (high) is the created agent's config");

  // Esc at the thinking step cancels the WHOLE flow — nothing reaches the device.
  await tui("press", "n");
  await tui("type", "aborted");
  await tui("press", "enter");
  await tui("wait", "Working directory", "--timeout", "5000");
  await new Promise((r) => setTimeout(r, 400));
  await tui("press", "enter");
  await tui("wait", "✓ Use", "--timeout", "5000");
  await new Promise((r) => setTimeout(r, 300));
  await tui("press", "enter");
  await tui("wait", "Model (", "--timeout", "5000");
  await tui("press", "enter");
  await tui("wait", "Thinking level", "--timeout", "5000");
  await tui("press", "escape");
  await new Promise((r) => setTimeout(r, 500));
  const cancelled = await tui("snapshot", "--trim");
  assert.doesNotMatch(cancelled, /Thinking level/, "esc closed the picker");
  assert.doesNotMatch(cancelled, /Working directory/, "the whole flow is gone, not just the last step");
  const afterEsc = await (await fetch(`${url}/v1/sessions`, { headers: auth })).json();
  assert.ok(!afterEsc.some((s) => s.name === "aborted"), "esc at the thinking step created nothing");
  console.log("PASS R05 esc at the thinking step cancels the whole flow");

  await tui("close");
} finally {
  await rm(root, { recursive: true, force: true }).catch(() => {});
  if (dev.exitCode === null) {
    dev.kill("SIGTERM");
    await Promise.race([devExit, new Promise((r) => setTimeout(r, 3000))]);
  }
}
console.log("newsession-ui: ALL PASS");
