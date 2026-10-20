/**
 * P2-08 focused adapter tests: LanTransport request/watch semantics, six-status
 * error mapping inputs, factory explicitness (no tunnel→LAN fallback).
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { bootServer, newToken } from "../../dpi-backend/tests/helpers.js";
import { LanTransport, transportFor } from "../apps/dpi-playground-hub/src/transport.js";
import { DpiError } from "../../dpi-sdk/src/errors.js";
import { NetworkRegistry } from "../../dpi-sdk/src/node/registry.js";

const lanRow = (over: Partial<{ url: string; token: string | null }> = {}) => ({
  id: "dev-a",
  transport: "lan" as const,
  url: over.url ?? "http://10.0.0.5:7900",
  token: over.token !== undefined ? over.token : newToken(),
});
const tunnelRow = { id: "dev-t", transport: "tunnel" as const, url: null, token: null };

test("factory: LAN needs url+token; tunnel rows get NO transport (no silent fallback)", async () => {
  assert.equal(transportFor(tunnelRow as never), undefined);
  const ready = transportFor(lanRow() as never)!;
  assert.equal(ready.kind, "lan");
  assert.equal(ready.available, true);
  const noToken = transportFor(lanRow({ token: null }) as never)!;
  assert.equal(noToken.kind, "lan");
  assert.equal(noToken.available, false); // unavailable ≠ nonexistent: caller maps to unauthorized
});

test("LanTransport.request: 200 JSON, 401 passthrough, offline for dead URL, unavailable throws unauthorized", async () => {
  const home = await mkdtemp(join(tmpdir(), "dpi-tr-"));
  const token = newToken();
  const device = await bootServer({ home, startDirs: join(home, "work"), token });
  try {
    const ok = new LanTransport({ ...lanRow({ url: device.base, token }), transport: "lan" } as never);
    const probe = await ok.request({ method: "GET", path: "/v1/device" }, new AbortController().signal);
    assert.equal(probe.status, 200);
    const info = JSON.parse(probe.body as string);
    assert.equal(info.apiVersion, 1);

    // wrong token → device answers 401; transport passes the status through
    const wrong = new LanTransport({ id: "x", transport: "lan", url: device.base, token: newToken() } as never);
    const unauth = await wrong.request({ method: "GET", path: "/v1/device" }, new AbortController().signal);
    assert.equal(unauth.status, 401);

    // dead URL → DpiError offline (monitor's offline mapping input)
    const dead = new LanTransport({ ...lanRow({ url: "http://127.0.0.1:9" }), transport: "lan" } as never);
    await assert.rejects(dead.request({ method: "GET", path: "/v1/device" }, new AbortController().signal), (e: unknown) => (e as DpiError).code === "offline");

    // unavailable → unauthorized signal, not offline
    const noTok = new LanTransport({ id: "x", transport: "lan", url: device.base, token: null } as never);
    await assert.rejects(noTok.request({ method: "GET", path: "/v1/device" }, new AbortController().signal), (e: unknown) => (e as DpiError).code === "unauthorized");
  } finally {
    await device.stop();
    await rm(home, { recursive: true, force: true });
  }
});

test("LanTransport.request forwards body + idempotency-key (backend dedupes)", async () => {
  const home = await mkdtemp(join(tmpdir(), "dpi-tr2-"));
  const token = newToken();
  const device = await bootServer({ home, startDirs: join(home, "work"), token });
  try {
    const t = new LanTransport({ ...lanRow({ url: device.base, token }), transport: "lan" } as never);
    const ctl = new AbortController();
    const key = `idem-${Date.now()}`;
    const body = { name: "tr-adapter", cwd: join(home, "work"), model: { provider: "faux", modelId: "echo" } };
    const a = await t.request({ method: "POST", path: "/v1/sessions", body, idempotencyKey: key }, ctl.signal);
    const b = await t.request({ method: "POST", path: "/v1/sessions", body, idempotencyKey: key }, ctl.signal);
    assert.equal(a.status, 201);
    assert.equal(b.status, 201);
    assert.deepEqual(JSON.parse(a.body as string).id, JSON.parse(b.body as string).id); // idempotent dedupe
    ctl.abort();
  } finally {
    await device.stop();
    await rm(home, { recursive: true, force: true });
  }
});

test("LanTransport.watch yields hello then frames; unavailable throws unauthorized", async () => {
  const home = await mkdtemp(join(tmpdir(), "dpi-tr3-"));
  const token = newToken();
  const device = await bootServer({ home, startDirs: join(home, "work"), token });
  try {
    const t = new LanTransport({ ...lanRow({ url: device.base, token }), transport: "lan" } as never);
    const ctl = new AbortController();
    const iter = t.watch({ path: "/v1/events", consumerId: "test" }, ctl.signal);
    const first = await iter.next();
    assert.equal((first.value as { type: string }).type, "hello");
    ctl.abort();
    await iter.return?.(undefined as never);

    const noTok = new LanTransport({ id: "x", transport: "lan", url: device.base, token: null } as never);
    await assert.rejects(
      (async () => {
        for await (const _ of noTok.watch({ path: "/v1/events", consumerId: "test" }, new AbortController().signal)) void _;
      })(),
      (e: unknown) => (e as DpiError).code === "unauthorized",
    );
  } finally {
    await device.stop();
    await rm(home, { recursive: true, force: true });
  }
});

test("registry rows flow: tunnel row via real registry → no transport", async () => {
  const dir = await mkdtemp(join(tmpdir(), "dpi-tr4-"));
  try {
    const registry = new NetworkRegistry(join(dir, "network.sqlite"));
    registry.upsert({ id: "t-dev", url: "http://10.0.0.6:7900", token: "x".repeat(43) });
    registry.setTransportTunnel("t-dev");
    assert.equal(transportFor(registry.get("t-dev")!), undefined);
    registry.close();
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
