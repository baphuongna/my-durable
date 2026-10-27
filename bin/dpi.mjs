#!/usr/bin/env node
// `dpi` — one command for the Durable Pi stack.
//   dpi hub    [--port N] [--host H] [--public-host H]   web UI + device tunnel server
//   dpi device [start|stop|status|install|uninstall]     device-side daemon
//   dpi tui                                               terminal admin client
//   dpi schedule [list|add|enable|disable|run|remove]     scheduled sessions
//   dpi notify   [list|add|enable|disable|remove|test]    outbound notifications
//   dpi gc --closed-before 30d [--dry-run|--yes]           retention (dry-run default)
//   dpi backup  [create|list|restore]                       whole-home snapshots
//   dpi diagnostics [--out F]                                redacted bug-report bundle
//   telegram status|bind|unbind|sessions                     Telegram chat bridge
//   graph list|show|add|run|remove|archive|unarchive         task-graph DAG
//   dpi doctor [--json] [--quiet]                         one-shot device health check
// Every subcommand runs the TypeScript entry through tsx, so no build step is needed.
import { access } from "node:fs/promises";
import { fileURLToPath } from "node:url";

/** Subcommand → TypeScript entry, relative to this file. */
const COMMANDS = {
  hub: "../apps/dpi-playground/apps/dpi-playground-hub/src/main.ts",
  device: "../apps/dpi-backend/src/main.ts",
  tui: "../apps/dpi-tui/src/main.ts",
};

const HELP = `dpi — Durable Pi (bare "dpi" opens the TUI)

Usage:
  dpi hub [--port 4781] [--host 127.0.0.1] [--public-host <host>] [--dev]
      Web UI + device tunnel server (devices dial this). --dev serves the web
      client straight from Vite instead of the built shell (local development).
  dpi device                                          run the device daemon (foreground)
  dpi device start | stop | status                    background daemon without a terminal
  dpi device install | uninstall                      OS service (systemd/launchd); Windows: no
                                                      autostart — run "dpi device start" after login
  dpi pair <code|link> [--hub <origin>]               pair THIS machine from the CLI (no browser)
  dpi pair --hub <origin>                             this machine asks the hub itself
  dpi pair offer|list|approve|revoke                  operator side, from the CLI (dpi pair --help)
  dpi devices [--watch] [--hub <origin>]              paired machines + live status (CLI, no web)
  dpi schedule [list|add|enable|disable|run|remove]   scheduled sessions (dpi schedule --help)
  dpi notify [list|add|enable|disable|remove|test]    outbound notifications (dpi notify --help)
  dpi gc --closed-before 30d [--dry-run|--yes]        retention for archived sessions (dry-run default)
  dpi backup [create|list|restore]                    whole-home snapshots (restore is plan-first)
  dpi diagnostics [--out F]                           redacted bug-report bundle
  dpi telegram status|bind|unbind|sessions            Telegram chat bridge
  dpi graph list|show|add|run|remove|archive|unarchive  task-graph DAG (dpi graph --help)
  dpi tui
      Terminal admin client.
  dpi doctor [--json] [--quiet]
      One-shot health check: node >= 22.19.0, healthz, start-dir writability,
      the default-model probe and the hub. Exit 1 when a check fails.
  dpi help | dpi --help | dpi -h
  dpi version | dpi --version | dpi -v
  dpi update | upgrade [--check]
      --check  compare the installed version with the registry, change nothing
      (no flag) install the latest published version globally

Environment (hub):    DPI_HOME, DPI_HUB_PORT, DPI_HUB_HOST, DPI_HUB_PUBLIC_HOST,
                      DPI_HUB_ORIGIN, DPI_HUB_REQUIRE_TLS
Environment (device): DPI_HUB_URL, DPI_HOME
`;

const UPDATE_USAGE = `dpi update | upgrade [--check]

  dpi update --check   compare the installed version with the registry, change nothing
  dpi update           install the latest published version globally
                       (stops and restarts the device daemon so npm can replace files)
`;

/**
 * tsx is a dependency of the published package, but a bare repository checkout has it only
 * inside the per-app node_modules. Try the normal resolution first, then the known local
 * copies, so `dpi` works in both places without a root install.
 */
async function loadTsx() {
  try {
    return await import("tsx/esm/api");
  } catch (error) {
    if (error?.code !== "ERR_MODULE_NOT_FOUND") throw error;
  }
  const candidates = [
    "../apps/dpi-playground/node_modules/tsx/dist/esm/api/index.mjs",
    "../apps/dpi-backend/node_modules/tsx/dist/esm/api/index.mjs",
    "../apps/dpi-sdk/node_modules/tsx/dist/esm/api/index.mjs",
    "../apps/dpi-tui/node_modules/tsx/dist/esm/api/index.mjs",
  ];
  for (const relative of candidates) {
    const url = new URL(relative, import.meta.url);
    try {
      await access(fileURLToPath(url));
      return await import(url.href);
    } catch {
      // try the next one
    }
  }
  throw new Error(
    "dpi: cannot find tsx. Install the package (npm install -g my-durable) or run npm install in an app directory.",
  );
}

