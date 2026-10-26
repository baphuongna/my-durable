/**
 * Welcome overlay Esc behavior (v0.0.52 redesign): Esc must never surprise-quit.
 * With a hub configured (DPI_HUB_URL/DPI_HUB_TOKEN) Esc closes the welcome
 * overlay into the network view; without one the app exits (src/welcome.ts).
 * Reached via the unreachable-saved-device fallback (main.ts passes hubEnv to
 * showWelcome), because a clean no-device boot with hub creds skips the
 * welcome wall entirely (hub-first boot). Same harness pattern as
 * tests/welcome-ui.mjs. Run: node tests/welcome-esc-ui.mjs (requires tuistory).
 */
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { mkdtemp, rm } from "node:fs/promises";
import { join, resolve } from "node:path";
import { tmpdir } from "node:os";

const run = promisify(execFile);
const cwd = resolve(import.meta.dirname, "..");
const root = await mkdtemp(join(tmpdir(), "dpi-wesc-"));
const session = `dpi-wesc-${Date.now()}`;

// Seed one saved device whose URL is dead AND non-loopback (192.0.2.0/24 =
// TEST-NET): the auto-open path fails fast and falls back to the welcome
// screen with the notice — the one reachable hub-configured welcome path.
await run(
  process.execPath,
  [
    "--import",
    "tsx",
    "-e",
    `import { NetworkRegistry } from ${JSON.stringify(resolve(cwd, "../dpi-sdk/src/node/registry.ts"))};
     new NetworkRegistry().upsert({ id: "ghost", name: "ghost", kind: "url", transport: "lan", url: "http://192.0.2.1:47126", token: "dpi_" + "G".repeat(43) });`,
  ],
  { env: { ...process.env, DPI_HOME: root } },
).catch((e) => assert.fail(`registry seed failed: ${e.message}`));

const tui = (...args) => run("tuistory", ["-s", session, ...args], { cwd }).then((r) => r.stdout);
const statusOf = async (name) => {
  const { stdout: list } = await run("tuistory", ["sessions"]).catch(() => ({ stdout: "" }));
  const i = list.split("\n").findIndex((l) => l.includes(name));
  return i >= 0 ? list.split("\n")[i + 1] ?? "" : "";
};

try {
  // ---- WITH hub: Esc closes into the network view, app stays alive.
  await tui(
    "launch",
    `env -u DPI_TOKEN -u DPI_URL -u DPI_DEVICE DPI_HUB_URL=http://127.0.0.1:47125 DPI_HUB_TOKEN=dpi_${"H".repeat(43)} DPI_HOME=${root} INIT_CWD=${root} node --import tsx src/main.ts`,
    "--background",
    "--cols",
    "100",
    "--rows",
    "32",
  );
  await tui("wait", "No device yet.", "--timeout", "30000").catch(() => {});
  await tui("wait", "Pair this machine", "--timeout", "10000");
  const welcome = await tui("snapshot", "--trim");
  assert.match(welcome, /Browse the hub network/, `hub welcome row missing:\n${welcome}`);

  await tui("press", "escape");
  await new Promise((r) => setTimeout(r, 800));
  const screen = await tui("snapshot", "--trim");
  assert.doesNotMatch(screen, /Pair this machine/, "welcome overlay survived Esc");
  assert.match(screen, /1 network/, `no viewbar/network view after Esc-with-hub:\n${screen}`);
  const st = (await statusOf(session)).trim();
  assert.ok(!/dead/.test(st), `app exited on Esc with hub configured (status: ${st})`);
  console.log("PASS welcome: Esc with a hub configured closes into the network view (no quit)");
  await run("tuistory", ["-s", session, "close"]).catch(() => {});

  // ---- WITHOUT hub: Esc exits the app (old behavior stands).
  const session2 = `${session}-nohub`;
  const tui2 = (...args) => run("tuistory", ["-s", session2, ...args], { cwd }).then((r) => r.stdout);
  await tui2(
    "launch",
    `env -u DPI_TOKEN -u DPI_URL -u DPI_DEVICE -u DPI_HUB_URL -u DPI_HUB_TOKEN DPI_HOME=${root} INIT_CWD=${root} node --import tsx src/main.ts`,
    "--background",
    "--cols",
    "100",
    "--rows",
    "32",
  );
  await tui2("wait", "Pair this machine", "--timeout", "30000");
  await tui2("press", "escape");
  let dead = false;
  for (let i = 0; i < 30 && !dead; i++) {
    dead = /dead/.test(await statusOf(session2));
    if (!dead) await new Promise((r) => setTimeout(r, 200));
  }
  assert.ok(dead, "app survived Esc with NO hub configured (should quit)");
  console.log("PASS welcome: Esc with no hub exits the app");
} catch (error) {
  console.error(`welcome-esc-ui FAIL: ${error.message}`);
  const screen = await tui("snapshot", "--trim").catch(() => "");
  console.error(screen);
  process.exitCode = 1;
} finally {
  await run("tuistory", ["-s", session, "close"]).catch(() => {});
  await run("tuistory", ["-s", `${session}-nohub`, "close"]).catch(() => {});
  await rm(root, { recursive: true, force: true }).catch(() => {});
}
