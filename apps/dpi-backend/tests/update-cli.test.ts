/**
 * `dpi update` — the two Windows failures the user hit:
 *   EBUSY   the running daemon holds `node_modules/my-durable/bin`, so npm
 *           cannot rename it → the updater stops the daemon first and restarts
 *           it afterwards (and must NOT leave it down when the install fails).
 *   EBADENGINE  deps need Node >= 22.19.0; npm only warns and installs a broken
 *           tree → the updater refuses up front with an actionable message.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import {
  compareVersions,
  satisfiesEngine,
  normalizeExitCode,
  isBusyFailure,
  runUpdate,
} from "../../../bin/update.mjs";

const PKG = { version: "0.0.9", engines: { node: ">=22.19.0" } };

/** A fully stubbed updater; every dep is recorded so tests can assert the order. */
import type { UpdateDeps } from "../../../bin/update.d.mts";

type Daemon = UpdateDeps["daemon"];
interface Overrides {
  daemonRunning?: boolean;
  deps?: Partial<Omit<UpdateDeps, "pkg">> & { pkg?: UpdateDeps["pkg"] };
}

function harness(overrides: Overrides = {}) {
  const events: string[] = [];
  const out: string[] = [];
  const err: string[] = [];
  const deps = {
    argv: [],
    pkg: PKG,
    nodeVersion: "22.20.0",
    fetchLatest: async () => "0.0.10",
    daemon: {
      running: async () => {
        events.push("daemon.running");
        return overrides.daemonRunning ?? true;
      },
      stop: async () => {
        events.push("daemon.stop");
      },
      start: async () => {
        events.push("daemon.start");
      },
    },
    // Records every call, then defers to the override so tests can script npm.
    runNpm: async (version: string) => {
      events.push(`npm ${version}`);
      if (overrides.deps?.runNpm) return overrides.deps.runNpm(version);
      return { code: 0, output: "added 1 package" };
    },
    print: (l: string) => out.push(l),
    printErr: (l: string) => err.push(l),
    ...overrides.deps,
  };
  // Overrides for the RECORDING deps must not bypass the recorder.
  deps.runNpm = async (version: string): Promise<{ code: number; output: string }> => {
    events.push(`npm ${version}`);
    return overrides.deps?.runNpm
      ? overrides.deps.runNpm(version)
      : { code: 0, output: "added 1 package" };
  };
  if (overrides.deps?.daemon) deps.daemon = overrides.deps.daemon as Daemon;
  return { deps, events, out, err };
}

test("compareVersions / satisfiesEngine: semver triples, prerelease older", () => {
  assert.equal(compareVersions("0.0.9", "0.0.10"), -1);
  assert.equal(compareVersions("0.0.10", "0.0.10"), 0);
  assert.equal(compareVersions("1.0.0", "0.9.9"), 1);
  assert.equal(compareVersions("1.0.0-beta.1", "1.0.0"), -1);
  assert.equal(satisfiesEngine("22.19.0", ">=22.19.0"), true);
  assert.equal(satisfiesEngine("22.14.0", ">=22.19.0"), false);
  assert.equal(satisfiesEngine("22.14.0", ">=22"), true);
  assert.equal(satisfiesEngine("23.0.0", ">=22.19.0"), true);
  assert.equal(satisfiesEngine("21.9.9", ">=22.19.0"), false);
  assert.equal(satisfiesEngine("22.14.0", "workspace:*"), true, "unknown forms never block");
});

test("normalizeExitCode: Windows reports errno as a huge unsigned int", () => {
  assert.equal(normalizeExitCode(4294963214), -4082);
  assert.equal(normalizeExitCode(1), 1);
  assert.equal(normalizeExitCode(undefined), 1);
});

test("isBusyFailure: the EBUSY/EPERM shapes npm prints on Windows", () => {
  assert.equal(isBusyFailure("npm error code EBUSY\nnpm error syscall rename"), true);
  assert.equal(isBusyFailure("EBUSY: resource busy or locked, rename '…\\bin'"), true);
  assert.equal(isBusyFailure("npm error code E404"), false);
});