const [first, ...rest] = process.argv.slice(2);

// R6 cli finding 9: every invocation that loads the store prints node:sqlite's
// ExperimentalWarning — pure noise for a CLI, and a flag a running process
// cannot take retroactively. When this launcher starts without the
// suppression flag it relaunches itself ONCE with it. --disable-warning takes
// the WARNING NAME ("experimental" does not match); any Node that has the
// flag at all accepts unknown values — worst case nothing is suppressed — so
// the version gate below is the only compatibility guard needed.
const EXPERIMENTAL_WARNING_FLAG = "--disable-warning=ExperimentalWarning";

/** Relaunch with the warning suppressed. Returns true when THIS process must
 *  become a thin wrapper (its only remaining job is to wait for the child). */
async function quietExperimentalWarning() {
  if (process.execArgv.includes(EXPERIMENTAL_WARNING_FLAG)) return false;
  if (process.env.DPI_WARNINGS_QUIETED === "1") return false;
  const [major, minor] = process.versions.node.split(".").map(Number);
  if (!((major === 22 && minor >= 13) || major > 22)) return false;
  const { spawn } = await import("node:child_process");
  const child = spawn(
    process.execPath,
    [...process.execArgv, EXPERIMENTAL_WARNING_FLAG, fileURLToPath(import.meta.url), ...process.argv.slice(2)],
    {
      stdio: "inherit",
      env: {
        ...process.env,
        DPI_WARNINGS_QUIETED: "1",
        DPI_WRAPPER_PID: String(process.pid),
      },
    },
  );
  // Ctrl-C / service stop must reach the real process, not die with the wrapper.
  for (const signal of ["SIGINT", "SIGTERM", "SIGHUP"])
    process.on(signal, () => child.kill(signal));
  child.on("error", (error) => {
    process.stderr.write(`dpi: relaunch failed: ${error.message}\n`);
    process.exit(1);
  });
  child.on("close", (code, signal) => {
    if (signal) process.kill(process.pid, signal);
    else process.exit(code ?? 0);
  });
  return true;
}

if (await quietExperimentalWarning()) await new Promise(() => {});

// The relaunched child must not outlive a SIGKILLed wrapper: forwarded signals
// cover SIGINT/SIGTERM/SIGHUP, but SIGKILL cannot be caught. A cheap liveness
// poll on the wrapper closes that hole — if the wrapper is gone, this process
// is an orphan and terminates itself. unref'd: it never keeps the CLI alive.
if (process.env.DPI_WRAPPER_PID) {
  const wrapperPid = Number(process.env.DPI_WRAPPER_PID);
  if (Number.isInteger(wrapperPid) && wrapperPid > 0 && wrapperPid !== process.pid) {
    const timer = setInterval(() => {
      try {
        process.kill(wrapperPid, 0);
      } catch {
        process.kill(process.pid, "SIGTERM");
      }
    }, 2_000);
    timer.unref?.();
  }
}

// Bare `dpi` opens the TUI — the app, not a help screen (convention of the
// reference clients: the product IS the terminal UI; subcommands are the extras).
const command = !first || first === "tui" ? "tui" : first;
const commandRest = !first ? [] : rest;

if (command === "help" || command === "--help" || command === "-h") {
  process.stdout.write(HELP);
  process.exit(0);
}

if (command === "version" || command === "--version" || command === "-v") {
  const { readFileSync } = await import("node:fs");
  const pkg = JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf8"));
  process.stdout.write(`dpi (my-durable) ${pkg.version}\n`);
  process.exit(0);
}

