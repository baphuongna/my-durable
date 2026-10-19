// P1-08: nested calls and compaction failures (pi-durable 1.3.0 wire) reduce to renderable state.
// A nested call has no assistant entry; its result arrives on `tool_execution_end.result` (or, on attach,
// in `snapshot.nestedTools`). These tests pin: rendering exactly once, no phantom rows, snapshot/replay
// convergence including attaching mid-nested-execution, and compaction-failure lifecycle.
import { test } from "node:test";
import assert from "node:assert/strict";
import { AgentModel } from "../src/models.js";
import type { Frame, WireAgentEvent, WireEntry, WireSnapshotEvent } from "../src/api.js";

const usage = {
  input: 1,
  output: 1,
  cacheRead: 0,
  cacheWrite: 0,
  totalTokens: 2,
  cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
};

const assistantToolCall = (id: number, callId: string, name = "delegate"): WireEntry => ({
  id,
  conversationId: 1,
  kind: "pi.assistant",
  model: [
    {
      role: "assistant",
      content: [{ type: "toolCall", id: callId, name, arguments: { task: "x" } }],
      provider: "faux",
      model: "echo",
      usage,
      stopReason: "toolUse",
    },
  ],
});

const toolResultEntry = (id: number, callId: string, text: string, isError = false): WireEntry => ({
  id,
  conversationId: 1,
  kind: "pi.tool-result",
  model: [
    {
      role: "toolResult",
      toolCallId: callId,
      toolName: "delegate",
      content: [{ type: "text", text }],
      isError,
    },
  ],
});

const snapshotOf = (extra: Partial<WireSnapshotEvent> = {}): WireSnapshotEvent => ({
  type: "snapshot",
  entries: [],
  tools: [],
  nestedTools: [],
  compactions: [],
  inbox: [],
  agent: {},
  usage: { models: {}, tools: {} },
  ...extra,
});

const snapshotFrame = (snapshot: WireSnapshotEvent): Frame => ({ type: "snapshot", snapshot, inbox: [] });
const batchFrame = (...events: WireAgentEvent[]): Frame => ({ type: "batch", events });
const items = (model: AgentModel) => JSON.parse(JSON.stringify(model.state.items)) as Record<string, unknown>[];
const toolItems = (model: AgentModel) => items(model).filter((i) => i.kind === "tool");

test("P1-08: a snapshot with nested calls (running and done) initializes the model", () => {
  const model = new AgentModel();
  model.apply(
    snapshotFrame(
      snapshotOf({
        tools: [{ callId: "call-1", name: "delegate", status: "running", taskId: 10 }],
        nestedTools: [
          {
            callId: "call-1/0",
            name: "bash",
            status: "running",
            output: "half",
            parentCallId: "call-1",
            parentTaskId: 10,
            taskId: 11,
            arguments: { command: "ls" },
          },
          {
            callId: "call-1/1",
            name: "read",
            status: "done",
            parentCallId: "call-1",
            parentTaskId: 10,
            taskId: 12,
            arguments: { path: "a.ts" },
            summary: { isError: false, durationMs: 1500 },
          },
        ],
      }),
    ),
  );
  const nested = toolItems(model).filter((i) => (i.call as { nested?: unknown }).nested);
  assert.equal(nested.length, 2, "both nested calls render");
  const running = nested.find((i) => i.id === "call-1/0")!;
  assert.equal((running.call as { status: string }).status, "running");
  assert.equal((running.call as { output?: string }).output, "half");
  assert.deepEqual((running.call as { nested: unknown }).nested, { parentCallId: "call-1", parentTaskId: 10, taskId: 11 });
  assert.deepEqual((running.call as { args: unknown }).args, { command: "ls" });
  // A done nested slot from a snapshot carries a summary, not a fabricated result.
  const done = nested.find((i) => i.id === "call-1/1")!;
  assert.equal((done.call as { status: string }).status, "done");
  assert.equal((done.call as { result?: string }).result, undefined, "no fabricated result text");
  assert.equal((done.call as { summary?: string }).summary, "1.5s");
});

test("P1-08: a nested end.result renders once; a model-issued end with an entry never duplicates", () => {
  const model = new AgentModel();
  model.apply(snapshotFrame(snapshotOf()));
  model.apply(
    batchFrame(
      { type: "tool_execution_start", toolCallId: "call-1", toolName: "delegate", args: {}, taskId: 10 },
      { type: "tool_execution_start", toolCallId: "call-1/0", toolName: "bash", args: { command: "ls" }, taskId: 11, parentToolCallId: "call-1", parentTaskId: 10 },
      { type: "tool_execution_update", toolCallId: "call-1/0", toolName: "bash", output: { append: "partial" }, taskId: 11, parentToolCallId: "call-1", parentTaskId: 10 },
      {
        type: "tool_execution_end",
        toolCallId: "call-1/0",
        toolName: "bash",
        result: { taskId: 11, isError: false, diagnostics: [], structuredOutput: { output: "ok", exitCode: 0 }, durationMs: 250 },
        taskId: 11,
        parentToolCallId: "call-1",
        parentTaskId: 10,
      },
    ),
  );
  const nested = toolItems(model).filter((i) => i.id === "call-1/0");
  assert.equal(nested.length, 1, "exactly one row for the nested call");
  const call = nested[0].call as { status: string; result?: string; summary?: string; nested: unknown };
  assert.equal(call.status, "done");
  assert.equal(call.result, '{"output":"ok","exitCode":0}');
  assert.equal(call.summary, "0.3s");

  // A model-issued end carries its result entry; the live slot is dropped, rendered from the entry alone.
  model.apply(
    batchFrame(
      { type: "entry_appended", entry: assistantToolCall(4, "call-2") },
      { type: "tool_execution_start", toolCallId: "call-2", toolName: "delegate", args: {}, taskId: 20 },
      { type: "tool_execution_end", toolCallId: "call-2", toolName: "delegate", entry: toolResultEntry(5, "call-2", "model result"), taskId: 20 },
    ),
  );
  const assistant = items(model).find(
    (i) => i.kind === "assistant" && (i.blocks as { type: string; call?: { callId: string } }[]).some((b) => b.type === "tool" && b.call?.callId === "call-2"),
  )!;
  const block = (assistant.blocks as { type: string; call: { callId: string; result?: string } }[]).find((b) => b.type === "tool" && b.call.callId === "call-2")!;
  assert.equal(block.call.result, "model result", "the assistant block renders the result entry");
  // Exactly once: no separate live row, and no orphan tool-result row.
  assert.equal(items(model).filter((i) => i.kind === "tool" && i.id === "call-2").length, 0, "no separate live row");
  assert.equal(items(model).filter((i) => i.kind === "tool-result").length, 0, "no orphan duplicate");
});

