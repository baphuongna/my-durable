#!/usr/bin/env node
// `dpi` — one command for the Durable Pi stack.
//   dpi hub    [--port N] [--host H] [--public-host H]   web UI + device tunnel server
//   dpi device [start|stop|status|install|uninstall]     device-side daemon
//   dpi tui                                               terminal admin client
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
  dpi hub [--port 4781] [--host 127.0.0.1] [--public-host <host>]
      Web UI + device tunnel server (devices dial this).
  dpi device                                          run the device daemon (foreground)
  dpi device start | stop | status                    background daemon without a terminal
  dpi device install | uninstall                      OS service (systemd/launchd); Windows: no
                                                      autostart — run "dpi device start" after login
  dpi tui
      Terminal admin client.
  dpi help | dpi --help | dpi -h
  dpi version | dpi --version | dpi -v
  dpi update [--check]
      --check  compare the installed version with the registry, change nothing
      (no flag) install the latest published version globally

Environment (hub):    DPI_HOME, DPI_HUB_PORT, DPI_HUB_HOST, DPI_HUB_PUBLIC_HOST,
                      DPI_HUB_ORIGIN, DPI_HUB_REQUIRE_TLS
Environment (device): DPI_HUB_URL, DPI_HOME
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
