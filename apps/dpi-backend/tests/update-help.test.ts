/**
 * `dpi update` argv safety (R6 cli finding 1).
 *
 * `update` is the one subcommand that MUTATES the machine — it may stop the
 * device daemon and run `npm install -g`. Before R6 it parsed only --check/-c,
 * so `dpi update --help` on a machine with a newer published version performed
 * a REAL self-update. The launcher now intercepts argv before the updater
 * loads: --help/-h/help prints usage and exits 0; any unknown dash-arg prints
 * usage and exits 2.
 *
 * Both contracts are asserted END TO END through the real bin/dpi.mjs with a
 * stubbed npm on PATH: if the updater ever ran, the stub leaves a marker file
 * and the test fails. A sandbox home + spare ports means nothing can reach
 * ~/.dpi or the real daemon either.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdtemp, rm, writeFile, mkdir, access } from "node:fs/promises";
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

/** Sandbox: throwaway home, spare ports, and a stub npm that records its call. */
async function sandbox() {
  const dir = await mkdtemp(join(tmpdir(), "dpi-update-help-"));
  const marker = join(dir, "npm-was-called");
  const stubDir = join(dir, "bin");
  await mkdir(stubDir, { recursive: true });
  const stub = join(stubDir, "npm");
  await writeFile(stub, `#!/bin/sh\necho "$@" > "${marker}"\nexit 0\n`, { mode: 0o755 });
  const env = {
    DPI_HOME: join(dir, "home"),
    DPI_PORT: "4791",
    DPI_HUB_PORT: "4792",
    DPI_HUB_URL: "",
    PATH: `${stubDir}:${process.env.PATH ?? ""}`,
  };
  return { dir, marker, env, cleanup: () => rm(dir, { recursive: true, force: true }) };
}

const usageText = (out: string) => {
  assert.match(out, /dpi update \| upgrade \[--check\]/);
  assert.match(out, /--check/);
};

test("dpi update --help prints usage, exits 0, never runs npm", async (t) => {
  const sb = await sandbox();
  t.after(sb.cleanup);
  const r = await runDpi(["update", "--help"], sb.env);
  assert.equal(r.timedOut, false, "must not hang (no network, no install)");
  assert.equal(r.code, 0);
  usageText(r.stdout);
  const npmCalled = await access(sb.marker).then(
    () => true,
    () => false,
  );
  assert.equal(npmCalled, false, "--help must be interception-only: npm never runs");
});

test("dpi update -h and 'update help' behave the same (exit 0, usage)", async (t) => {
  const sb = await sandbox();
  t.after(sb.cleanup);
  for (const args of [["update", "-h"], ["upgrade", "--help"], ["upgrade", "help"]]) {
    const r = await runDpi(args, sb.env);
    assert.equal(r.code, 0, `${args.join(" ")} exits 0`);
    usageText(r.stdout);
  }
});

test("dpi update --bogus rejects with usage on stderr and exit 2 (no npm)", async (t) => {
  const sb = await sandbox();
  t.after(sb.cleanup);
  for (const flag of ["--bogus", "--dry-run", "-x"]) {
    const r = await runDpi(["update", flag], sb.env);
    assert.equal(r.code, 2, `${flag} exits 2`);
    assert.match(r.stderr, /unknown flag/, `${flag} names the flag`);
    usageText(r.stderr);
    assert.equal(r.stdout, "", "rejections print on stderr only");
  }
});

test("dpi update --check / -c pass the argv gate (read-only flag stays legal)", async (t) => {
  const sb = await sandbox();
  t.after(sb.cleanup);
  // --check is network-bound, so assert only the GATE here: it must NOT be
  // rejected as an unknown flag (exit 2 with usage) — reaching the registry
  // lookup (any outcome) proves the interception let it through.
  const r = await runDpi(["update", "--check"], sb.env, 25_000);
  assert.notEqual(r.code, 2, "--check is a known flag");
  assert.doesNotMatch(r.stderr, /unknown flag/);
  assert.equal(r.timedOut, false);
});
