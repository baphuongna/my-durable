import { test } from "node:test";
import assert from "node:assert/strict";
import { AgentModel, SessionModel, networkTree, lineage } from "../src/models.js";
import { toMarkdown, toTranscript, sumUsage } from "../src/transcript.js";
import type {
  AgentSummary,
  NetworkDevice,
  WireAssistantMessage,
  WireEntry,
  WireSnapshotEvent,
  WireUsage,
} from "../src/api.js";

const usage: WireUsage = {
  input: 10,
  output: 5,
  cacheRead: 0,
  cacheWrite: 0,
  totalTokens: 15,
  cost: { input: 0.001, output: 0.002, cacheRead: 0, cacheWrite: 0, total: 0.003 },
};
const assistant = (content: WireAssistantMessage["content"], extra: Partial<WireAssistantMessage> = {}): WireAssistantMessage => ({
  role: "assistant",
  content,
  provider: "openrouter",
  model: "m",
  usage,
  stopReason: "stop",
  ...extra,
});
const user = (id: number, text: string): WireEntry => ({
  id,
  conversationId: 1,
  kind: "pi.user",
  model: [{ role: "user", content: text }],
});
const snapshot = (entries: WireEntry[], extra: Partial<WireSnapshotEvent> = {}): WireSnapshotEvent => ({
  type: "snapshot",
  entries,
  tools: [],
  nestedTools: [],
  compactions: [],
  inbox: [],
  agent: { model: { provider: "openrouter", modelId: "m" } },
  usage: { models: { "openrouter/m": usage }, tools: {} },
  ...extra,
});

