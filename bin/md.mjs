#!/usr/bin/env node
// `md` — one command for the Durable Pi stack.
//   md hub    [--port N] [--host H] [--public-host H]   web UI + device tunnel server
//   md device                                            device-side daemon
//   md tui                                               terminal admin client
// Every subcommand runs the TypeScript entry through tsx, so no build step is needed.
import { access } from "node:fs/promises";
import { fileURLToPath } from "node:url";

/** Subcommand → TypeScript entry, relative to this file. */
const COMMANDS = {
  hub: "../apps/dpi-playground/apps/dpi-playground-hub/src/main.ts",
  device: "../apps/dpi-backend/src/main.ts",
  tui: "../apps/dpi-tui/src/main.ts",
};

const HELP = `md — Durable Pi

Usage:
  md hub [--port 4781] [--host 127.0.0.1] [--public-host <host>]
      Web UI + device tunnel server (devices dial this).
  md device
      Device-side daemon (pairs to a hub, serves one machine's agents).
  md tui
      Terminal admin client.
  md help | md --help | md -h
  md version | md --version | md -v

Environment (hub):    DPI_HOME, DPI_HUB_PORT, DPI_HUB_HOST, DPI_HUB_PUBLIC_HOST,
                      DPI_HUB_ORIGIN, DPI_HUB_REQUIRE_TLS
Environment (device): DPI_HUB_URL, DPI_HOME
`;

/**
 * tsx is a dependency of the published package, but a bare repository checkout has it only
 * inside the per-app node_modules. Try the normal resolution first, then the known local
 * copies, so `md` works in both places without a root install.
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
    "md: cannot find tsx. Install the package (npm install -g my-durable) or run npm install in an app directory.",
  );
}

const [first, ...rest] = process.argv.slice(2);

if (!first || first === "help" || first === "--help" || first === "-h") {
  process.stdout.write(HELP);
  process.exit(0);
}

if (first === "version" || first === "--version" || first === "-v") {
  const { readFileSync } = await import("node:fs");
  const pkg = JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf8"));
  process.stdout.write(`md (my-durable) ${pkg.version}\n`);
  process.exit(0);
}

if (!Object.hasOwn(COMMANDS, first)) {
  process.stderr.write(`md: unknown command '${first}'\n\n${HELP}`);
  process.exit(2);
}

// The entries parse process.argv.slice(2) themselves: hand them their own args.
process.argv = [process.argv[0], process.argv[1], ...rest];
const { register } = await loadTsx();
register();
await import(COMMANDS[first]);
