// W-4: the recorded 1.3.0 fixture (a real nested call plus a failed and a successful compaction)
// reduces to renderable state, and attaching mid-nested converges with a full replay.
//
// Fixture provenance: apps/dpi-sdk/tests/fixtures/agent-nested-turn.json — recorded by
// apps/dpi-backend/scripts/record-nested-fixture.mts from a real Harness (MemoryStorage, fixture
// extension whose tool calls bash through executeTool(), scripted faux model).
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { AgentModel } from "../src/models.js";
import type { Frame } from "../src/api.js";

const fixture = JSON.parse(readFileSync(new URL("./fixtures/agent-nested-turn.json", import.meta.url), "utf8")) as {
  provenance: { piDurable: string; note: string };
  frames: Frame[];
};

const items = (model: AgentModel) => JSON.parse(JSON.stringify(model.state.items)) as Record<string, unknown>[];

test("W-4 fixture: provenance says it is a 1.3.0 recording, not hand-authored input", () => {
  assert.equal(fixture.provenance.piDurable, "1.3.0");
  assert.match(fixture.provenance.note, /real pi-durable Harness/);
  assert.ok(fixture.frames.length >= 10);
});

test("W-4 fixture: the recorded nested call renders once, with its returned value", () => {
  const model = new AgentModel();
  for (const frame of fixture.frames) model.apply(frame);
  const nested = items(model).filter((i) => i.kind === "tool" && (i.call as { nested?: unknown }).nested);
  assert.equal(nested.length, 1, "one nested call in the fixture");
  const call = nested[0].call as { name: string; status: string; result?: string; nested: { parentTaskId: number } };
  assert.equal(call.name, "bash");
  assert.equal(call.status, "done");
  assert.match(call.result ?? "", /nested-result/, "the nested result value is rendered");
  assert.ok(call.nested.parentTaskId > 0, "the parent task is tracked");
});

test("W-4 fixture: the failed compaction records its error, the later success clears it", () => {
  const model = new AgentModel();
  const seen: Array<{ taskId: number; error?: string } | undefined> = [];
  for (const frame of fixture.frames) {
    model.apply(frame);
    if (frame.type === "batch" && frame.events.some((e) => e.type === "compaction_end"))
      seen.push(model.state.compactionFailure ? { ...model.state.compactionFailure } : undefined);
  }
  const withError = seen.filter((s) => s?.error);
  assert.equal(withError.length, 1, "exactly one recorded compaction failed");
  assert.match(withError[0]!.error!, /scripted compaction failure/);
  assert.equal(model.state.compactionFailure, undefined, "the successful compaction cleared the failure");
});

test("W-4 fixture: attaching at the recorded mid-nested snapshot converges with a full replay", () => {
  const replay = new AgentModel();
  for (const frame of fixture.frames) replay.apply(frame);

  // The second snapshot frame was captured while the nested call was still running.
  const midIndex = fixture.frames.findIndex((frame, index) => index > 0 && frame.type === "snapshot");
  assert.ok(midIndex > 0, "the fixture carries a mid-stream snapshot");
  const snapshotFrame = fixture.frames[midIndex] as Extract<Frame, { type: "snapshot" }>;
  assert.ok(snapshotFrame.snapshot.nestedTools.some((slot) => slot.status !== "done"), "it caught a running nested call");

  const attached = new AgentModel();
  for (const frame of fixture.frames.slice(midIndex)) attached.apply(frame);
  assert.deepEqual(attached.state.items, replay.state.items, "attach mid-nested converges with full replay");
  assert.equal(attached.state.running, replay.state.running);
  assert.deepEqual(attached.state.compactionFailure, replay.state.compactionFailure);
});
