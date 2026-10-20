/**
 * P2-22 — startup limits validation: zero/negative/out-of-range/structurally
 * inconsistent CANON snapshots must fail startup, not per-request. The CANON
 * snapshot itself must pass.
 */
import test from "node:test";
import assert from "node:assert/strict";
import { validateLimits } from "../src/protocol/limits.js";

const CANON = {
  wsMaxMessageBytes: 1_048_576,
  chunkRawBytes: 65_536,
  maxChunksPerMessage: 256,
  logicalMessageMaxBytes: 16_777_216,
  connectionBufferBudgetBytes: 33_554_432,
  hubBufferBudgetBytes: 67_108_864,
  readersPerDevice: 128,
  readersPerHub: 1_024,
  restPendingPerDevice: 32,
  restPendingPerHub: 256,
  connectorBackoffFirstS: 1,
  pairVerifyFailsPerWindow: 100,
  pairVerifyFailWindowMinutes: 15,
  apiPerMinute: 60,
  apiCapacity: 120,
};

test("CANON snapshot passes validation", () => {
  assert.doesNotThrow(() => validateLimits(CANON));
});

test("zero/negative/non-integer fields fail", () => {
  for (const key of Object.keys(CANON) as Array<keyof typeof CANON>) {
    for (const bad of [0, -1, 1.5, Number.NaN]) {
      assert.throws(() => validateLimits({ ...CANON, [key]: bad }), new RegExp(`limits: ${key}`), `${key}=${bad}`);
    }
  }
});

test("out-of-range values fail", () => {
  assert.throws(() => validateLimits({ ...CANON, maxChunksPerMessage: 65_537 }), /out of sane range/);
  assert.throws(() => validateLimits({ ...CANON, wsMaxMessageBytes: 65 * 1_048_576 }), /out of sane range/);
  assert.throws(() => validateLimits({ ...CANON, hubBufferBudgetBytes: (1 << 30) + 1 }), /out of sane range/);
});

test("structural relations fail when violated", () => {
  assert.throws(() => validateLimits({ ...CANON, maxChunksPerMessage: 4 }), /chunk count cannot cover/);
  assert.throws(() => validateLimits({ ...CANON, chunkRawBytes: CANON.wsMaxMessageBytes }), /must fit one WS message/);
  assert.throws(() => validateLimits({ ...CANON, hubBufferBudgetBytes: CANON.connectionBufferBudgetBytes }), /smaller than hub budget/);
  assert.throws(() => validateLimits({ ...CANON, readersPerHub: 64 }), /reader cap exceeds hub cap/);
  assert.throws(() => validateLimits({ ...CANON, restPendingPerHub: 16 }), /pending cap exceeds hub cap/);
  assert.throws(() => validateLimits({ ...CANON, apiCapacity: 30 }), /burst capacity must be >= per-minute refill/);
});
