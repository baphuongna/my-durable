/**
 * Device env-file editing — "Env-var management UI", Wave 2 SHOULD of
 * docs/host-project-checklist.md.
 *
 * orca edits a host's default agent environment (HostAgentEnvironmentEditor);
 * the device equivalent is the env file loadConfig reads at boot
 * (~/.dpi/backend.env or $DPI_ENV_FILE — the same file `just net up` writes
 * from dpi-network.yaml's env/env_keys). This module is the guarded read/edit
 * surface for THAT file: list with secrets masked, set/unset one key, and a
 * restart hint, because nothing takes effect until the daemon reboots.
 *
 * Three deliberate rules:
 *  - Managed/self-referential keys (DPI_TOKEN, DPI_PORT, DPI_HOME, …) are
 *    refused: each has its own dedicated setting, and editing them from a
 *    remote browser is how a device gets locked out.
 *  - Variables that came from the process (systemd `Environment=`, shell) are
 *    listed read-only: `process.loadEnvFile` does not override an existing
 *    value, so writing them to the file would look saved but never apply.
 *  - Secret-looking values are never returned over the wire — only a mask and
 *    the last 4 characters, enough to recognise, not enough to copy.
 *
 * Node builtins only; every fs access and the clock go through `io`.
 */
import { join } from "node:path";

/** Same validation as dpi-network.yaml's envMap: UPPER_SNAKE_CASE only. */
const KEY_PATTERN = /^[A-Z_][A-Z0-9_]*$/;

/** Keys with a dedicated setting (config.ts MANAGED_ENV) or that change where the daemon looks. */
export const READONLY_KEYS: readonly string[] = [
  "DPI_TOKEN",
  "DPI_DEVICE_NAME",
  "DPI_PORT",
  "DPI_HOST",
  "DPI_START_DIRS",
  "DPI_DATA_DIR",
  "DPI_HOME",
  "DPI_ENV_FILE",
];

/**
 * A key that likely holds a credential. Matching is on the NAME, never the
 * value. Bare `PRIVATE` is deliberately absent: `DPI_NOTIFY_ALLOW_PRIVATE=1`
 * is a flag, not a secret.
 */
const SECRET_KEY = /TOKEN|SECRET|PASSWORD|PASSWD|API_KEY|_KEY$|PRIVATE_KEY|CREDENTIAL/i;

export const MAX_VALUE_LENGTH = 2000;

export type EnvErrorCode = "invalid" | "not_found";

/** Typed failure so routes can answer 400 (`invalid`) or 404 (`not_found`) without string matching. */
export class EnvError extends Error {
  readonly code: EnvErrorCode;

  constructor(code: EnvErrorCode, message: string) {
    super(message);
    this.name = "EnvError";
    this.code = code;
  }
}

export interface EnvVarView {
  key: string;
  /** The value as the UI may show it: masked for secrets, verbatim otherwise. */
  masked: string;
  secret: boolean;
  /** "file" = editable here; "process" = inherited (systemd/shell), read-only. */
  source: "file" | "process";
  /** Managed keys have a dedicated setting; the editor refuses them. */
  managed: boolean;
}

export interface EnvFileView {
  envFile: string;
  exists: boolean;
  /** True once a set/unset happened since this process booted — changes apply after restart. */
  restartRequired: boolean;
  vars: EnvVarView[];
}

export interface EnvIo {
  readFile(path: string): Promise<string>;
  writeFile(path: string, data: string): Promise<void>;
  chmod(path: string, mode: number): Promise<void>;
  exists(path: string): Promise<boolean>;
  /** Read-only view of the daemon's own environment (default: process.env). */
  processEnv(): Record<string, string | undefined>;
}

export const defaultEnvIo = (): EnvIo => ({
  readFile: async (path) => (await import("node:fs/promises")).readFile(path, "utf8"),
  writeFile: async (path, data) => {
    const fs = await import("node:fs/promises");
    await fs.writeFile(path, data, { mode: 0o600 });
  },
  chmod: async (path, mode) => (await import("node:fs/promises")).chmod(path, mode),
  exists: async (path) =>
    (await import("node:fs/promises"))
      .access(path)
      .then(() => true)
      .catch(() => false),
  processEnv: () => process.env as Record<string, string | undefined>,
});

const invalid = (message: string) => new EnvError("invalid", message);

/** `•` + the tail: enough to recognise a saved key, not enough to copy it. */
export function maskValue(value: string): string {
  if (value.length <= 8) return "•".repeat(Math.max(value.length, 4));
  return `${"•".repeat(8)}${value.slice(-4)}`;
}

const isSecret = (key: string) => SECRET_KEY.test(key);

/**
 * Parse `KEY=VALUE` lines; comments/blanks/unparsed lines are preserved but not
 * vars. The empty string after a trailing newline is an artifact of `split`,
 * not a line — drop it so a rewrite does not grow blank lines.
 */