if (command === "update" || command === "upgrade") {
  // R6 cli finding 1: `update` MUTATES the machine (it may stop the daemon and
  // run `npm install -g`), so its argv is checked HERE — before the updater
  // loads — unlike every other subcommand: --help must never self-update, and
  // an unknown dash-arg is a typo the operator must see, not a real update.
  if (commandRest.includes("--help") || commandRest.includes("-h") || commandRest.includes("help")) {
    process.stdout.write(UPDATE_USAGE);
    process.exit(0);
  }
  const unknownFlag = commandRest.find((a) => a.startsWith("-") && a !== "--check" && a !== "-c");
  if (unknownFlag) {
    process.stderr.write(`dpi update: unknown flag '${unknownFlag}'\n\n${UPDATE_USAGE}`);
    process.exit(2);
  }
  const { readFileSync } = await import("node:fs");
  const { runUpdate, fetchLatestVersion, spawnNpm, daemonControl } = await import("./update.mjs");
  const pkg = JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf8"));
  const port = Number(process.env.DPI_PORT ?? "4780");
  const code = await runUpdate({
    argv: commandRest,
    pkg,
    nodeVersion: process.versions.node,
    fetchLatest: fetchLatestVersion,
    // Stop/start through this same launcher: the daemon must not block npm's
    // rename on Windows, and it must come back afterwards.
    daemon: daemonControl(fileURLToPath(import.meta.url), port),
    runNpm: (version) => spawnNpm(["install", "-g", `my-durable@${version}`]),
    print: (line) => process.stdout.write(`${line}\n`),
    printErr: (line) => process.stderr.write(`${line}\n`),
  });
  process.exit(code);
} else if (command === "devices") {
  // The CLI view of the network: same data the web sidebar and the TUI show.
  process.argv = [process.argv[0], process.argv[1], ...commandRest];
  const { register } = await loadTsx();
  register();
  if (commandRest.includes("--help") || commandRest.includes("-h")) {
    const { DEVICES_USAGE } = await import("../apps/dpi-backend/src/pair-cli.ts");
    process.stdout.write(DEVICES_USAGE);
    process.exit(0);
  }
  const { listDevices } = await import("../apps/dpi-backend/src/pair-cli.ts");
  const hubIdx = commandRest.indexOf("--hub");
  process.exit(
    await listDevices({}, hubIdx >= 0 ? commandRest[hubIdx + 1] : undefined, commandRest.includes("--watch")),
  );
} else if (command === "pair") {
  // Pairing is its own surface: it runs headless (no TUI, no browser) and both
  // directions live in one command — this machine, and the operator's side.
  if (commandRest.includes("--help") || commandRest.includes("-h")) {
    process.argv = [process.argv[0], process.argv[1], ...commandRest];
    const { register } = await loadTsx();
    register();
    const { PAIR_USAGE } = await import("../apps/dpi-backend/src/pair-cli.ts");
    process.stdout.write(PAIR_USAGE);
    process.exit(0);
  }
  process.argv = [process.argv[0], process.argv[1], ...commandRest];
  const { register } = await loadTsx();
  register();
  const { runPairCommand } = await import("../apps/dpi-backend/src/pair-cli.ts");
  process.exit(await runPairCommand(commandRest));
} else if (command === "schedule") {
  // Scheduled sessions: the CLI only edits the device's records over its own API,
  // so a running daemon picks changes up without a restart.
  const { register } = await loadTsx();
  register();
  const { scheduleCli } = await import("../apps/dpi-backend/src/schedule-cli.ts");
  process.exit(await scheduleCli(commandRest));
} else if (command === "notify") {
  // Outbound fan-out: the CLI edits the device's sinks over its own API.
  const { register } = await loadTsx();
  register();
  const { notifyCli } = await import("../apps/dpi-backend/src/notify-cli.ts");
  process.exit(await notifyCli(commandRest));
} else if (command === "gc") {
  // Retention: dry-run unless --yes. Never runs on its own (policy gate #3).
  const { register } = await loadTsx();
  register();
  const { gcCli } = await import("../apps/dpi-backend/src/gc-cli.ts");
  process.exit(await gcCli({ argv: commandRest }));
} else if (command === "telegram") {
  // Chat bridge: bind a Telegram chat to a device session (token in the env
  // file as DPI_TELEGRAM_TOKEN). The daemon owns the polling loop.
  const { register } = await loadTsx();
  register();
  const { telegramCli } = await import("../apps/dpi-backend/src/telegram-cli.ts");
  process.exit(await telegramCli({ argv: commandRest }));
} else if (command === "diagnostics") {
  // One redacted zip for a bug report: versions, doctor, device/vitals/env,
  // sessions/registries, log tail — every section fails independently.
  const { register } = await loadTsx();
  register();
  const { diagnosticsCli } = await import("../apps/dpi-backend/src/diagnostics-cli.ts");
  process.exit(await diagnosticsCli({ argv: commandRest }));
} else if (command === "graph") {
  // Task-graphs: a DAG of prompt-tasks, each run as a fresh session.
  const { register } = await loadTsx();
  register();
  const { graphCli } = await import("../apps/dpi-backend/src/graph-cli.ts");
  process.exit(await graphCli({ argv: commandRest }));
} else if (command === "backup") {
  // Whole-home snapshots: create/list, restore is plan-first and refuses while
  // the daemon runs. Nothing is ever deleted — the old home becomes a .bak.
  const { register } = await loadTsx();
  register();
  const { backupCli } = await import("../apps/dpi-backend/src/backup-cli.ts");
  process.exit(await backupCli({ argv: commandRest }));
} else if (command === "doctor") {
  // One-shot health check. The logic lives in the backend as TS (testable with
  // injected fakes); this is only the tsx loader + the exit code.
  const { register } = await loadTsx();
  register();
  const { doctorCli } = await import("../apps/dpi-backend/src/doctor.ts");
  process.exit(await doctorCli(commandRest));
} else if (!Object.hasOwn(COMMANDS, command)) {
  process.stderr.write(`dpi: unknown command '${command}'\n\n${HELP}`);
  process.exit(2);
} else {
  // The entries parse process.argv.slice(2) themselves: hand them their own args.
  process.argv = [process.argv[0], process.argv[1], ...commandRest];
  // The device daemon respawns and installs services through this launcher:
  // hand it the absolute path before the module loads.
  process.env.DPI_BIN = fileURLToPath(import.meta.url);
  const { register } = await loadTsx();
  register();
  await import(COMMANDS[command]);
}
