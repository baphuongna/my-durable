// Real PTY regressions: node tests/pairing-ui.mjs (requires tuistory).
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { cp, mkdtemp, mkdir, writeFile, rm } from "node:fs/promises";
import { join, resolve } from "node:path";
import { tmpdir } from "node:os";

const root = await mkdtemp(join(tmpdir(), "dpi-pair-pty-"));
const session = `durable-pair-fixes-${Date.now()}`;
// Screens and screenshots are scratch while the run passes; only a failed run copies them into the repo.
const scratch = join(root, "evidence");
const keepEvidence = async () => {
  const kept = resolve(import.meta.dirname, "../../../artifacts/verification", `tui-pairing-${Date.now()}`, "ui-evidence");
  await mkdir(kept, { recursive: true });
  await cp(scratch, kept, { recursive: true });
  return kept;
};
const token = "dpi_" + "T".repeat(43);
let releaseStart;
let startGate = new Promise((resolve) => { releaseStart = resolve; });
let startFinished;
let pending = false;
let cancels = 0;
let rejectCancel = false;
let incumbent = false;
let lastError;
let statusReads = 0;
const fingerprint = `sha256:${"d".repeat(64)}`;
const status = () => ({
  state: incumbent ? "paired" : pending ? "pairing" : "unpaired", fingerprint, deviceUid: "fixture-uid", deviceName: "Fixture",
  ...(incumbent ? { hubOrigin: "https://old.example.com", generation: 1 } : {}),
  ...(lastError ? { lastError } : {}),
  ...(pending ? { pending: { hubOrigin: "https://fixture.invalid", startedAt: Date.now(), note: "polling for approval" } } : {}),
});
const server = createServer(async (req, res) => {
  if (req.headers.authorization !== `Bearer ${token}`) return void res.writeHead(401).end();
  if (req.url === "/v1/pairing") statusReads++;
  if (req.url === "/v1/pairing/start") {
    await startGate;
    pending = true;
  }
  if (req.url === "/v1/pairing/cancel") {
    cancels++;
    if (rejectCancel) {
      res.writeHead(503, { "content-type": "application/json" });
      return void res.end(JSON.stringify({ error: { code: "unavailable", message: "fixture cancellation unavailable" } }));
    }
    pending = false;
  }
  res.setHeader("content-type", "application/json");
  res.end(JSON.stringify(status()));
  if (req.url === "/v1/pairing/start") startFinished?.();
});
await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
await writeFile(join(root, "config.json"), JSON.stringify({ port: server.address().port, token }), { mode: 0o600 });
const run = promisify(execFile);
const tui = async (...args) => (await run("tuistory", ["-s", session, ...args], { cwd: resolve(import.meta.dirname, "..") })).stdout;
const waitUntilGone = async (pattern, timeout = 3000) => {
  const end = Date.now() + timeout;
  for (;;) {
    const screen = await tui("snapshot", "--trim");
    if (!pattern.test(screen)) return screen;
    if (Date.now() > end) assert.fail(`${pattern} still on screen after ${timeout} ms:\n${screen}`);
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
};
try {
  await tui("launch", `node --import tsx ${resolve(import.meta.dirname, "harness/pairing-app.ts")} ${join(root, "config.json")}`,
    "--background", "--cols", "100", "--rows", "32");
  await tui("wait", "Starting…", "--timeout", "4000");
  releaseStart();
  await tui("wait", "Awaiting approval", "--timeout", "3000");
  assert.equal(pending, true);
  console.log("PASS R06 asynchronous pairing state repaints without any keypress");
  const dismissals = [["esc"], ["enter"], ["q"], ["ctrl", "c"]];
  for (const [index, keys] of dismissals.entries()) {
    if (index) {
      await tui("type", "/pair ABCD2345 --hub https://fixture.invalid");
      await tui("press", "enter");
      await tui("wait", "Awaiting approval", "--timeout", "3000");
    }
    await tui("press", ...keys);
    await tui("wait", "Pairing panel closed", "--timeout", "3000");
    await waitUntilGone(/Pair this device/);
    assert.equal(cancels, index + 1, `${keys.join("+")} cancels the local operation once`);
  }
  console.log("PASS R06 Escape/Enter/q/Ctrl-C dismiss and cancel locally once");
  rejectCancel = true;
  await tui("type", "/pair ABCD2345 --hub https://fixture.invalid");
  await tui("press", "enter");
  await tui("wait", "Awaiting approval", "--timeout", "3000");
  await tui("press", "esc");
  await tui("wait", "cancel was not confirmed", "--timeout", "3000");
  assert.doesNotMatch(await tui("snapshot", "--trim"), /operation was cancelled/);
  assert.equal(pending, true);
  console.log("PASS R06 failed cancellation never claims it succeeded");
  rejectCancel = false;
  pending = false;
  startGate = new Promise((resolve) => { releaseStart = resolve; });
  const started = new Promise((resolve) => { startFinished = resolve; });
  await tui("type", "/pair ABCD2345 --hub https://fixture.invalid");
  await tui("press", "enter");
  await tui("wait", "Starting…", "--timeout", "3000");
  await tui("press", "ctrl", "c");
  await waitUntilGone(/Pair this device/);
  releaseStart();
  await started;
  await tui("wait", "local operation was cancelled", "--timeout", "3000");
  assert.equal(pending, false, "a late start cannot leave a local pairing running after dismissal");
  assert.equal(cancels, 6);
  console.log("PASS R06 dismissal during start cancels the late local operation once");
  incumbent = true;
  await tui("type", "/pair ABCD2345 --hub https://fixture.invalid");
  await tui("press", "enter");
  await tui("wait", "Awaiting approval", "--timeout", "3000");
  pending = false;
  // Match DevicePairing.status()'s real wire contract, not a made-up error object.
  lastError = "enrollment_lost: Hub enrollment disappeared";
  await tui("wait", "hub lost this enrollment", "--timeout", "4000");
  const readsAtTerminal = statusReads;
  // The controller polls once a second; three poll periods of silence cannot be a lucky gap.
  await new Promise((resolve) => setTimeout(resolve, 3200));
  assert.equal(statusReads, readsAtTerminal, "a terminal enrollment error ends local polling");
  await mkdir(scratch, { recursive: true });
  for (const cols of [40, 80, 200]) {
    await tui("resize", String(cols), "32");
    const screen = await tui("snapshot", "--trim");
    const compact = screen.replace(/\s+/g, "");
    assert.ok(compact.includes(fingerprint), `the full fingerprint survives ${cols} columns`);
    assert.ok(compact.includes("Mintafreshcodeinthehubwizardandretry."), `the full recovery action survives ${cols} columns`);
    assert.ok(!screen.includes(token));
    await writeFile(join(scratch, `${cols}.txt`), screen);
    await tui("screenshot", "-o", join(scratch, `${cols}.png`));
  }
  await tui("press", "esc");
  await tui("wait", "No active local operation to cancel", "--timeout", "3000");
  assert.equal(cancels, 6, "dismissing a terminal failure does not cancel incumbent credentials");
  console.log("PASS R07 pending re-pair polls through incumbent state and displays the terminal error");
  console.log("PASS full fingerprint and recovery action at 40/80/200 columns");
} catch (error) {
  await mkdir(scratch, { recursive: true });
  await writeFile(join(scratch, "failure.txt"), await tui("snapshot", "--trim").catch(() => ""));
  await tui("screenshot", "-o", join(scratch, "failure.png")).catch(() => {});
  console.error(`TUI pairing evidence: ${await keepEvidence()}`);
  throw error;
} finally {
  releaseStart();
  await tui("close").catch(() => {});
  server.closeAllConnections();
  await new Promise((resolve) => server.close(resolve));
  await rm(root, { recursive: true, force: true });
}
