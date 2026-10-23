// `dpi update` — self-update with the two Windows hazards handled explicitly:
//
//  1. EBUSY: the running daemon (and a running TUI) hold files inside
//     `…\npm\node_modules\my-durable\bin`, so npm cannot rename the package
//     folder while they live. The updater therefore stops the device daemon
//     first and starts it again afterwards — a background daemon must not be
//     the reason an update fails, and it must not silently stay down either.
//  2. EBADENGINE: our dependencies need Node >= 22.19.0. npm only WARNS, then
//     installs something that can fail at runtime. The updater refuses up front
//     with an actionable message instead.
//
// Everything here is dependency-injected so it can be tested without npm, a
// network, or a real daemon.
import { spawn } from "node:child_process";

/** Numeric triple + prerelease flag. A prerelease counts as older. */
export function rank(version) {
  const [core, ...pre] = String(version).trim().split("-");
  const nums = core.split(".").map((n) => Number.parseInt(n, 10) || 0);
  return { nums: [nums[0] ?? 0, nums[1] ?? 0, nums[2] ?? 0], pre: pre.length > 0 };
}

/** -1 | 0 | 1 — semver-ish ordering, enough for "is there a newer release". */
export function compareVersions(a, b) {
  const x = rank(a);
  const y = rank(b);
  for (let i = 0; i < 3; i += 1) {
    if (x.nums[i] !== y.nums[i]) return x.nums[i] < y.nums[i] ? -1 : 1;
  }
  if (x.pre !== y.pre) return x.pre ? -1 : 1;
  return 0;
}

/**
 * Does `current` satisfy `required` when required looks like ">=22.19.0" /
 * ">=22" / "22.x"? Only the forms our own package.json can carry are supported;
 * an unknown form is treated as satisfied so a future syntax never blocks an
 * update for no reason.
 */
export function satisfiesEngine(current, required) {
  const m = /^>=\s*(\d+)(?:\.(\d+))?(?:\.(\d+))?$/.exec(String(required).trim());
  if (!m) return true;
  const want = [Number(m[1]), Number(m[2] ?? 0), Number(m[3] ?? 0)];
  const have = rank(current).nums;
  for (let i = 0; i < 3; i += 1) {
    if (have[i] !== want[i]) return have[i] > want[i];
  }
  return true;
}

/** npm on Windows reports negative errno values as huge unsigned ints. */
export function normalizeExitCode(code) {
  if (typeof code !== "number") return 1;
  return code > 2 ** 31 ? code - 2 ** 32 : code;
}

/** A failed install that means "a process still holds the package folder". */
export function isBusyFailure(text) {
  return /EBUSY|EPERM|resource busy or locked/i.test(String(text));
}

/**
 * Run the update. Deps:
 *   argv          — process argv (for --check)
 *   pkg           — this package's package.json contents
 *   platform      — process.platform
 *   nodeVersion   — process.versions.node
 *   fetchLatest   — async () => version string
 *   daemon        — { running(): Promise<boolean>, stop(): Promise<void>, start(): Promise<void> }
 *   runNpm        — (version) => Promise<{ code: number; output: string }>
 *   print / printErr
 */
export async function runUpdate(deps) {
  const { pkg, print, printErr } = deps;
  const current = pkg.version;
  const checkOnly = deps.argv.includes("--check") || deps.argv.includes("-c");

  let latest;
  try {
    latest = await deps.fetchLatest();
  } catch (error) {
    printErr(`dpi update: cannot reach the npm registry (${error.message})`);
    return 1;
  }

  const order = compareVersions(current, latest);
  if (order >= 0) {
    print(`dpi ${current} is up to date (latest ${latest}).`);
    return 0;
  }
  print(`dpi ${current} -> ${latest} available.`);
  if (checkOnly) {
    print("Run `dpi update` to install it.");
    return 0;
  }

  // Refuse before touching npm: a warned-about engine is a broken install later.
  const required = pkg.engines?.node;
  if (required && !satisfiesEngine(deps.nodeVersion, required)) {
    printErr(
      `dpi update: this release needs Node ${required}, you have ${deps.nodeVersion}.`,
    );
    printErr("  Upgrade Node first (nvm install --lts / winget upgrade OpenJS.NodeJS.LTS), then retry.");
    return 1;
  }

  // Windows: the daemon (and a TUI) hold files inside the package folder, so npm
  // cannot rename it. Stop the daemon, install, then bring it back.
  const wasRunning = await deps.daemon.running();
  if (wasRunning) {
    print("stopping the device daemon so npm can replace the package…");
    await deps.daemon.stop();
  }

  let result = await deps.runNpm(latest);

  // A stale TUI can still hold the folder; retry once with the reason spelled out.
  if (result.code !== 0 && isBusyFailure(result.output)) {
    printErr("dpi update: the package folder is still in use — close any running `dpi tui` window.");
    printErr("  Retrying once…");
    result = await deps.runNpm(latest);
  }

  if (result.code !== 0) {
    printErr(`dpi update: npm failed (exit ${normalizeExitCode(result.code)}); still on ${current}.`);
    if (isBusyFailure(result.output))
      printErr("  Close every dpi window (tui + device) and run `dpi update` again.");
    if (wasRunning) await deps.daemon.start();
    return 1;
  }

  print(`dpi updated ${current} -> ${latest}.`);
  if (wasRunning) {
    print("restarting the device daemon…");
    await deps.daemon.start();
  }
  return 0;
}

// ------------------------------------------------------------------ real deps

/** Spawn npm correctly on every platform (npm is npm.cmd on Windows). */
export function spawnNpm(args) {
  return new Promise((resolve) => {
    const onWindows = process.platform === "win32";
    const child = spawn(onWindows ? "npm.cmd" : "npm", args, {
      stdio: ["ignore", "pipe", "pipe"],
      shell: onWindows,
    });
    let output = "";
    child.stdout?.on("data", (x) => {
      output += x;
      process.stdout.write(x);
    });
    child.stderr?.on("data", (x) => {
      output += x;
      process.stderr.write(x);
    });
    child.on("error", (error) => resolve({ code: 1, output: `${output}${error.message}` }));
    child.on("exit", (code) => resolve({ code: code ?? 1, output }));
  });
}

export async function fetchLatestVersion() {
  const res = await fetch("https://registry.npmjs.org/my-durable/latest", {
    headers: { accept: "application/json" },
  });
  if (!res.ok) throw new Error(`registry responded ${res.status}`);
  const version = (await res.json()).version;
  // This string reaches a command line (shell on Windows): a malformed value
  // must stop the update instead of running.
  if (!/^\d+\.\d+\.\d+(-[0-9A-Za-z.]+)?$/.test(String(version)))
    throw new Error(`registry returned a malformed version: ${version}`);
  return version;
}

/** Daemon control through the same CLI, so update needs no TS import. */
export function daemonControl(dpiPath, port) {
  const call = (args) =>
    new Promise((resolve) => {
      const child = spawn(process.execPath, [dpiPath, ...args], { stdio: "ignore" });
      child.on("error", () => resolve(1));
      child.on("exit", (code) => resolve(code ?? 1));
    });
  const running = async () => {
    try {
      const res = await fetch(`http://127.0.0.1:${port}/healthz`, { signal: AbortSignal.timeout(800) });
      return res.ok;
    } catch {
      return false;
    }
  };
  return {
    running,
    stop: () => call(["device", "stop"]),
    start: () => call(["device", "start"]),
  };
}
