/**
 * `dpi gc` env-file failures (R6 cli finding 2).
 *
 * `DPI_ENV_FILE` is read inside resolveDataDir, which used to run OUTSIDE the
 * pretty-error regime: a missing or unreadable file escaped as a raw
 * ENOENT/EACCES stack trace. The contract now: a one-line `dpi gc: …` message,
 * exit code 1, and never a stack (`at ` lines).
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { gcCli, resolveDataDir, type GcIo } from "../src/gc-cli.js";

interface Rig {
  io: GcIo;
  out: string[];
  err: string[];
}

/** A GcIo over virtual files; `readError` makes every read fail like the OS would. */
function rig(files: Record<string, string> = {}, readError?: Error): Rig {
  const out: string[] = [];
  const err: string[] = [];
  const io: GcIo = {
    print: (l) => out.push(l),
    printErr: (l) => err.push(l),
    env: { DPI_ENV_FILE: "/srv/device/backend.env" },
    readFile: (path) => {
      if (readError) throw readError;
      if (!(path in files))
        throw Object.assign(new Error(`ENOENT: no such file or directory, open '${path}'`), { code: "ENOENT" });
      return files[path]!;
    },
    homedir: () => "/home/tester",
    now: () => 1_700_000_000_000,
  };
  return { io, out, err };
}

test("gc with a MISSING env file: one clean line, exit 1, no stack", async () => {
  const { io, err } = rig();
  const code = await gcCli({ argv: ["--closed-before", "30d"] }, io);
  assert.equal(code, 1);
  assert.equal(err.length, 1, "exactly one error line");
  assert.match(
    err[0]!,
    /dpi gc: cannot read DPI_ENV_FILE '\/srv\/device\/backend\.env' — the file does not exist/,
  );
  assert.equal(err.some((l) => l.trimStart().startsWith("at ")), false, "no stack frames");
});

test("gc with an UNREADABLE env file (EACCES): names the permission problem", async () => {
  const { io, err } = rig(
    {},
    Object.assign(new Error("EACCES: permission denied, open '/srv/device/backend.env'"), { code: "EACCES" }),
  );
  const code = await gcCli({ argv: ["--closed-before", "30d"] }, io);
  assert.equal(code, 1);
  assert.match(err[0]!, /the file is not readable/);
  assert.equal(err.some((l) => l.trimStart().startsWith("at ")), false, "no stack frames");
});

test("resolveDataDir still resolves from a healthy env file (regression guard)", () => {
  const { io } = rig({ "/srv/device/backend.env": "DPI_HOME=/data/device\n" });
  assert.equal(resolveDataDir([], io), "/data/device/backend");
});

test("a readable env file still feeds gc (plan path runs, exit 0 on empty archive)", async () => {
  const { io, out, err } = rig({ "/srv/device/backend.env": "DPI_HOME=/tmp/r6-gc-home\n" });
  const code = await gcCli({ argv: ["--closed-before", "30d"] }, io);
  assert.equal(code, 0);
  assert.match(out[0]!, /archive \/tmp\/r6-gc-home\/backend\/archive/);
  assert.equal(err.length, 0);
});
