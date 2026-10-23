/**
 * Private-file hygiene: atomic credential writes + owner-only access on every
 * platform. POSIX modes and, on Windows, the hardened DACL Orca installs
 * (protected from inheritance; SYSTEM, Administrators and the user only) via
 * icacls — no native addon.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm, readFile, readdir, writeFile, chmod } from "node:fs/promises";
import { statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { writePrivateFileAtomic, restrictToOwner, restrictDirToOwner } from "../src/node/private-file.js";

test("posix: restrictToOwner is chmod 0600, idempotent, never throws", async () => {
  const dir = await mkdtemp(join(tmpdir(), "dpi-priv-"));
  const f = join(dir, "token");
  await writeFile(f, "x");
  await chmod(f, 0o644);
  assert.equal(await restrictToOwner(f, { platform: "linux" }), true);
  assert.equal(statSync(f).mode & 0o777, 0o600);
  assert.equal(await restrictToOwner(f, { platform: "linux" }), true); // idempotent
  await rm(dir, { recursive: true, force: true });
});

test("posix: restrictDirToOwner is chmod 0700", async () => {
  const dir = await mkdtemp(join(tmpdir(), "dpi-privdir-"));
  await chmod(dir, 0o755);
  assert.equal(await restrictDirToOwner(dir, { platform: "linux" }), true);
  assert.equal(statSync(dir).mode & 0o777, 0o700);
  await rm(dir, { recursive: true, force: true });
});

test("win32: restrictToOwner runs icacls with orca's hardened DACL grants", async () => {
  const calls: { cmd: string; args: string[] }[] = [];
  const execFile = async (cmd: string, args: string[]) => {
    calls.push({ cmd, args });
    if (cmd === "whoami") return '"DESKTOP\\\\x","S-1-5-21-1000-2000-3000-500"\n';
    return "processed file";
  };
  const ok = await restrictToOwner("C:\\Users\\x\\.dpi\\pairing.json", {
    platform: "win32",
    execFile,
  });
  assert.equal(ok, true);
  const icacls = calls.find((c) => c.cmd === "icacls");
  assert.ok(icacls, "icacls issued");
  assert.deepEqual(icacls!.args.slice(0, 2), ["C:\\Users\\x\\.dpi\\pairing.json", "/inheritance:r"]);
  // Grant set = orca's: SYSTEM, Administrators, then the user SID (starred = SID form).
  const grants = icacls!.args.filter((a) => a.startsWith("*"));
  assert.deepEqual(grants, [
    "*S-1-5-18:F",
    "*S-1-5-32-544:F",
    "*S-1-5-21-1000-2000-3000-500:F",
  ]);
});

test("win32: restrictDirToOwner adds (OI)(CI) so children inherit", async () => {
  const calls: { cmd: string; args: string[] }[] = [];
  const execFile = async (cmd: string, args: string[]) => {
    calls.push({ cmd, args });
    if (cmd === "whoami") return '"x","S-1-5-21-9"';
    return "";
  };
  const ok = await restrictDirToOwner("C:\\Users\\x\\.dpi", { platform: "win32", execFile });
  assert.equal(ok, true);
  const icacls = calls.find((c) => c.cmd === "icacls")!;
  assert.ok(icacls.args.some((a) => a === "*S-1-5-21-9:(OI)(CI)F"));
});

test("win32: a failed icacls reports and resolves false — never throws", async () => {
  const execFile = async () => {
    throw Error("access denied");
  };
  const ok = await restrictToOwner("C:\\t", { platform: "win32", execFile });
  assert.equal(ok, false);
});

test("writePrivateFileAtomic: new content lands, mode 0600, no .tmp leftovers", async () => {
  const dir = await mkdtemp(join(tmpdir(), "dpi-atomic-"));
  const f = join(dir, "admin.token");
  await writePrivateFileAtomic(f, "adm_abc\n", { platform: "linux" });
  assert.equal(await readFile(f, "utf8"), "adm_abc\n");
  assert.equal(statSync(f).mode & 0o777, 0o600);
  const leftovers = (await readdir(dir)).filter((n) => n.includes(".tmp"));
  assert.deepEqual(leftovers, []);
  await rm(dir, { recursive: true, force: true });
});

test("writePrivateFileAtomic: a crash mid-write can never truncate (rename-only publish)", async () => {
  const dir = await mkdtemp(join(tmpdir(), "dpi-atomic2-"));
  const f = join(dir, "token");
  await writeFile(f, "OLD-TOKEN\n");
  // Replace with new content; regardless of what happens around it, a reader
  // sees either OLD or NEW — the bytes are only published by rename.
  await writePrivateFileAtomic(f, "NEW-TOKEN\n", { platform: "linux" });
  const seen = await readFile(f, "utf8");
  assert.ok(seen === "OLD-TOKEN\n" || seen === "NEW-TOKEN\n");
  assert.equal(seen, "NEW-TOKEN\n");
  await rm(dir, { recursive: true, force: true });
});
