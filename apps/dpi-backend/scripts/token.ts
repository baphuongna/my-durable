// Create (or with --rotate, replace) DPI_TOKEN in $DPI_HOME/backend.env and print it.
// `just net up <device>` does this remotely; this script is for manual setups.
import { randomBytes } from "node:crypto";
import { chmodSync, lstatSync, readFileSync, statSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { ensurePrivateDir } from "../../dpi-sdk/src/node/private-dir.js";
import { replaceFileAtomic } from "../src/pairing-files.js";

const home = resolve(process.env.DPI_HOME ?? join(homedir(), ".dpi"));
const file = resolve(process.env.DPI_ENV_FILE ?? join(home, "backend.env"));
const dir = dirname(file);
const uid = process.getuid?.();

const fail = (message: string): never => {
  console.error(`token: ${message}`);
  process.exit(1);
};
const statOrUndefined = (path: string, stat: typeof statSync | typeof lstatSync) => {
  try {
    return stat(path);
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code === "ENOENT") return undefined;
    throw e;
  }
};

// Only the device's own state directory may be tightened. An env file pointed at some other existing directory
// (the working directory, $HOME, /tmp, a shared mount) is not ours to chmod: say so and stop.
const existing = statOrUndefined(dir, statSync);
if (!existing) ensurePrivateDir(dir);
else {
  if (!existing.isDirectory()) fail(`${dir} is not a directory`);
  if (uid !== undefined && existing.uid !== uid) fail(`${dir} is owned by another account (uid ${existing.uid}); choose a private directory of your own`);
  if (process.platform !== "win32" && (existing.mode & 0o077) !== 0) {
    const shared = [homedir(), tmpdir(), process.cwd(), "/"].map((p) => resolve(p));
    if (dir !== home || shared.includes(dir))
      fail(`${dir} is accessible to other accounts (mode ${(existing.mode & 0o777).toString(8)}) and is not this tool's own state directory; run chmod 700 on it, or set DPI_ENV_FILE to a file in a private directory`);
    ensurePrivateDir(dir);
  }
}

const info = statOrUndefined(file, lstatSync);
if (info && (info.isSymbolicLink() || !info.isFile())) fail(`${file} is a ${info.isSymbolicLink() ? "symlink" : "not a regular file"}; refusing to read or replace it`);
if (info && uid !== undefined && info.uid !== uid) fail(`${file} is owned by another account (uid ${info.uid})`);

const text = info ? readFileSync(file, "utf8") : "";
const current = text.match(/^DPI_TOKEN=(.+)$/m)?.[1];
if (current && !process.argv.includes("--rotate")) {
  if (process.platform !== "win32" && (statSync(file).mode & 0o777) !== 0o600) chmodSync(file, 0o600);
  console.log(current);
} else {
  const token = `dpi_${randomBytes(32).toString("base64url")}`;
  const rest = text.replace(/^DPI_TOKEN=.*\n?/m, "");
  replaceFileAtomic(file, `DPI_TOKEN=${token}\n${rest}`);
  console.log(token);
}