function parseLines(text: string): Array<{ key?: string; value?: string; line: string }> {
  if (text === "") return [];
  // CRLF-tolerant: a file edited in Notepad carries \r at every line end —
  // splitting on \n alone would leave it glued to every VALUE (`KEY=abc\r`
  // reads as the key "abc\r", silently corrupting API keys).
  const raw = text.split(/\r?\n/);
  if (raw.length > 1 && raw[raw.length - 1] === "") raw.pop();
  return raw.map((line) => {
    const m = /^(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)=(.*)$/.exec(line);
    return m ? { key: m[1], value: m[2], line } : { line };
  });
}

/**
 * One env file. Line-preserving: a rewrite keeps every comment and order
 * intact and only touches the line being set or removed. Writes are atomic in
 * the caller's hands (write the whole new text at once); the mode is forced to
 * 0600 because provider keys live here.
 */
export class EnvFileEditor {
  private readonly io: EnvIo;
  readonly path: string;
  private restartRequired = false;

  constructor(path: string, io: EnvIo = defaultEnvIo()) {
    this.path = path;
    this.io = io;
  }

  private async read(): Promise<string> {
    return (await this.io.exists(this.path)) ? await this.io.readFile(this.path) : "";
  }

  /** Full view: file vars first (editable), then DPI_* process-only vars (read-only). */
  async view(): Promise<EnvFileView> {
    const text = await this.read();
    const seen = new Set<string>();
    const vars: EnvVarView[] = [];
    for (const { key, value } of parseLines(text)) {
      if (!key || value === undefined || seen.has(key)) continue;
      seen.add(key);
      vars.push({
        key,
        masked: isSecret(key) ? maskValue(value) : value,
        secret: isSecret(key),
        source: "file",
        managed: (READONLY_KEYS as readonly string[]).includes(key),
      });
    }
    for (const [key, value] of Object.entries(this.io.processEnv())) {
      if (!key.startsWith("DPI_") || seen.has(key) || value === undefined || value === "") continue;
      seen.add(key);
      vars.push({
        key,
        masked: isSecret(key) ? maskValue(value) : value,
        secret: isSecret(key),
        source: "process",
        managed: (READONLY_KEYS as readonly string[]).includes(key),
      });
    }
    vars.sort((a, b) => a.key.localeCompare(b.key));
    return {
      envFile: this.path,
      exists: await this.io.exists(this.path),
      restartRequired: this.restartRequired,
      vars,
    };
  }

  /** Set one key. Refuses managed/self-referential keys and multi-line values. */
  async set(key: string, value: string): Promise<EnvVarView> {
    if (!KEY_PATTERN.test(key)) throw invalid(`${key}: keys are UPPER_SNAKE_CASE`);
    if ((READONLY_KEYS as readonly string[]).includes(key))
      throw invalid(`${key} has its own setting (port, host, start_dirs, …); change that instead`);
    if (typeof value !== "string" || !value.length) throw invalid("a value is required");
    if (/[\n\r]/.test(value)) throw invalid("the value must be a single line");
    if (value.length > MAX_VALUE_LENGTH) throw invalid(`the value is longer than ${MAX_VALUE_LENGTH} characters`);
    const lines = parseLines(await this.read());
    const next = `${key}=${value}`;
    let replaced = false;
    const out = lines.map((entry) => {
      if (entry.key !== key || replaced) return entry.line;
      replaced = true;
      return next;
    });
    if (!replaced) out.push(next);
    await this.write(out);
    return {
      key,
      masked: isSecret(key) ? maskValue(value) : value,
      secret: isSecret(key),
      source: "file",
      managed: (READONLY_KEYS as readonly string[]).includes(key),
    };
  }

  /** Remove one key's line. Only file-sourced keys can be removed. */
  async unset(key: string): Promise<{ removed: boolean }> {
    // Same guard as set(): a managed key has its own dedicated setting (token,
    // port, start dirs, …) — deleting its line from a remote browser locks the
    // operator out just as surely as overwriting it (the set-side guard alone
    // left DELETE /device/env/DPI_TOKEN a working bypass).
    if ((READONLY_KEYS as readonly string[]).includes(key))
      throw invalid(`${key} has its own setting (port, host, start_dirs, …); change that instead`);
    const lines = parseLines(await this.read());
    const kept = lines.filter((entry) => entry.key !== key);
    if (kept.length === lines.length) return { removed: false };
    await this.write(kept.map((entry) => entry.line));
    return { removed: true };
  }

  private async write(lines: string[]): Promise<void> {
    const text = lines.filter((line) => line !== "").length ? `${lines.join("\n").replace(/\n+$/, "")}\n` : "";
    await this.io.writeFile(this.path, text);
    await this.io.chmod(this.path, 0o600).catch(() => {});
    this.restartRequired = true;
  }
}

/** Default env-file path for a home dir (mirrors config.ts's fallback). */
export function envFileForHome(home: string): string {
  return join(home, "backend.env");
}