test("a streamed turn: snapshot, deltas, tool output, results and dedupe", () => {
  const model = new AgentModel();
  let renders = 0;
  model.subscribe(() => renders++);
  model.apply({ type: "snapshot", snapshot: snapshot([user(1, "hi")]), inbox: [] });
  assert.equal(model.state.ready, true);
  assert.deepEqual(model.state.items.map((i) => i.kind), ["user"]);

  model.apply({
    type: "batch",
    events: [
      { type: "run_start", inputs: [1] },
      { type: "message_start", message: assistant([]) },
      {
        type: "message_update",
        usage,
        changes: [
          { type: "text_start", contentIndex: 0, block: { type: "text", text: "" } },
          { type: "text_delta", contentIndex: 0, delta: "Let me " },
          { type: "text_delta", contentIndex: 0, delta: "look." },
          { type: "toolcall_start", contentIndex: 1, block: { type: "toolCall", id: "c1", name: "bash", arguments: {} } },
          { type: "toolcall_delta", contentIndex: 1, path: ["arguments", "command"], delta: "ls" },
          { type: "toolcall_delta", contentIndex: 1, path: ["arguments", "command"], delta: " -la" },
        ],
      },
    ],
  });
  let live = model.state.items.at(-1)!;
  assert.equal(live.kind, "assistant");
  assert.equal(live.kind === "assistant" && live.streaming, true);
  assert.deepEqual(live.kind === "assistant" && live.blocks[0], { type: "text", text: "Let me look." });
  const call = live.kind === "assistant" && live.blocks[1].type === "tool" ? live.blocks[1].call : undefined;
  assert.deepEqual(call?.args, { command: "ls -la" });
  assert.equal(model.state.running, true);

  const finalAssistant: WireEntry = {
    id: 2,
    conversationId: 1,
    kind: "pi.assistant",
    model: [assistant([{ type: "text", text: "Let me look." }, { type: "toolCall", id: "c1", name: "bash", arguments: { command: "ls -la" } }])],
  };
  model.apply({
    type: "batch",
    events: [
      { type: "message_end", entry: finalAssistant },
      { type: "entry_appended", entry: finalAssistant }, // duplicate delivery must not duplicate the item
      { type: "tool_execution_start", toolCallId: "c1", toolName: "bash", args: { command: "ls -la" } },
      { type: "tool_execution_update", toolCallId: "c1", toolName: "bash", output: { append: "a\nb\n" } },
      { type: "tool_execution_update", toolCallId: "c1", toolName: "bash", output: { trimStart: 2, append: "c\n" } },
    ],
  });
  assert.equal(model.state.items.filter((i) => i.kind === "assistant").length, 1);
  const running = model.state.items[1];
  const runningCall = running.kind === "assistant" && running.blocks[1].type === "tool" ? running.blocks[1].call : undefined;
  assert.equal(runningCall?.status, "running");
  assert.equal(runningCall?.output, "b\nc\n");

  model.apply({
    type: "batch",
    events: [
      {
        type: "tool_execution_end",
        toolCallId: "c1",
        toolName: "bash",
        entry: {
          id: 3,
          conversationId: 1,
          kind: "pi.tool-result",
          model: [{ role: "toolResult", toolCallId: "c1", toolName: "bash", content: [{ type: "text", text: "a\nb\nc\n" }], isError: false }],
        },
      },
      { type: "message_end", entry: { id: 4, conversationId: 1, kind: "pi.assistant", model: [assistant([{ type: "text", text: "Done." }])] } },
      { type: "run_end", inputs: [1] },
    ],
  });
  const kinds = model.state.items.map((i) => i.kind);
  assert.deepEqual(kinds, ["user", "assistant", "assistant"]);
  const done = model.state.items[1];
  const doneCall = done.kind === "assistant" && done.blocks[1].type === "tool" ? done.blocks[1].call : undefined;
  assert.equal(doneCall?.status, "done");
  assert.equal(doneCall?.result, "a\nb\nc\n");
  assert.equal(doneCall?.resultEntryId, 3);
  assert.equal(model.state.running, false);
  assert.ok(renders >= 4);
  assert.match(toMarkdown(model.state.items), /### You \(#1\)\n\nhi/);
});

test("overflow snapshot inside a batch replaces state; inbox and docs frames apply", () => {
  const model = new AgentModel();
  model.apply({ type: "snapshot", snapshot: snapshot([user(1, "a"), user(2, "b")]), inbox: [] });
  model.apply({ type: "batch", events: [snapshot([user(9, "fresh")], { run: { inputs: [9] } })] });
  assert.deepEqual(model.state.items.map((i) => i.kind === "user" && i.text), ["fresh"]);
  assert.equal(model.state.running, true);
  model.apply({ type: "inbox", items: [{ id: 7, mode: "steer", content: "use pnpm" }] });
  model.apply({ type: "doc", kind: "demo.jobs", value: { items: {} } });
  assert.equal(model.state.inbox[0].content, "use pnpm");
  assert.deepEqual(model.state.docs["demo.jobs"], { items: {} });
});

test("reset entry drops the old context; aborted partials and unmatched results render", () => {
  const model = new AgentModel();
  model.apply({ type: "snapshot", snapshot: snapshot([user(1, "old"), user(2, "older")]), inbox: [] });
  model.apply({ type: "batch", events: [{ type: "entry_appended", entry: { id: 5, conversationId: 1, kind: "pi.reset", head: 5 } }] });
  assert.deepEqual(model.state.items.map((i) => i.kind), ["event"]);
  // pi-durable delivers a reset with a handoff note as message_end, not entry_appended.
  const viaMessage = new AgentModel();
  viaMessage.apply({ type: "snapshot", snapshot: snapshot([user(1, "old")]), inbox: [] });
  viaMessage.apply({
    type: "batch",
    events: [{ type: "message_end", entry: { id: 7, conversationId: 1, kind: "pi.reset", head: 7, model: [{ role: "user", content: "note" }] } }],
  });
  assert.deepEqual(viaMessage.state.entries.map((e) => e.id), [7]);

  const items = toTranscript([
    { id: 1, conversationId: 1, kind: "pi.assistant", model: [assistant([{ type: "text", text: "part" }], { stopReason: "aborted" })] },
    { id: 2, conversationId: 1, kind: "pi.tool-result", model: [{ role: "toolResult", toolCallId: "gone", toolName: "read", content: [{ type: "text", text: "x" }], isError: true }] },
    { id: 3, conversationId: 1, kind: "pi.system", model: [] },
    { id: 4, conversationId: 1, kind: "demo.event", data: { text: "Job done" } },
  ]);
  assert.deepEqual(items.map((i) => i.kind), ["assistant", "tool-result", "event"]);
  assert.equal(items[0].kind === "assistant" && items[0].error, "Interrupted. Partial response preserved.");
  assert.equal(items[2].kind === "event" && items[2].text, "Job done");
  assert.equal(sumUsage({ models: { a: usage, b: usage } }).tokens, 30);
});

test("session lineage and network tree nest forks and subagents", () => {
  const agents: AgentSummary[] = [
    { id: 1, name: "Main", named: false, kind: "root", busy: true, background: 0 },
    { id: 4, name: "alt", named: true, kind: "fork", parentId: 1, forkedAt: 3, busy: false, background: 0 },
    { id: 6, name: "Subagent #6", named: false, kind: "subagent", ownerAgentId: 4, ownerTaskId: 9, busy: true, background: 0 },
    { id: 7, name: "Root #7", named: false, kind: "root", busy: false, background: 1 },
  ];
  assert.deepEqual(lineage(agents, 4).map((a) => a.id), [1, 4]);
  const session = new SessionModel();
  session.apply({ type: "session", agents, tasks: [{ id: 1, kind: "pi.generation", conversationId: 1, background: false, state: { status: "running" }, conversations: [] }], usage: { models: {}, tools: {} } });
  assert.equal(session.foregroundBusy(1), true);
  assert.equal(session.foregroundBusy(7), false);
  const device: NetworkDevice = {
    id: "box",
    name: "Box",
    kind: "ssh",
    transport: "lan",
    url: "http://box:4780",
    source: "config",
    hasToken: true,
    status: "online",
    tree: { uid: "u", name: "box", at: 1, sessions: [{ id: "s1", name: "S", cwd: "/w", model: "m", provider: "faux", createdAt: 1, dbPath: "/d", busy: true, agents }] },
  };
  const [root] = networkTree([device]);
  const sessionNode = root.children[0];
  assert.equal(sessionNode.key, "box/s/s1");
  assert.deepEqual(sessionNode.children.map((n) => n.type === "agent" && n.agent.id), [1, 7]);
  const main = sessionNode.children[0];
  assert.deepEqual(main.children.map((n) => n.type === "agent" && n.agent.id), [4]);
  assert.deepEqual(main.children[0].children.map((n) => n.type === "agent" && n.agent.id), [6]);
  assert.equal(networkTree([{ ...device, status: "offline" }])[0].stale, true);
});

test("a recorded real stream (dpi-backend + pi-durable watchEvents) reduces to the server's transcript", async () => {
  const { readFileSync } = await import("node:fs");
  const fixture = JSON.parse(readFileSync(new URL("./fixtures/agent-tool-turn.json", import.meta.url), "utf8"));
  const model = new AgentModel();
  for (const frame of fixture.frames) model.apply(frame);
  assert.deepEqual(JSON.parse(JSON.stringify(model.state.items)), fixture.transcript);
  assert.equal(model.state.running, false);
  // Replaying from a mid-stream snapshot converges too.
  const fromSnapshot = new AgentModel();
  const start = fixture.frames.findIndex((f: { type: string }) => f.type === "snapshot");
  for (const frame of fixture.frames.slice(start)) fromSnapshot.apply(frame);
  assert.deepEqual(fromSnapshot.state.items, model.state.items);
});

test("R19 h10: a hostile contentIndex never holes the live message (drop the change whole)", () => {
  const usage = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } };
  // Out-of-range indices are dropped whole. (index === content.length is a legal
  // append, so the hostile set starts past it.)
  for (const index of [1, 2, 2 ** 32 - 2, -1, 1.5, Number.NaN]) {
    const model = new AgentModel();
    // Leader probe: the raw index crashed toTranscript's for-of ("Cannot read
    // properties of undefined") on the NEXT rebuild — the SSE follow loop turned
    // that into a disconnect/reconnect churn loop.
    assert.doesNotThrow(() =>
      model.apply({ type: "batch", events: [{ type: "message_update", usage, changes: [{ type: "text_start", contentIndex: index, block: { type: "text", text: "x" } }] }] } as never),
    );
    // The live item exists (a generation started), but the hostile CHANGE was
    // dropped whole: no block, no hole, and rendering it must not throw.
    const items = (model.state as { items?: { blocks?: { type?: string }[] }[] }).items ?? [];
    for (const item of items) assert.deepEqual(item.blocks ?? [], [], `index ${index} must not land a block`);
  }
  // The honest index still applies — no throw and the live generation is set
  // (the live message itself is private; the guard must not reject valid frames).
  const ok = new AgentModel();
  ok.apply({ type: "batch", events: [{ type: "message_update", usage, changes: [{ type: "text_start", contentIndex: 0, block: { type: "text", text: "hi" } }] }] } as never);
  assert.equal((ok.state as { generating?: boolean }).generating, true, "a valid in-range change keeps the generation live");
});

