/**
 * Gate #1 crash reporting (`src/crash.ts`): every test writes to a scratch
 * home and looks at the bytes on disk — a crash report that only exists in
 * RAM is exactly the bug this module fixes. The clock is injected so
 * filenames, rotation order and the uptime line are asserted, never slept
 * through. The uncaughtException exit path is deliberately NOT exercised
 * against the real process (it would kill the test runner): its branch is
 * pinned by code shape — the module text must contain the `process.exit(1)`
 * behind `setImmediate`.
 */
import test from "node:test";
import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import { mkdir, mkdtemp, readdir, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, dirname, join } from "node:path";
import {
  MAX_CRASH_REPORTS,
  ageLabel,
  buildCrashReport,
  crashFileName,
  installCrashHandlers,
  listCrashReports,
  redactLine,
  writeCrashReport,
  type CrashHandlerDeps,
} from "../src/crash.js";

const mode = (path: string) => stat(path).then((stats) => stats.mode & 0o777);

async function scratch() {
  const root = await mkdtemp(join(tmpdir(), "dpi-crash-"));
  return {
    root,
    home: root,
    crashes: join(root, "backend", "crashes"),
    cleanup: () => rm(root, { recursive: true, force: true }),
  };
}

/** A settable clock, so filenames and ages are asserted instead of raced. */
function clockAt(start: number) {
  const state = { now: start };
  return {
    now: () => new Date(state.now),
    advance: (ms: number) => {
      state.now += ms;
    },
  };
}

test("writeCrashReport writes the fixed template: 0600 file in a 0700 dir, every heading and fact line", async () => {
  const s = await scratch();
  try {
    const t0 = Date.UTC(2026, 9, 25, 7, 48, 12, 10);
    const deps: CrashHandlerDeps = {
      home: s.home,
      version: "0.0.46",
      now: () => new Date(t0),
      startedAt: t0 - (3 * 3_600_000 + 12 * 60_000),
      state: () => ({
        openSessions: 3,
        totalSessions: 41,
        schedules: 2,
        graphs: 1,
        runsInFlight: ["run_alpha", "run_beta"],
        notifySinks: 2,
      }),
    };
    const path = writeCrashReport(deps, "uncaughtException", new Error("boom"));
    assert.ok(path, "returns the path");
    assert.equal(basename(path), "crash-20261025-074812-010.md");
    assert.equal(await mode(path), 0o600, "file is 0600");
    assert.equal(await mode(dirname(path)), 0o700, "crashes dir is 0700");
    const content = await readFile(path, "utf8");
    for (const heading of [
      "# my-durable crash report",
      "## error",
      "## state at crash",
      "## not included",
      "## what to do",
    ]) {
      assert.ok(content.includes(heading), `heading present: ${heading}`);
    }
    assert.ok(content.includes("- when: 2026-10-25T07:48:12.010Z"));
    assert.ok(content.includes(`- version: 0.0.46 (node v${process.versions.node}, ${process.platform})`));
    assert.ok(content.includes("- reason: uncaughtException"));
    assert.ok(content.includes("- uptime: 3h 12m"), "uptime line when startedAt is provided");
    assert.ok(content.includes("- sessions: 3 open / 41 total"));
    assert.ok(content.includes("- schedules: 2, graphs: 1, runs in flight: run_alpha, run_beta"));
    assert.ok(content.includes("- notify sinks: 2"));
    assert.ok(content.includes("Error: boom"));
    assert.ok(/^    at /m.test(content), "stack frames are indented at-lines");
    assert.ok(content.includes("1. Restart the device: dpi device start"));
    assert.ok(content.includes("2. If it repeats, attach this file to an issue: https://github.com/baphuongnb/my-durable"));
    assert.ok(!content.includes("←"), "template annotations never reach the file");
  } finally {
    await s.cleanup();
  }
});

test("omitted facts read unknown and omitted uptime is no line at all", async () => {
  const s = await scratch();
  try {
    const path = writeCrashReport(
      { home: s.home, version: "0.0.46", now: () => new Date(Date.UTC(2026, 9, 25, 8, 0, 0, 0)) },
      "unhandledRejection",
      "just a string reason",
    );
    assert.ok(path);
    const content = await readFile(path, "utf8");
    assert.ok(!content.includes("- uptime:"), "no uptime line without startedAt");
    assert.ok(content.includes("- sessions: unknown open / unknown total"));
    assert.ok(content.includes("- schedules: unknown, graphs: unknown, runs in flight: unknown"));
    assert.ok(content.includes("- notify sinks: unknown"));
    assert.ok(content.includes("Error: just a string reason"), "non-Error reason still gets the Error: label");
    assert.ok(content.includes("no stack captured"), "no stack → the one fallback line");
  } finally {
    await s.cleanup();
  }
});

test("a state callback that throws loses its line, not the report", async () => {
  const s = await scratch();
  try {
    const path = writeCrashReport(
      { home: s.home, version: "0.0.46", state: () => { throw new Error("state gone"); } },
      "uncaughtException",
      new Error("boom"),
    );
    assert.ok(path, "report written even when state() throws");
    const content = await readFile(path, "utf8");
    assert.ok(content.includes("- sessions: unknown open / unknown total"));
    assert.ok(!content.includes("state gone"));
  } finally {
    await s.cleanup();
  }
});

