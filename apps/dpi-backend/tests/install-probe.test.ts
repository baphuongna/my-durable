/**
 * `dpi device install` on a host WITHOUT a usable systemd --user (R6 cli
 * finding 8).
 *
 * cmdInstall used to write the systemd unit file FIRST and probe systemctl
 * after — on containers/non-systemd hosts that left a stray unit plus an empty
 * "systemctl enable failed:" message. The contract now: probe
 * `systemctl --user daemon-reload` (the same first step a real install takes)
 * BEFORE writing anything; on failure refuse with a clean explanation and NO
 * unit file.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { runDeviceCommand } from "../src/daemon.js";

const DPI = fileURLToPath(new URL("../../../bin/dpi.mjs", import.meta.url));

interface ExecCall {
  cmd: string;
  args: string[];
}

async function rig(exec: (call: ExecCall) => { ok: boolean; output: string; code: number }) {
  const dir = await mkdtemp(join(tmpdir(), "dpi-inst-probe-"));
  const ran: ExecCall[] = [];
  const wrote: { path: string; body: string }[] = [];
  const lines: string[] = [];
  const code = await runDeviceCommand("install", [], {
    env: { DPI_HOME: join(dir, "home"), DPI_HUB_URL: "https://hub.example.com", DPI_BIN: DPI },
    platform: "linux",
    uid: 1000,
    execImpl: async (cmd, args) => {
      ran.push({ cmd, args });
      return exec({ cmd, args });
    },
    writeFileImpl: async (path, body) => {
      wrote.push({ path, body });
    },
    print: (line) => lines.push(line),
  });
  return { dir, ran, wrote, lines, code, cleanup: () => rm(dir, { recursive: true, force: true }) };
}

test("no systemd (binary missing): refuses BEFORE writing, clean message, exit 1", async (t) => {
  const r = await rig(() => ({ ok: false, output: "", code: 127 }));
  t.after(r.cleanup);
  assert.equal(r.code, 1);
  assert.deepEqual(r.wrote, [], "no unit file, nothing written at all");
  assert.ok(r.lines.some((l) => /no systemd --user on this host/.test(l)), `says why: ${r.lines.join(" | ")}`);
  assert.ok(r.lines.some((l) => /dpi device start/.test(l)), "points at the fallback");
  assert.ok(
    r.ran.some((c) => c.cmd === "systemctl" && c.args.includes("--user") && c.args.includes("daemon-reload")),
    "the probe itself ran",
  );
});

test("systemd present but no user bus (container): same refusal, first stderr line surfaced", async (t) => {
  const r = await rig(() => ({
    ok: false,
    output: "System has not been booted with systemd (PID 1).\nTry --user…",
    code: 1,
  }));
  t.after(r.cleanup);
  assert.equal(r.code, 1);
  assert.deepEqual(r.wrote, [], "nothing written");
  assert.ok(r.lines.some((l) => /System has not been booted with systemd/.test(l)), "names the real cause");
});

test("probe SUCCEEDS: unit still written, enable --now issued (regression guard)", async (t) => {
  const r = await rig((call) => {
    // daemon-reload and enable succeed; loginctl too — the happy path.
    if (call.args[0] === "--user" && call.args[1] === "daemon-reload") return { ok: true, output: "", code: 0 };
    if (call.cmd === "systemctl") return { ok: true, output: "", code: 0 };
    if (call.cmd === "loginctl") return { ok: true, output: "", code: 0 };
    return { ok: true, output: "", code: 0 };
  });
  t.after(r.cleanup);
  assert.equal(r.code, 0);
  const unit = r.wrote.find((w) => w.path.endsWith("dpi-device.service"));
  assert.ok(unit, "unit written after a passing probe");
  assert.ok(r.ran.some((c) => c.args.includes("enable")), "enable --now issued");
});