test("R19 h10: the entries map is capped so a hostile stream cannot grow memory without bound", () => {
  const model = new AgentModel();
  for (let b = 0; b < 8; b++) {
    const events = [];
    for (let i = 0; i < 1000; i++)
      events.push({ type: "entry_appended", entry: { id: b * 1000 + i + 1, conversationId: 1, kind: "pi.user", model: [{ role: "user", content: "x" }] } });
    model.apply({ type: "batch", events } as never);
  }
  // Leader probe measured attacker-linear growth (10k entries, +11 MB, no ceiling).
  const items = (model.state as { items?: unknown[] }).items ?? [];
  assert.ok(items.length <= 5_100, `state must stay bounded, got ${items.length}`);
});

test("R19 cold-review M3: the entry cap also holds for snapshots and tool results", () => {
  const model = new AgentModel();
  const entries = Array.from({ length: 20_000 }, (_, i) => ({
    id: i + 1,
    conversationId: 1,
    kind: "pi.user",
    model: [{ role: "user", content: "x" }],
  }));
  model.apply({ type: "snapshot", snapshot: { entries, tools: [], nestedTools: [], compactions: [], agent: { name: "a" }, usage: null }, inbox: [] } as never);
  assert.ok(((model.state as { entries?: unknown[] }).entries ?? []).length <= 5_000, "a hostile snapshot is capped too");
  const m2 = new AgentModel();
  for (let i = 0; i < 7_000; i++)
    m2.apply({ type: "batch", events: [{ type: "tool_execution_end", toolCallId: `c${i}`, entry: { id: i + 1, conversationId: 1, kind: "pi.tool-result", model: [] } }] } as never);
  assert.ok(((m2.state as { entries?: unknown[] }).entries ?? []).length <= 5_000, "tool results feed the same cap");
});