test("redactLine masks values, keeps names", () => {
  assert.equal(redactLine("key sk-abcdef1234567890 leaked"), "key sk-<redacted> leaked");
  assert.equal(redactLine("DPI_TOKEN=dpixxxxxxxxxxxxxxxx"), "DPI_TOKEN=<redacted>");
  assert.equal(redactLine("Authorization: Bearer abcdef123456"), "Authorization: Bearer <redacted>");
  assert.equal(redactLine("api_key = 0123456789abcdef"), "api_key = <redacted>");
  assert.equal(redactLine("password=hunter2"), "password=<redacted>");
  assert.equal(
    redactLine("-----BEGIN RSA PRIVATE KEY----- MIIEowIBAAK -----END RSA PRIVATE KEY-----"),
    "<private-key-redacted>",
  );
  assert.equal(redactLine("-----BEGIN OPENSSH PRIVATE KEY----- b3BlbnNzaC1rZXk"), "<private-key-redacted>");
  assert.equal(redactLine("risk-management is a word"), "risk-management is a word");
  assert.equal(redactLine("nothing to mask here: 42"), "nothing to mask here: 42");
  assert.equal(redactLine("Bearer <redacted>"), "Bearer <redacted>", "redaction is idempotent");
});

test("the written file contains none of the raw secrets but keeps the token context", async () => {
  const s = await scratch();
  try {
    const error = new Error(
      [
        "handler failed sk-abcdef1234567890 DPI_TOKEN=dpixxxxxxxxxxxxxxxx",
        "Authorization: Bearer abcdef123456",
        "-----BEGIN RSA PRIVATE KEY----- MIIEowIBAAKCAQEAx -----END RSA PRIVATE KEY-----",
        "password=hunter2xyz",
      ].join(" | "),
    );
    const path = writeCrashReport({ home: s.home, version: "0.0.46" }, "uncaughtException", error);
    assert.ok(path);
    const content = await readFile(path, "utf8");
    for (const secret of [
      "sk-abcdef1234567890".slice(3), // the value, not the kept sk- prefix
      "dpixxxxxxxxxxxxxxxx",
      "abcdef123456",
      "MIIEowIBAAKCAQEAx",
      "hunter2xyz",
    ]) {
      assert.ok(!content.includes(secret), `raw secret absent: ${secret}`);
    }
    assert.ok(content.includes("sk-<redacted>"));
    assert.ok(content.includes("DPI_TOKEN=<redacted>"), "the name DPI_TOKEN survives");
    assert.ok(content.includes("Bearer <redacted>"));
    assert.ok(content.includes("<private-key-redacted>"));
    assert.ok(content.includes("password=<redacted>"));
  } finally {
    await s.cleanup();
  }
});

test("rotation keeps the newest 10 and deletes the oldest silently", async () => {
  const s = await scratch();
  try {
    const clock = clockAt(Date.UTC(2026, 9, 25, 9, 0, 0, 0));
    const deps: CrashHandlerDeps = { home: s.home, version: "0.0.46", now: clock.now };
    const written: string[] = [];
    for (let i = 0; i < 12; i++) {
      const path = writeCrashReport(deps, "uncaughtException", new Error(`boom ${i}`));
      assert.ok(path);
      written.push(path);
      clock.advance(7); // distinct filenames without same-millisecond collisions
    }
    const remaining = (await readdir(s.crashes)).filter((name) => name.startsWith("crash-")).sort();
    assert.equal(remaining.length, MAX_CRASH_REPORTS);
    assert.equal(remaining[0], basename(written[2]), "the oldest survivor is write #3");
    assert.equal(remaining[remaining.length - 1], basename(written[11]), "the newest is kept");
    assert.ok(!existsSync(written[0]), "write #1 deleted");
    assert.ok(!existsSync(written[1]), "write #2 deleted");
  } finally {
    await s.cleanup();
  }
});

test("listCrashReports: newest first, filename timestamps only, decoys ignored, absent dir is []", async () => {
  const s = await scratch();
  try {
    const base = Date.now();
    const clock = clockAt(base - 2 * 3_600_000); // start 2h BACK, so ages read forward from now
    const deps: CrashHandlerDeps = { home: s.home, version: "0.0.46", now: clock.now };
    writeCrashReport(deps, "unhandledRejection", new Error("oldest"));
    clock.advance(3_600_000); // +1h
    writeCrashReport(deps, "unhandledRejection", new Error("middle"));
    clock.advance(3_600_000); // +2h
    const newestPath = writeCrashReport(deps, "unhandledRejection", new Error("newest"));
    assert.ok(newestPath);
    // foreign files in the same dir must not be listed and must not be rotated away
    await writeFile(join(s.crashes, "readme.md"), "not a report\n");
    await writeFile(join(s.crashes, "crash-bogus.md"), "wrong name shape\n");

    const all = listCrashReports(s.home);
    assert.equal(all.length, 3);
    assert.equal(all[0].file, newestPath, "newest first");
    assert.ok(all[0].whenMs > all[1].whenMs && all[1].whenMs > all[2].whenMs);
    assert.equal(all[0].ageLabel, "just now");
    assert.equal(all[1].ageLabel, "1h ago");
    assert.equal(all[2].ageLabel, "2h ago");
    for (const entry of all) assert.match(entry.ageLabel, /^(just now|\d+[mhd] ago)$/);

    const two = listCrashReports(s.home, 2);
    assert.equal(two.length, 2);
    assert.equal(two[0].file, newestPath, "limit keeps the newest");

    assert.deepEqual(listCrashReports(join(s.root, "nope")), [], "absent dir → empty, never a throw");
    assert.equal(ageLabel(30_000), "just now");
    assert.equal(ageLabel(5 * 60_000), "5m ago");
    assert.equal(ageLabel(3 * 86_400_000), "3d ago");
  } finally {
    await s.cleanup();
  }
});