test("update: a Node older than the declared engines WARNS and proceeds (pi's philosophy)", async () => {
  const h = harness({ deps: { nodeVersion: "22.14.0" } });
  const code = await runUpdate(h.deps);
  assert.equal(code, 0, "22.14 installs like pi: engines are advice, not law");
  assert.match(h.out.join("\n"), /declares Node >=22\.19\.0, you have 22\.14\.0/);
  assert.match(h.out.join("\n"), /installs and runs anyway/);
  assert.deepEqual(h.events, ["daemon.running", "daemon.stop", "npm 0.0.10", "daemon.start"]);
});

test("update: below the KNOWN floor (no node:sqlite) it still refuses before npm", async () => {
  const h = harness({ deps: { nodeVersion: "22.4.0" } });
  const code = await runUpdate(h.deps);
  assert.equal(code, 1);
  assert.deepEqual(h.events, [], "no daemon stop, no npm call");
  assert.match(h.err.join("\n"), /needs Node >= 22\.5\.0 \(node:sqlite\)/);
});

test("update: stops the daemon, installs, restarts it", async () => {
  const h = harness();
  const code = await runUpdate(h.deps);
  assert.equal(code, 0);
  assert.deepEqual(h.events, ["daemon.running", "daemon.stop", "npm 0.0.10", "daemon.start"]);
  assert.match(h.out.join("\n"), /dpi updated 0\.0\.9 -> 0\.0\.10/);
});

test("update: a stopped daemon is never started behind the operator's back", async () => {
  const h = harness({ daemonRunning: false });
  const code = await runUpdate(h.deps);
  assert.equal(code, 0);
  assert.deepEqual(h.events, ["daemon.running", "npm 0.0.10"]);
});

test("update: EBUSY retries once (a stale TUI), then succeeds", async () => {
  let attempt = 0;
  const h = harness({
    deps: {
      runNpm: async () => {
        attempt += 1;
        return attempt === 1
          ? { code: 4294963214, output: "npm error code EBUSY\nnpm error syscall rename" }
          : { code: 0, output: "ok" };
      },
    },
  });
  const code = await runUpdate(h.deps);
  assert.equal(code, 0);
  assert.equal(attempt, 2, "retried once");
  assert.match(h.err.join("\n"), /close any running `dpi tui` window/);
});

test("update: a real failure leaves the daemon running and explains the exit", async () => {
  const h = harness({
    deps: { runNpm: async () => ({ code: 4294963214, output: "npm error code EBUSY rename" }) },
  });
  const code = await runUpdate(h.deps);
  assert.equal(code, 1);
  assert.deepEqual(h.events, [
    "daemon.running",
    "daemon.stop",
    "npm 0.0.10",
    "npm 0.0.10",
    "daemon.start",
  ]);
  assert.match(h.err.join("\n"), /exit -4082/, "the unsigned errno is decoded");
  assert.match(h.err.join("\n"), /Close every dpi window/);
});

test("update: --check reports and touches nothing", async () => {
  const h = harness({ deps: { argv: ["--check"] } });
  const code = await runUpdate(h.deps);
  assert.equal(code, 0);
  assert.deepEqual(h.events, []);
  assert.match(h.out.join("\n"), /Run `dpi update` to install it/);
});

test("update: already current does nothing", async () => {
  const h = harness({ deps: { pkg: { ...PKG, version: "0.0.10" } } });
  const code = await runUpdate(h.deps);
  assert.equal(code, 0);
  assert.deepEqual(h.events, []);
  assert.match(h.out.join("\n"), /up to date/);
});

test("update: a malformed registry version never reaches npm", async () => {
  const h = harness({
    deps: {
      fetchLatest: async () => {
        const v = "1.0.0; calc";
        if (!/^\d+\.\d+\.\d+(-[0-9A-Za-z.]+)?$/.test(v)) throw new Error("malformed");
        return v;
      },
    },
  });
  const code = await runUpdate(h.deps);
  assert.equal(code, 1);
  assert.deepEqual(h.events, []);
  assert.match(h.err.join("\n"), /cannot reach the npm registry \(malformed\)/);
});