test("R19 cold-review: the tools map is bounded too (30k tool slots = OOM + quadratic CPU)", () => {
  const model = new AgentModel();
  const t0 = performance.now();
  for (let i = 0; i < 5_000; i++)
    model.apply({ type: "batch", events: [{ type: "tool_execution_start", toolCallId: `c${i}`, toolName: "bash", args: {} }] } as never);
  const elapsed = performance.now() - t0;
  const size = (model as unknown as { tools: Map<string, unknown> }).tools.size;
  assert.ok(size <= 2_001, `tools map must stay bounded, got ${size}`);
  assert.ok(elapsed < 10_000, `bounded per-frame cost, took ${Math.round(elapsed)}ms`);
});

test("R20 h4: snapshot.tools and BOTH orphan-creating paths are capped too", () => {
  const snap = (tools: unknown[]) =>
    ({ type: "snapshot", snapshot: { entries: [], tools, nestedTools: [], compactions: [], agent: {}, usage: { models: {}, tools: {} } }, inbox: [] }) as never;
  const sized = (m: AgentModel) => (m as unknown as { tools: Map<string, unknown> }).tools.size;
  const a = new AgentModel();
  a.apply(snap([]));
  a.apply(snap(Array.from({ length: 50_000 }, (_, i) => ({ callId: "s" + i, name: "n", status: "running", output: "" }))));
  assert.ok(sized(a) <= 2_000, `hostile snapshot.tools must be sliced, got ${sized(a)}`);
  const b = new AgentModel();
  b.apply(snap([]));
  for (let i = 0; i < 10_000; i++)
    b.apply({ type: "batch", events: [{ type: "tool_execution_update", toolCallId: "u" + i, toolName: "x", output: { set: "" } }] } as never);
  assert.ok(sized(b) <= 2_001, `update orphans must be capped, got ${sized(b)}`);
  const c = new AgentModel();
  c.apply(snap([]));
  for (let i = 0; i < 10_000; i++)
    c.apply({ type: "batch", events: [{ type: "tool_execution_end", toolCallId: "n" + i, toolName: "x", result: { taskId: 1, isError: false, durationMs: 1, structuredOutput: "r" } }] } as never);
  assert.ok(sized(c) <= 2_001, `end-with-result orphans must be capped, got ${sized(c)}`);
});

