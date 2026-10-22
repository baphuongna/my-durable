/**
 * GA-14 on the device: the directories that hold the keypair, the pairing file, the env file and the
 * session data must be private to this account even when they already existed with a looser mode.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { DevicePairing } from "../src/pairing.js";
import { keypairPath, pairingPath, writeAtomic } from "../src/pairing-files.js";
import { tempStore } from "./helpers.js";

const UID = "0f1e2d3c-4b5a-6978-8796-a5b4c3d2e1f0";
const mode = (p: string) => statSync(p).mode & 0o777;
const uid = process.getuid?.();
const FOREIGN = "/tmp";
const foreignAvailable = uid !== undefined && uid !== 0 && statSync(FOREIGN).uid !== uid;

function scratch() {
  const dir = mkdtempSync(join(tmpdir(), "dpi-ga14-be-"));
  return { dir, done: () => rmSync(dir, { recursive: true, force: true }) };
}
const open = (home: string) => new DevicePairing({ uid: UID } as never, home, "dev", undefined, {});

test("GA-14: a pre-existing 0777 home is tightened to 0700 and the keypair is written inside it", () => {
  const s = scratch();
  try {
    const home = join(s.dir, "home");
    mkdirSync(home);
    chmodSync(home, 0o777);
    open(home);
    assert.equal(mode(home), 0o700);
    assert.equal(mode(keypairPath(home)), 0o600);
  } finally {
    s.done();
  }
});

test("GA-14: writeAtomic re-tightens a directory that was opened up after start-up", () => {
  const s = scratch();
  try {
    const home = join(s.dir, "home");
    mkdirSync(home);
    open(home);
    chmodSync(home, 0o775);
    writeAtomic(pairingPath(home), "{}");
    assert.equal(mode(home), 0o700);
    assert.equal(mode(pairingPath(home)), 0o600);
  } finally {
    s.done();
  }
});

test("GA-14: a home owned by another account is refused before any secret is written", (t) => {
  // A silent skip would look like a pass; announce exactly why the scenario cannot run here.
  if (!foreignAvailable) {
    t.skip(
      uid === 0
        ? "running as root — ownership refusal not observable (root owns /tmp itself)"
        : `no directory owned by another account is available (uid=${uid}, /tmp is not foreign)`,
    );
    return;
  }
  if (existsSync(keypairPath(FOREIGN))) {
    t.skip(`${keypairPath(FOREIGN)} already exists — refusing to touch foreign key material`);
    return;
  }
  try {
    assert.throws(() => open(FOREIGN), /owned by uid \d+, not by this account/);
    assert.equal(existsSync(keypairPath(FOREIGN)), false, "no key material may land in a directory we do not own");
  } finally {
    rmSync(keypairPath(FOREIGN), { force: true }); // a failing run must not leave a private key in a shared directory
  }
});

test("GA-14: the session data directory is tightened as well", async () => {
  const t = await tempStore();
  try {
    mkdirSync(t.options.dataDir, { mode: 0o777 });
    chmodSync(t.options.dataDir, 0o777);
    const store = await t.open();
    try {
      assert.equal(mode(t.options.dataDir), 0o700);
    } finally {
      await store.close();
    }
  } finally {
    await t.cleanup();
  }
});

test("GA-14: `npm run token` tightens an existing env-file directory and writes the file 0600", () => {
  const s = scratch();
  try {
    const home = join(s.dir, "home");
    mkdirSync(home);
    chmodSync(home, 0o755);
    const run = spawnSync(process.execPath, ["--import", "tsx", resolve(import.meta.dirname, "../scripts/token.ts")], {
      env: { ...process.env, DPI_HOME: home, DPI_ENV_FILE: join(home, "backend.env") },
      encoding: "utf8",
      cwd: resolve(import.meta.dirname, ".."),
    });
    assert.equal(run.status, 0, run.stderr);
    assert.equal(mode(home), 0o700);
    assert.equal(mode(join(home, "backend.env")), 0o600);
  } finally {
    s.done();
  }
});
