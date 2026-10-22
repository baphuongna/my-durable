// The pairing wizard must always reach a closed state: a failed or hung cancel request leaves the
// code to expire on its own and must not freeze the dialog half-closed. The one exception is a
// code the device already redeemed, which stays open so the operator can revoke it explicitly.
import test from "node:test";
import assert from "node:assert/strict";
import { closeWizard, type CancelResult } from "../apps/dpi-playground-fe/src/client/pair-close.js";
import { settledPairPath } from "../apps/dpi-playground-fe/src/client/pair-handoff.js";

const run = (cancel: () => Promise<CancelResult>, needsCancel = true) =>
  closeWizard({ needsCancel, cancel, timeoutMs: 4000 });

test("FE-P1: a confirmed cancel closes the wizard", async () => {
  assert.deepEqual(await run(async () => "cancelled"), { closed: true, confirmed: true });
});

test("FE-P2: a code that is already terminal is not cancelled at all", async () => {
  let calls = 0;
  const outcome = await run(async () => {
    calls++;
    return "cancelled";
  }, false);
  assert.deepEqual(outcome, { closed: true, confirmed: true });
  assert.equal(calls, 0);
});

test("FE-P3: a failed cancel still closes, unconfirmed", async () => {
  assert.deepEqual(await run(async () => "failed"), { closed: true, confirmed: false });
});

test("FE-P4: a rejected cancel still closes, unconfirmed", async () => {
  assert.deepEqual(
    await run(async () => {
      throw new TypeError("network down");
    }),
    { closed: true, confirmed: false },
  );
});

test("FE-P5: a cancel that never settles is abandoned after the timeout", async (t) => {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  let outcome: unknown;
  const pending = run(() => new Promise(() => {})).then((value) => (outcome = value));
  t.mock.timers.tick(3999);
  await new Promise((done) => setImmediate(done));
  assert.equal(outcome, undefined, "still waiting inside the bound");
  t.mock.timers.tick(1);
  await pending;
  assert.deepEqual(outcome, { closed: true, confirmed: false });
});

test("FE-P6: an already-issued code keeps the wizard open for an explicit revoke", async () => {
  assert.deepEqual(await run(async () => "issued"), { closed: false, confirmed: false });
});

test("FE-P7: only the /pair path is rewritten after a handoff is consumed", () => {
  assert.equal(settledPairPath(new URL("https://hub.example/pair")), "/");
  assert.equal(settledPairPath(new URL("https://hub.example/pair/")), "/");
  assert.equal(settledPairPath(new URL("https://hub.example/")), undefined);
  assert.equal(settledPairPath(new URL("https://hub.example/other")), undefined);
  assert.equal(settledPairPath(new URL("https://hub.example/pairing")), undefined);
});