test("R20 h5: a hostile tasks frame with null/state-less rows must not throw in the render path", () => {
  const m = new SessionModel();
  m.apply({ type: "tasks", tasks: [null] } as never);
  assert.equal(m.backgroundTasks().length, 0, "null row dropped at the boundary");
  assert.equal(m.foregroundBusy(1), false);
  const m2 = new SessionModel();
  m2.apply({ type: "tasks", tasks: [{ id: 1, kind: "x", conversationId: 1, background: false }] } as never);
  assert.doesNotThrow(() => m2.backgroundTasks(1), "state-less row is dropped, not dereferenced");
  assert.equal(m2.state.tasks.length, 0);
});

test("R20 cold-1 M2: per-slot output is byte-capped (100 x 1MiB appends on one callId)", () => {
  const m = new AgentModel();
  m.apply({ type: "batch", events: [{ type: "tool_execution_start", toolCallId: "c1", toolName: "x", args: {} }] } as never);
  for (let i = 0; i < 100; i++)
    m.apply({ type: "batch", events: [{ type: "tool_execution_update", toolCallId: "c1", toolName: "x", output: { append: "y".repeat(1024 * 1024) } }] } as never);
  const out = (m as unknown as { tools: Map<string, { output: string }> }).tools.get("c1")!.output;
  assert.ok(out.length <= 256 * 1024, `retained ${out.length} bytes, must be <= 256 KiB`);
});

test("R20 cold-1 M2: snapshot.tools + nestedTools UNION stays <= 2000", () => {
  const snap = (tools: unknown[], nested: unknown[]) =>
    ({ type: "snapshot", snapshot: { entries: [], tools, nestedTools: nested, compactions: [], agent: {}, usage: { models: {}, tools: {} } }, inbox: [] }) as never;
  const mk = (n: number, p: string) => Array.from({ length: n }, (_, i) => ({ callId: `${p}${i}`, name: "n", status: "running", output: "o" }));
  const m = new AgentModel();
  m.apply(snap([], []));
  m.apply(snap(mk(2000, "t"), mk(2000, "n").map((s) => ({ ...s, parentCallId: "t0", parentTaskId: 1, taskId: 1, arguments: {} }))));
  assert.ok((m as unknown as { tools: Map<string, unknown> }).tools.size <= 2_000, "union must stay <= 2000");
});

test("R20 cold-1 M3: the session frame validates tasks/agents too ({} / null must not crash render)", async () => {
  const { SessionModel } = await import("../src/models.ts");
  const m = new SessionModel();
  assert.doesNotThrow(() => m.apply({ type: "session", agents: [], tasks: {}, usage: { models: {}, tools: {} } } as never));
  assert.equal(m.backgroundTasks().length, 0, "tasks:{} degrades to empty, not a crash");
  assert.doesNotThrow(() => m.apply({ type: "tasks", tasks: null } as never));
  assert.equal(m.state.tasks.length, 0, "tasks:null degrades to empty");
});

