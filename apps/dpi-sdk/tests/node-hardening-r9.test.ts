/**
 * run-9 unit F — u9 hardening batch (sdk node):
 *  - private-file.ts: temp file created EXCLUSIVE ("wx", a planted .tmp
 *    symlink can no longer be truncated through), the parent dir goes through
 *    ensurePrivateDir (an existing too-loose dir is tightened, not reused),
 *    writePrivateFileAtomic RETURNS the restriction outcome, and the win32
 *    icacls argv gets a leading-dash guard (a dash/slash-leading path would be
 *    parsed as an icacls switch, not a filename).
 *  - config.ts: env_keys entries are validated (UPPER_SNAKE_CASE, no
 *    dpi-managed names like DPI_TOKEN — last-wins at daemon boot would let a
 *    device's .env shadow dpi's own token) and node is pinned to an integer
 *    major version (Number() alone accepts NaN / 1e21 / 22.5).
 *  - registry.ts: the fire-and-forget owner restriction is exposed as an
 *    awaitable promise instead of a dropped `void`.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile, symlink, readFile, chmod, mkdir } from "node:fs/promises";
import { statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { writePrivateFileAtomic, restrictToOwner, restrictDirToOwner } from "../src/node/private-file.js";
import { parseNetworkConfig } from "../src/node/config.js";
import { NetworkRegistry } from "../src/node/registry.js";

// ---------------------------------------------------------------- private-file

test("r9 F: temp file is exclusive — a planted .tmp symlink is not truncated through", async () => {
  const dir = await mkdtemp(join(tmpdir(), "dpi-r9-wx-"));
  try {
    const target = join(dir, "victim");
    const secret = join(dir, "admin.token");
    await writeFile(target, "VICTIM-SECRETS\n");
    await writeFile(secret, "OLD\n");
    // Plant a symlink exactly where the temp sibling would land, aimed at a
    // file we must never touch. Old code ("w") follows it and truncates.
    const planted = join(dir, ".admin.token.planted.tmp");
    await symlink(target, planted);
    await assert.rejects(
      writePrivateFileAtomic(secret, "NEW\n", { platform: "linux", tempName: () => planted }),
      (e: Error) => (e as NodeJS.ErrnoException).code === "EEXIST",
    );
    // The planted symlink/victim is untouched and the published secret is not replaced.
    assert.equal(await readFile(target, "utf8"), "VICTIM-SECRETS\n");
    assert.equal(await readFile(secret, "utf8"), "OLD\n");
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("r9 F: the parent dir goes through ensurePrivateDir — a loose existing dir is tightened to 0700", async () => {
  const dir = await mkdtemp(join(tmpdir(), "dpi-r9-dir-"));
  try {
    // A pre-existing, too-loose directory (restored from a backup, copied
    // with the wrong umask): old code reused it as-is via bare mkdirSync.
    const sub = join(dir, "creds");
    await mkdir(sub, { mode: 0o755 });
    await chmod(sub, 0o755);
    await writePrivateFileAtomic(join(sub, "admin.token"), "t\n", { platform: "linux" });
    assert.equal(statSync(sub).mode & 0o777, 0o700, "pre-existing loose dir must be tightened, not reused");
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("r9 F: writePrivateFileAtomic returns the restriction outcome (true, and false when restriction fails)", async () => {
  const dir = await mkdtemp(join(tmpdir(), "dpi-r9-out-"));
  const prevCwd = process.cwd();
  try {
    const f = join(dir, "a.token");
    assert.equal(await writePrivateFileAtomic(f, "x\n", { platform: "linux" }), true);
    // Restriction fails (win32 icacls denied) but the write itself succeeded:
    // the caller must be able to SEE that, not have it discarded. Relative
    // path + cwd so the win32 branch reaches the real whoami/icacls steps
    // (an absolute /tmp path is option-shaped for icacls and guarded off).
    process.chdir(dir);
    const execFile = async (cmd: string) => {
      if (cmd === "whoami") return '"x","S-1-5-21-9"';
      throw Error("access denied");
    };
    assert.equal(await writePrivateFileAtomic("b.token", "y\n", { platform: "win32", execFile }), false);
    assert.equal(await readFile(join(dir, "b.token"), "utf8"), "y\n");
  } finally {
    process.chdir(prevCwd);
    await rm(dir, { recursive: true, force: true });
  }
});

test("r9 F: win32 icacls argv guard — a dash/slash-leading path is refused, no icacls issued", async () => {
  const calls: { cmd: string; args: string[] }[] = [];
  const execFile = async (cmd: string, args: string[]) => {
    calls.push({ cmd, args });
    if (cmd === "whoami") return '"x","S-1-5-21-9"';
    return "";
  };
  for (const hostile of ["-GrantEveryone", "/inheritance:e", "--system=32"]) {
    calls.length = 0;
    assert.equal(await restrictToOwner(hostile, { platform: "win32", execFile }), false, hostile);
    assert.equal(await restrictDirToOwner(hostile, { platform: "win32", execFile }), false, hostile);
    assert.deepEqual(calls.filter((c) => c.cmd === "icacls"), [], `icacls must not run for ${hostile}`);
  }
  // Sanity: the guard must not reject ordinary absolute Windows paths.
  calls.length = 0;
  assert.equal(await restrictToOwner("C:\\Users\\x\\.dpi\\t", { platform: "win32", execFile }), true);
  assert.ok(calls.some((c) => c.cmd === "icacls"));
});

// ---------------------------------------------------------------- config

test("r9 F: env_keys entries are validated — managed names and non-UPPER_SNAKE rejected", () => {
  // A device env_keys entry named DPI_TOKEN writes a second DPI_TOKEN line
  // into backend.env; the daemon env parser is last-wins, so the device's
  // .env copy would silently replace dpi's own token. Refuse at parse time.
  assert.throws(
    () => parseNetworkConfig("devices:\n  a:\n    kind: local\n    env_keys: [DPI_TOKEN]"),
    /own setting/,
  );
  assert.throws(
    () => parseNetworkConfig("devices:\n  a:\n    kind: local\n    env_keys: [DPI_HOST]"),
    /own setting/,
  );
  assert.throws(
    () => parseNetworkConfig("devices:\n  a:\n    kind: local\n    env_keys: [openrouter_api_key]"),
    /UPPER_SNAKE_CASE/,
  );
  // Valid entries still parse.
  const c = parseNetworkConfig("devices:\n  a:\n    kind: local\n    env_keys: [OPENROUTER_API_KEY, LOG_LEVEL]");
  assert.deepEqual(c.devices.a.envKeys, ["OPENROUTER_API_KEY", "LOG_LEVEL"]);
});

test("r9 F: node is pinned to an integer major — NaN, fractions, 0 and 1e21 rejected", () => {
  assert.throws(() => parseNetworkConfig("devices:\n  a:\n    kind: local\n    node: nan"), /node/);
  assert.throws(() => parseNetworkConfig("devices:\n  a:\n    kind: local\n    node: 22.5"), /node/);
  assert.throws(() => parseNetworkConfig("devices:\n  a:\n    kind: local\n    node: 0"), /node/);
  assert.throws(() => parseNetworkConfig("devices:\n  a:\n    kind: local\n    node: 1e21"), /node/);
  assert.throws(() => parseNetworkConfig("devices:\n  a:\n    kind: local\n    node: -4"), /node/);
  assert.equal(parseNetworkConfig("devices:\n  a:\n    kind: local\n    node: 22").devices.a.node, 22);
  assert.equal(parseNetworkConfig("devices:\n  a:\n    kind: local").devices.a.node, 24, "default stays 24");
});

// ---------------------------------------------------------------- registry

test("r9 F: NetworkRegistry exposes the owner restriction as an awaitable promise", async () => {
  const dir = await mkdtemp(join(tmpdir(), "dpi-r9-reg-"));
  const reg = new NetworkRegistry(join(dir, "n.sqlite"));
  try {
    assert.ok(reg.restrictOwner instanceof Promise, "restriction promise must be observable, not dropped via void");
    assert.equal(await reg.restrictOwner, true);
  } finally {
    reg.close();
    await rm(dir, { recursive: true, force: true });
  }
});
