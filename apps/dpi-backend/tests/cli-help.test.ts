/**
 * `dpi --help` — the launcher's help surface, end to end through the real
 * bin/dpi.mjs. Two contracts:
 *   1. top-level help lists every subcommand that is actually wired
 *   2. `--help` NEVER boots a server: `dpi hub --help` and `dpi device --help`
 *      must answer with usage and exit 0 quickly, inside a sandboxed home with
 *      spare ports — a regression that starts the daemon/hub fails fast on the
 *      timeout guard instead of binding the real ports or touching ~/.dpi.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

const DPI = fileURLToPath(new URL("../../../bin/dpi.mjs", import.meta.url));

interface Run {
  code: number | null;
  stdout: string;
  stderr: string;
  timedOut: boolean;
}

/** Run the real launcher; SIGKILL after the guard so a booting server fails the test, not the suite. */
function runDpi(args: string[], env: Record<string, string>, timeoutMs = 20_000): Promise<Run> {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [DPI, ...args], {
      env: { ...process.env, ...env },
      stdio: ["ignore", "pipe", "pipe"],
    });
    let stdout = "";
    let stderr = "";
    let timedOut = false;
    const timer = setTimeout(() => {
      timedOut = true;
      child.kill("SIGKILL");
    }, timeoutMs);
    child.stdout.on("data", (d: Buffer) => (stdout += d));
    child.stderr.on("data", (d: Buffer) => (stderr += d));
    child.on("error", (e) => {
      clearTimeout(timer);
      reject(e);
    });
    child.on("close", (code) => {
      clearTimeout(timer);
      resolve({ code, stdout, stderr, timedOut });
    });
  });
}

/** A throwaway DPI_HOME and spare ports: a regression that boots a server cannot reach ~/.dpi or 4780/4781. */
async function sandbox(): Promise<Record<string, string>> {
  const dir = await mkdtemp(join(tmpdir(), "dpi-cli-help-"));
  return { DPI_HOME: dir, DPI_PORT: "4791", DPI_HUB_PORT: "4792", DPI_HUB_URL: "" };
}

test("dpi --help lists every wired subcommand (and exits 0 on stdout)", async () => {
  const r = await runDpi(["--help"], {});
  assert.equal(r.code, 0);
  assert.equal(r.stderr, "");
  const subs = [
    "hub",
    "device",
    "pair",
    "devices",
    "schedule",
    "notify",
    "gc",
    "backup",
    "diagnostics",
    "telegram",
    "graph",
    "tui",
    "doctor",
    "update",
    "upgrade",
  ];
  for (const sub of subs) assert.match(r.stdout, new RegExp(`\\b${sub}\\b`), `${sub} is documented`);
});

test("dpi device --help prints usage, never starts the daemon", async () => {
  const env = await sandbox();
  try {
    const r = await runDpi(["device", "--help"], env);
    assert.ok(!r.timedOut, "exited on its own — a booting daemon would hit the timeout guard");
    assert.equal(r.code, 0);
    assert.match(r.stdout, /dpi device/);
    assert.match(r.stdout, /start[\s\S]*stop[\s\S]*status/);
    assert.doesNotMatch(r.stdout, /dpi-backend .* on http/, "no daemon boot banner");
  } finally {
    await rm(env.DPI_HOME!, { recursive: true, force: true });
  }
});

test("dpi hub --help prints usage, never boots the hub", async () => {
  const env = await sandbox();
  try {
    const r = await runDpi(["hub", "--help"], env);
    assert.ok(!r.timedOut, "exited on its own — a booting hub would hit the timeout guard");
    assert.equal(r.code, 0);
    assert.match(r.stdout, /dpi hub/);
    assert.match(r.stdout, /--public-host/);
    assert.match(r.stdout, /--dev/);
    assert.doesNotMatch(r.stdout, /Durable Pi hub:/, "no hub boot banner");
  } finally {
    await rm(env.DPI_HOME!, { recursive: true, force: true });
  }
});

test("dpi devices --help prints usage instead of \"devices needs --hub\"", async () => {
  const env = await sandbox();
  try {
    const r = await runDpi(["devices", "--help"], env);
    assert.equal(r.code, 0);
    assert.match(r.stdout, /dpi devices/);
    assert.match(r.stdout, /--watch/);
    assert.doesNotMatch(r.stdout, /needs --hub/);
  } finally {
    await rm(env.DPI_HOME!, { recursive: true, force: true });
  }
});

test("dpi doctor with an unknown flag exits 2 (canonical usage-error code)", async () => {
  const env = await sandbox();
  try {
    const r = await runDpi(["doctor", "--bogus"], env);
    assert.equal(r.code, 2);
    assert.match(r.stderr, /unknown flag '--bogus'/);
  } finally {
    await rm(env.DPI_HOME!, { recursive: true, force: true });
  }
});

test("dpi pair list failures land on stderr: stdout stays empty for pipes", async () => {
  const env = await sandbox();
  try {
    const r = await runDpi(["pair", "list"], env);
    assert.equal(r.code, 1);
    assert.equal(r.stdout, "", "nothing on stdout (2>/dev/null is the operator's contract)");
    assert.match(r.stderr, /list needs --hub/);
  } finally {
    await rm(env.DPI_HOME!, { recursive: true, force: true });
  }
});
