// A cancel sent while the wizard unmounts (navigation, tab close) must survive the page going away.
import test from "node:test";
import assert from "node:assert/strict";
import { pairingAdmin } from "../apps/dpi-playground-fe/src/client/pair.js";

function captureFetch(t: { after(fn: () => void): void }) {
  const original = globalThis.fetch;
  const inits: Array<RequestInit | undefined> = [];
  globalThis.fetch = (async (_url: string, init?: RequestInit) => {
    inits.push(init);
    return new Response(JSON.stringify({ codeId: "c1", phase: "cancelled" }), { status: 200, headers: { "content-type": "application/json" } });
  }) as never;
  t.after(() => { globalThis.fetch = original; });
  return inits;
}

test("FE-K1: cancel can be sent with keepalive", async (t) => {
  const inits = captureFetch(t);
  await pairingAdmin.cancel("c1", undefined, true);
  assert.equal(inits[0]?.keepalive, true);
  assert.equal(inits[0]?.method, "POST");
});

test("FE-K2: other admin calls, and a plain cancel, are not keepalive", async (t) => {
  const inits = captureFetch(t);
  await pairingAdmin.cancel("c1");
  await pairingAdmin.codeState("c1");
  await pairingAdmin.createCode();
  assert.deepEqual(inits.map((i) => i?.keepalive ?? false), [false, false, false]);
});