test("R20 cold-2 M1: oversized args become a bounded preview (not verbatim retention)", () => {
  const m = new AgentModel();
  const blob = "x".repeat(2 * 1024 * 1024);
  for (let i = 0; i < 50; i++)
    m.apply({ type: "batch", events: [{ type: "tool_execution_start", toolCallId: "b" + i, toolName: "x", args: { blob } }] } as never);
  const tools = (m as unknown as { tools: Map<string, { args?: { truncated?: boolean; preview?: string } }> }).tools;
  for (const slot of tools.values()) {
    assert.equal(slot.args?.truncated, true, "oversized args marked truncated");
    assert.ok((slot.args?.preview?.length ?? 0) <= 4_096, `preview bounded, got ${slot.args?.preview?.length}`);
    // verbatim retention check: the FULL 2 MiB blob must not be reachable
    assert.ok((slot.args as { blob?: unknown }).blob === undefined, "the blob value itself is gone");
  }
  // small args pass through untouched
  m.apply({ type: "batch", events: [{ type: "tool_execution_start", toolCallId: "small", toolName: "x", args: { a: 1 } }] } as never);
  assert.deepEqual((tools.get("small")!.args as unknown), { a: 1 });
});

test("R20 cold-2 M2: hostile session/agents frames drop null elements at the boundary", async () => {
  const { SessionModel } = await import("../src/models.ts");
  const m = new SessionModel();
  m.apply({ type: "session", agents: [null, { id: 1, name: "Main", kind: "root" }], tasks: [], usage: { models: {}, tools: {} } } as never);
  assert.equal(m.state.agents.length, 1, "null agent dropped");
  assert.doesNotThrow(() => m.lineage(1));
  m.apply({ type: "agents", agents: [undefined, "x", { id: 2, name: "Fork", kind: "fork", parentId: 1 }] } as never);
  assert.equal(m.state.agents.length, 1, "primitives dropped, the object kept (the frame REPLACES the array)");
});

test("R20 cold-3 M1: oversized tool ids/names are dropped, not retained verbatim", () => {
  const m = new AgentModel();
  m.apply({ type: "batch", events: [{ type: "tool_execution_start", toolCallId: "x".repeat(16 * 1024 * 1024), toolName: "n", args: {} }] } as never);
  m.apply({ type: "batch", events: [{ type: "tool_execution_start", toolCallId: "ok", toolName: "n".repeat(16 * 1024 * 1024), args: {} }] } as never);
  assert.equal((m as unknown as { tools: Map<string, unknown> }).tools.size, 0, "oversized id/name slots dropped");
  m.apply({ type: "batch", events: [{ type: "tool_execution_start", toolCallId: "fine", toolName: "bash", args: {} }] } as never);
  assert.equal((m as unknown as { tools: Map<string, unknown> }).tools.size, 1, "normal slots kept");
});

test("R20 cold-3 M3: hostile network trees (null agents/sessions/devices) never throw in tree()", async () => {
  const { NetworkModel } = await import("../src/models.ts");
  const nm = new NetworkModel();
  nm.apply({ type: "network", devices: [null, { id: "d", status: "online", tree: { sessions: [null, { id: "s", agents: [null, { id: 1, name: "M", kind: "root" }] }] } }] } as never);
  let count = 0;
  for (const d of nm.tree()) {
    count++;
    for (const sess of d.children) count += sess.children.length;
  }
  assert.ok(count >= 2, `sanitized tree renders, got ${count} nodes`);
});

test("run-7 D3 F1: oversized ids/names are dropped on update and end-result paths too", () => {
  const m = new AgentModel();
  m.apply({ type: "batch", events: [{ type: "tool_execution_update", toolCallId: "x".repeat(65536), toolName: "y".repeat(65536), output: { set: "" } }] } as never);
  m.apply({ type: "batch", events: [{ type: "tool_execution_end", toolCallId: "z".repeat(65536), toolName: "w".repeat(65536), result: { taskId: 1, isError: false, durationMs: 1, structuredOutput: { ok: 1 } } }] } as never);
  assert.equal((m as unknown as { tools: Map<string, unknown> }).tools.size, 0, "no oversized id/name slot survives either orphan path");
});

test("run-7 D3 F2: doc kinds are capped and oversized values become bounded previews", () => {
  const m = new AgentModel();
  for (let i = 0; i < 100; i++) m.apply({ type: "doc", kind: "k" + i, value: "v" } as never);
  const kinds = Object.keys((m as unknown as { state: { docs: Record<string, unknown> } }).state.docs);
  assert.equal(kinds.length, 64, "newest 64 kinds survive");
  assert.ok(kinds.includes("k99") && !kinds.includes("k0"), "eviction is by insertion order");
  m.apply({ type: "doc", kind: "big", value: "x".repeat(200 * 1024) } as never);
  const big = (m as unknown as { state: { docs: Record<string, { truncated?: boolean; preview?: string }> } }).state.docs.big;
  assert.equal(big.truncated, true);
  assert.equal(big.preview?.length, 4096, "preview is a flattened 4Ki prefix");
});

