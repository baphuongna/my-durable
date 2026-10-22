// Device configuration: ~/.dpi/backend.env (or $DPI_ENV_FILE) plus CLI flags.
// Nothing here knows about specific machines; dpi-network.yaml on the operator's laptop
// writes this env file through `just net up <device>`.
import { appendFileSync, existsSync, mkdirSync } from "node:fs";
import { randomBytes } from "node:crypto";
import { homedir, hostname } from "node:os";
import { join, resolve } from "node:path";

export interface BackendConfig {
  name: string;
  host: string;
  port: number;
  home: string;
  envFile: string;
  dataDir: string;
  startDirs: string[];
  provider: "openrouter" | "faux";
  token: string;
  /** True exactly on the boot that minted the token; false on every later boot. */
  tokenCreated: boolean;
}

const expand = (p: string) => (p === "~" ? homedir() : p.startsWith("~/") ? join(homedir(), p.slice(2)) : p);

export function loadConfig(argv = process.argv.slice(2), env = process.env): BackendConfig {
  const flag = (key: string, fallback: string) => {
    const i = argv.indexOf(key);
    if (i < 0) return fallback;
    const value = argv[i + 1];
    if (!value || value.startsWith("--")) throw Error(`${key} needs a value`);
    return value;
  };
  const home = expand(env.DPI_HOME ?? join(homedir(), ".dpi"));
  const envFile = expand(flag("--env-file", env.DPI_ENV_FILE ?? join(home, "backend.env")));
  if (existsSync(envFile)) process.loadEnvFile(envFile);
  // First-run bootstrap: an npm-installed `dpi device` has no token and no `npm run token`.
  // Mint the device's own token (same shape scripts/token.ts writes) and persist it so every
  // later boot reuses it. A token the caller DID set stays theirs: only absent is bootstrapped.
  // (Callers passing a custom `env` snapshot rather than the live process.env will not see
  // values loaded by loadEnvFile — main.ts passes nothing, so it always does.)
  let token = env.DPI_TOKEN ?? "";
  let tokenCreated = false;
  if (token === "") {
    token = `dpi_${randomBytes(32).toString("base64url")}`;
    tokenCreated = true;
    if (!existsSync(home)) mkdirSync(home, { recursive: true, mode: 0o700 });
    appendFileSync(envFile, `DPI_TOKEN=${token}\n`, { mode: 0o600 });
  }
  const config: BackendConfig = {
    name: flag("--name", env.DPI_DEVICE_NAME ?? hostname().replace(/\.local$/, "")),
    host: flag("--host", env.DPI_HOST ?? "127.0.0.1"),
    port: Number(flag("--port", env.DPI_PORT ?? "4780")),
    home,
    envFile,
    dataDir: resolve(expand(flag("--data-dir", env.DPI_DATA_DIR ?? join(home, "backend")))),
    startDirs: flag("--start-dirs", env.DPI_START_DIRS ?? "~/dpi-work")
      .split(":")
      .filter(Boolean)
      .map((p) => resolve(expand(p))),
    provider: (env.DPI_PROVIDER ?? "openrouter") === "faux" ? "faux" : "openrouter",
    token,
    tokenCreated,
  };
  if (!Number.isInteger(config.port) || config.port < 1 || config.port > 65535)
    throw Error(`Invalid port: ${config.port}`);
  if (config.token.length < 32)
    throw Error(
      `DPI_TOKEN is set but shorter than 32 characters (looked in ${envFile}). First run with DPI_TOKEN unset creates one automatically; a set token must be at least 32 characters.`,
    );
  return config;
}