test("P1-08: an end with neither entry nor result leaves no phantom row (faulted/orphaned/interrupted)", () => {
  const model = new AgentModel();
  model.apply(snapshotFrame(snapshotOf()));
  model.apply(
    batchFrame(
      { type: "tool_execution_start", toolCallId: "call-9", toolName: "bash", args: {}, taskId: 30 },
      { type: "tool_execution_end", toolCallId: "call-9", toolName: "bash", taskId: 30 },
    ),
  );
  assert.equal(toolItems(model).filter((i) => i.id === "call-9").length, 0, "no invented result row");
});

test("P1-08: compaction failure is set from a snapshot, set by a failing end, and cleared by a success", () => {
  const model = new AgentModel();
  model.apply(
    snapshotFrame(
      snapshotOf({ compactionFailure: { taskId: 7, reason: "threshold", error: "model_error: too long" } }),
    ),
  );
  assert.deepEqual(model.state.compactionFailure, { taskId: 7, reason: "threshold", error: "model_error: too long" });

  // A compaction that produces a summary clears the recorded failure.
  model.apply(batchFrame({ type: "compaction_start", taskId: 8, reason: "manual", blocking: false }, { type: "compaction_end", taskId: 8, reason: "manual" }));
  assert.equal(model.state.compactionFailure, undefined, "a successful compaction clears the failure");
  assert.deepEqual(model.state.compactions, [], "the task leaves the live list");

  // A failing compaction records its error.
  model.apply(batchFrame({ type: "compaction_end", taskId: 9, reason: "threshold", error: "Compaction failed: boom" }));
  assert.deepEqual(model.state.compactionFailure, { taskId: 9, reason: "threshold", error: "Compaction failed: boom" });
});

test("P1-08: direct snapshot and full replay converge, including attaching mid-nested-execution", () => {
  const events: WireAgentEvent[] = [
    { type: "run_start", inputs: [1] },
    { type: "tool_execution_start", toolCallId: "call-1", toolName: "delegate", args: {}, taskId: 10 },
    { type: "entry_appended", entry: assistantToolCall(1, "call-1") },
    { type: "tool_execution_start", toolCallId: "call-1/0", toolName: "bash", args: { command: "ls" }, taskId: 11, parentToolCallId: "call-1", parentTaskId: 10 },
    { type: "tool_execution_update", toolCallId: "call-1/0", toolName: "bash", output: { append: "half" }, taskId: 11, parentToolCallId: "call-1", parentTaskId: 10 },
    // ── attach here: the equivalent snapshot of this instant ──
    {
      type: "tool_execution_end",
      toolCallId: "call-1/0",
      toolName: "bash",
      result: { taskId: 11, isError: false, diagnostics: [], structuredOutput: "done", durationMs: 900 },
      taskId: 11,
      parentToolCallId: "call-1",
      parentTaskId: 10,
    },
    { type: "tool_execution_end", toolCallId: "call-1", toolName: "delegate", entry: toolResultEntry(2, "call-1", "nested ok"), taskId: 10 },
    { type: "run_end", inputs: [1] },
  ];
  const replay = new AgentModel();
  replay.apply(snapshotFrame(snapshotOf({ run: { inputs: [1] } })));
  replay.apply(batchFrame(...events));

  const mid = 5; // after the nested start + update, before its end
  const midSnapshot = snapshotOf({
    entries: [assistantToolCall(1, "call-1")],
    run: { inputs: [1] },
    tools: [{ callId: "call-1", name: "delegate", status: "running", taskId: 10 }],
    nestedTools: [
      {
        callId: "call-1/0",
        name: "bash",
        status: "running",
        output: "half",
        parentCallId: "call-1",
        parentTaskId: 10,
        taskId: 11,
        arguments: { command: "ls" },
      },
    ],
  });
  const attached = new AgentModel();
  attached.apply(snapshotFrame(midSnapshot));
  attached.apply(batchFrame(...events.slice(mid)));

  assert.deepEqual(attached.state.items, replay.state.items, "attach mid-nested converges with full replay");
  assert.equal(attached.state.running, replay.state.running);
  assert.equal(attached.state.compactionFailure, replay.state.compactionFailure);
});