test("run-7 D4-B: hostile snapshot/batch/inbox carriers never throw", () => {
  const m = new AgentModel();
  const ok = m.apply({ type: "snapshot", snapshot: { entries: {} as never, tools: [null] as never, nestedTools: [] as never, compactions: [] as never, agent: {} as never, usage: { models: {} }, inbox: "nope" as never } } as never);
  assert.equal(ok, true);
  assert.equal((m as unknown as { state: { ready: boolean } }).state.ready, true, "a hostile snapshot still reaches ready");
  m.apply({ type: "batch", events: {} as never } as never);
  m.apply({ type: "inbox", items: [null, 5, "x"] as never } as never);
  const inbox = (m as unknown as { state: { inbox: unknown[] } }).state.inbox;
  assert.equal(inbox.length, 0, "null/primitive inbox items are dropped, not stored");
});

test("run-7 D3 F3: entry text blocks are tail-capped at commit", () => {
  const m = new AgentModel();
  const big = "a".repeat(300 * 1024);
  m.apply({ type: "batch", events: [{ type: "entry_appended", entry: { id: 1, kind: "assistant", model: [{ role: "assistant", content: [{ type: "text", text: big }] }] } }] } as never);
  const entry = (m as unknown as { entries: Map<number, { model?: { content?: { text?: string }[] }[] }> }).entries.get(1);
  const text = entry?.model?.[0]?.content?.[0]?.text ?? "";
  assert.ok(text.length <= 256 * 1024 + 20, `entry text capped, got ${text.length}`);
  assert.match(text, /\[truncated\]$/, "capped text carries the marker");
});

test("run-7 D4-C: sumUsage skips null usage entries", async () => {
  const { sumUsage } = await import("../src/transcript.ts");
  const t = sumUsage({ models: { x: null as never, y: { input: 1, output: 2, cacheRead: 0, cacheWrite: 0, totalTokens: 3, cost: { total: 0, input: 0, output: 0, cacheRead: 0, cacheWrite: 0 } } } } as never);
  assert.equal(t.tokens, 3, "null entries are skipped, honest ones summed");
});

test("run-8 U5: task_failed / inbox / live clone are size-capped (verbatim frame-ceiling strings cannot be retained)", () => {
  const m = new AgentModel();
  const big = "x".repeat(1 << 20);
  for (let i = 0; i < 12; i++) m.apply({ type: "batch", events: [{ type: "task_failed", kind: "spawner", message: big }] } as never);
  assert.equal(m.state.notices.length, 10, "notice count cap");
  assert.ok(m.state.notices[0]!.length < 8 * 1024, `notice text must be capped, got ${m.state.notices[0]!.length}`);
  // oversized kind is dropped outright
  m.apply({ type: "batch", events: [{ type: "task_failed", kind: "k".repeat(500), message: "m" }] } as never);
  assert.equal(m.state.notices.length, 10, "oversized kind must not enqueue a notice");

  m.apply({ type: "inbox", items: [{ id: "i1", content: big }] } as never);
  assert.equal(m.state.inbox.length, 1);
  assert.ok(((m.state.inbox[0] as { content?: string }).content ?? "").length < 130 * 1024, "inbox content must be capped");

  m.apply({ type: "inbox", items: Array.from({ length: 500 }, (_, i) => ({ id: `i${i}`, content: "x" })) } as never);
  assert.ok(m.state.inbox.length <= 128, `inbox item cap, got ${m.state.inbox.length}`);

  m.apply({ type: "batch", events: [{ type: "message_start", message: { id: "a1", role: "assistant", content: [{ type: "text", text: big }] } }] } as never);
  const live = (m as unknown as { live?: { content?: { text?: string }[] } }).live;
  assert.ok((live?.content?.[0]?.text ?? "").length <= 256 * 1024, "live clone text must respect LIVE_TEXT_CAP");
});
