import { test } from "node:test";
import assert from "node:assert/strict";
import { ensureLocalBackend, describeLocalProbe, localBackendUrl } from "../src/welcome.ts";
import type { DeviceInfo } from "../../dpi-sdk/src/api.ts";

const info: DeviceInfo = { name: "t", hostname: "h", platform: "linux", arch: "x64", version: "1", uid: "u", paired: true, online: true, models: [] } as unknown as DeviceInfo;

function fetchKit(responses: Array<{ status: number; body?: unknown }>) {
  let i = 0;
  return async () => {
    const r = responses[Math.min(i++, responses.length - 1)]!;
    return { ok: r.status === 200, status: r.status, json: async () => r.body } as unknown as Response;
  };
}

test("ensure: already up → probe ok, no start attempted", async () => {
  const started: string[] = [];
  const r = await ensureLocalBackend({
    port: 4780,
    token: "k",
    fetchImpl: fetchKit([{ status: 200, body: info }]) as typeof fetch,
    start: () => (started.push("no"), { ok: true, log: "/x" }),
    waitMs: 100,
  });
  assert.equal(r.probe.ok, true);
  assert.equal(r.started, false);
  assert.deepEqual(started, []);
});

test("ensure: unreachable → starts one, waits until it answers (token appears on first boot)", async () => {
  // 401 is never auto-started away; a connection-level failure is probe-unreachable,
  // modeled here by a 503 then healthy 200s after the start call.
  const kit = fetchKit([
    { status: 503 },
    { status: 503 },
    { status: 200, body: info },
  ]);
  let started = 0;
  const r = await ensureLocalBackend({
    port: 4780,
    token: "k",
    fetchImpl: kit as typeof fetch,
    start: () => (started++, { ok: true, log: "/x", pid: 42 }),
    waitMs: 5_000,
  });
  assert.equal(started, 1);
  assert.equal(r.started, true);
  assert.equal(r.probe.ok, true);
  assert.match(r.reason ?? "", /pid 42/);
});

test("ensure: starter refuses (no launcher) → probe stays unreachable, reason surfaces", async () => {
  const r = await ensureLocalBackend({
    port: 4780,
    token: "k",
    fetchImpl: fetchKit([{ status: 503 }]) as typeof fetch,
    start: () => ({ ok: false, log: "/x", reason: "no dpi launcher found" }),
    waitMs: 100,
  });
  assert.equal(r.probe.ok, false);
  assert.equal(r.started, false);
  assert.equal(r.reason, "no dpi launcher found");
});

test("describe: auto-start failure points at the daemon log, not just a bare command", () => {
  const text = describeLocalProbe({ ok: false, reason: "unreachable" }, 4780);
  assert.match(text, /no local dpi-backend on 127\.0\.0\.1:4780/);
  assert.match(text, /auto-start failed/);
  assert.match(text, /dpi device start/);
  assert.ok(localBackendUrl(4780) === "http://127.0.0.1:4780");
});
