/**
 * Keep-awake (Wave 3): the inhibitor is held exactly while sessions are busy,
 * survives nothing throwing, and disables itself instead of spinning when the
 * holder process cannot start.
 */
import test from "node:test";
import assert from "node:assert/strict";
import { KeepAwake, type AwakeChild, type AwakeIo } from "../src/awake.js";

interface Recorded {
  cmd: string;
  args: readonly string[];
}

function io(platform: NodeJS.Platform, fail = false) {
  const spawned: Recorded[] = [];
  const killed: number[] = [];
  const child = (): AwakeChild => ({
    kill: () => killed.push(spawned.length),
  });
  const awake: AwakeIo = {
    platform: () => platform,
    spawn: (cmd, args) => {
      spawned.push({ cmd, args });
      return fail ? undefined : child();
    },
  };
  return { awake, spawned, killed };
}

test("linux: an idle-block inhibitor spawns on busy, dies at idle, never double-spawns", () => {
  const { awake, spawned, killed } = io("linux");
  const ka = new KeepAwake(awake);
  assert.equal(ka.mode, "inhibit");
  assert.equal(ka.held, false);

  ka.sync(0);
  assert.equal(spawned.length, 0, "idle must not hold the OS awake");

  ka.sync(2);
  assert.equal(spawned.length, 1);
  assert.equal(spawned[0].cmd, "systemd-inhibit");
  assert.deepEqual(
    spawned[0].args.slice(0, 4),
    ["--what=idle", "--mode=block", "--who", "dpi device"],
    "verified live: a user may hold idle:block; sleep:block answers Access denied",
  );
  assert.ok(spawned[0].args.join(" ").includes("2 sessions busy"), "the WHY names the busy count");
  assert.equal(ka.held, true);

  ka.sync(3);
  assert.equal(spawned.length, 1, "already held — no second process");

  ka.sync(0);
  assert.equal(killed.length, 1, "idle kills the holder");
  assert.equal(ka.held, false);
  ka.sync(0);
  assert.equal(killed.length, 1, "idempotent when already idle");
});

test("darwin: caffeinate -i -s; win32 and others are an honest no-op", () => {
  const mac = io("darwin");
  const kaMac = new KeepAwake(mac.awake);
  assert.equal(kaMac.mode, "caffeinate");
  kaMac.sync(1);
  assert.equal(mac.spawned[0].cmd, "caffeinate");
  assert.deepEqual(mac.spawned[0].args, ["-i", "-s"]);

  const win = io("win32");
  const kaWin = new KeepAwake(win.awake);
  assert.equal(kaWin.mode, "none");
  kaWin.sync(5);
  assert.equal(win.spawned.length, 0, "a platform we cannot serve must not try");
});

test("a failing spawn disables the inhibitor after two tries instead of spinning", () => {
  const { awake, spawned } = io("linux", true);
  const ka = new KeepAwake(awake);
  ka.sync(1);
  ka.sync(0);
  ka.sync(1);
  assert.equal(spawned.length, 2, "one retry, then silence");
  ka.sync(1);
  ka.sync(1);
  assert.equal(spawned.length, 2, "disabled for the rest of the process");
  assert.equal(ka.held, false);
});

test("stop() on a dead child never throws", () => {
  const { awake } = io("linux");
  const ka = new KeepAwake(awake);
  ka.sync(1);
  assert.doesNotThrow(() => ka.stop());
  assert.doesNotThrow(() => ka.stop());
});
