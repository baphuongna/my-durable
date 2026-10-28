/**
 * R13 (R9-6.3 FE): the replay verdict must be VISIBLE in the FE — the device
 * marks the envelope, the hub surfaces Idempotent-Replay, the SDK hook fires,
 * and the FE client factory turns it into a toast naming the escape hatch.
 * Source-assert level (the full chain is proven by the wire tests in the
 * backend/hub/sdk packages; this pins the FE wiring).
 */
import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const feRoot = join(dirname(fileURLToPath(import.meta.url)), "../apps/dpi-playground-fe/src");

test("deviceClient wires onIdempotentReplay to a rate-limited toast", async () => {
  const src = await readFile(join(feRoot, "client/hub.ts"), "utf8");
  assert.match(src, /onIdempotentReplay/, "the SDK hook is wired");
  assert.match(src, /Replayed an earlier identical request/, "the toast names what happened");
  assert.match(src, /idempotency key/, "the toast names the escape hatch");
  assert.match(src, /30_000/, "burst replays are rate-limited to one toast per 30s");
});
