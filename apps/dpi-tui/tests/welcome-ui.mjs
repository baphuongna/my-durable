// Real PTY regression: bare `dpi-tui` with an empty registry boots the welcome
// screen — the app, not usage text. Run: node tests/welcome-ui.mjs (requires tuistory).
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { mkdtemp, rm } from "node:fs/promises";
import { join, resolve } from "node:path";
import { tmpdir } from "node:os";

const run = promisify(execFile);
const root = await mkdtemp(join(tmpdir(), "dpi-welcome-pty-"));
const session = `dpi-welcome-${Date.now()}`;
const tui = (...args) => run("tuistory", ["-s", session, ...args], { cwd: resolve(import.meta.dirname, "..") }).then((r) => r.stdout);
const waitUntilGone = async (pattern, timeout = 5000) => {
  const end = Date.now() + timeout;
  for (;;) {
    const screen = await tui("snapshot", "--trim");
    if (!pattern.test(screen)) return screen;
    if (Date.now() > end) assert.fail(`${pattern} still on screen after ${timeout} ms:\n${screen}`);
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
};
try {
  // Empty registry: scratch DPI_HOME; INIT_CWD stops the dpi-network.yaml walk-up.
  await tui(
    "launch",
    `env -u DPI_TOKEN -u DPI_PORT -u DPI_URL -u DPI_DEVICE DPI_HOME=${root} INIT_CWD=${root} node --import tsx src/main.ts`,
    "--background",
    "--cols",
    "100",
    "--rows",
    "32",
  );
  await tui("wait", "No device yet.", "--timeout", "20000");
  const screen = await tui("snapshot", "--trim");
  assert.match(screen, /Pair this machine/);
  assert.match(screen, /Add a device by URL/);
  assert.match(screen, /Detect the local backend/);
  assert.doesNotMatch(screen, /usage: dpi-tui/);
  console.log("PASS bare dpi-tui with no saved devices opens the welcome screen, not usage");

  // [d] with nothing listening: the plain failure line, then welcome returns.
  await tui("type", "d");
  await tui("press", "enter");
  await tui("wait", "no local dpi-backend on 127.0.0.1:4780", "--timeout", "5000");
  await tui("wait", "No device yet.", "--timeout", "5000");
  console.log("PASS detect-local with no backend says how to start one and returns to welcome");

  // q quits the app cleanly.
  await tui("press", "q");
  await waitUntilGone(/No device yet\./);
  console.log("PASS q quits the welcome screen");
} catch (error) {
  const screen = await tui("snapshot", "--trim").catch(() => "");
  console.error(`welcome screen at failure:\n${screen}`);
  throw error;
} finally {
  await tui("close").catch(() => {});
  await rm(root, { recursive: true, force: true });
}