test("IO failure returns null instead of throwing", async () => {
  const s = await scratch();
  try {
    const imposter = join(s.root, "imposter");
    await writeFile(imposter, "a file where a dir should be\n");
    // home points at a regular file: mkdir <home>/backend/crashes fails with ENOTDIR
    assert.equal(writeCrashReport({ home: imposter, version: "0.0.46" }, "uncaughtException", new Error("x")), null);
  } finally {
    await s.cleanup();
  }
});

test("installCrashHandlers: real unhandledRejection writes a report; dispose removes the listeners", async () => {
  const s = await scratch();
  // The test runner itself listens for unhandledRejection to fail tests; park its
  // listeners for the emit so only OUR real handler sees it, then put them back.
  const saved = process.listeners("unhandledRejection");
  const before = saved.length;
  process.removeAllListeners("unhandledRejection");
  const dispose = installCrashHandlers({ home: s.home, version: "0.0.46" });
  try {
    assert.equal(process.listenerCount("unhandledRejection"), 1, "only our handler is installed");
    process.emit("unhandledRejection", new Error("unhandled boom"), Promise.resolve());
    const names = (await readdir(s.crashes)).filter((name) => name.startsWith("crash-"));
    assert.equal(names.length, 1, "one report via the real process hook");
    const content = await readFile(join(s.crashes, names[0]), "utf8");
    assert.ok(content.includes("- reason: unhandledRejection"));
    assert.ok(content.includes("Error: unhandled boom"));
    assert.ok(!content.includes("exiting"), "unhandledRejection does NOT exit — Node's default is preserved");
  } finally {
    dispose();
    assert.equal(process.listenerCount("unhandledRejection"), 0, "dispose removed the listener");
    for (const listener of saved) process.on("unhandledRejection", listener);
    await s.cleanup();
  }
  assert.equal(process.listenerCount("unhandledRejection"), before, "the runner's listeners are back");
});

test("uncaughtException branch is pinned by code shape: exit(1) behind setImmediate", async () => {
  // The real exit path would kill the test runner, so the module text itself is
  // the contract: the exit must exist, and it must be scheduled, not immediate.
  const source = await readFile(new URL("../src/crash.ts", import.meta.url), "utf8");
  const uncaught = source.slice(source.indexOf("onUncaughtException"), source.indexOf("onUnhandledRejection"));
  assert.ok(uncaught.includes("process.exit(1)"), "uncaughtException handler exits 1");
  assert.ok(uncaught.includes("setImmediate"), "the exit is scheduled so pending IO flushes");
  assert.ok(!uncaught.includes("installCrashHandlers"), "slice stayed inside the handler");

  // And the builder half of that branch is exercised directly: an uncaught
  // exception reason produces a report whose reason line says so.
  const fixed = Date.UTC(2026, 9, 25, 10, 0, 0, 0);
  const text = buildCrashReport(
    { home: "/tmp", version: "0.0.46", startedAt: fixed - 45_000 }, // same clock as `now`, 45s up
    "uncaughtException",
    new Error("shape"),
    new Date(fixed),
  );
  assert.ok(text.includes("- reason: uncaughtException"));
  assert.ok(text.includes("- uptime: <1m"));
  assert.ok(text.endsWith("## what to do\n\n1. Restart the device: dpi device start   (with your DPI_HOME / DPI_ENV_FILE)\n2. If it repeats, attach this file to an issue: https://github.com/baphuongnb/my-durable\n"));
});

test("scratch homes with no backend dir get one, recursive 0700", async () => {
  const s = await scratch();
  try {
    await mkdir(join(s.root, "nested"), { recursive: true });
    const path = writeCrashReport(
      { home: join(s.root, "nested"), version: "0.0.46", now: () => new Date(Date.UTC(2026, 9, 25, 11, 0, 0, 5)) },
      "unhandledRejection",
      new Error("deep"),
    );
    assert.ok(path);
    assert.equal(basename(path), crashFileName(new Date(Date.UTC(2026, 9, 25, 11, 0, 0, 5))));
    assert.equal(await mode(dirname(dirname(path))), 0o700, "backend/ dir also 0700");
  } finally {
    await s.cleanup();
  }
});
