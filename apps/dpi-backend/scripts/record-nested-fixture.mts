/**
 * P1-10 recorder: writes a REAL pi-durable 1.3.0 stream fixture for nested tool calls and compaction
 * failures. Run from apps/dpi-backend:  npx tsx scripts/record-nested-fixture.mts
 *
 * This is a recording, not hand-authored JSON: a real Harness over MemoryStorage, a real fixture
 * extension whose tool calls another tool through `executeTool()` (a nested call), and scripted faux
 * model responses. The wire frames are exactly what `watchEvents` emits, serialized the way the backend
 * serializes them (`JSON.parse(JSON.stringify(...))`).
 *
 * Nothing secret is involved: faux provider, in-memory storage, temp workdir.
 */
import { mkdtemp, writeFile, mkdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { createHash } from "node:crypto";
import { BACKGROUND_CONTEXT as ctx } from "@earendil-works/chord/context";
import { createModels } from "@earendil-works/pi-ai/models";
import { Type } from "@earendil-works/pi-ai";
import {
  fauxAssistantMessage,
  fauxText,
  fauxToolCall,
  type FauxResponseStep,
} from "@earendil-works/pi-ai/providers/faux";
import { Harness, createRegistry, defineExtension, defineTool, watchEvents } from "@earendil-works/pi-durable";
import { CodingTools } from "@earendil-works/pi-durable/tools";
import { NodeExecutionEnv } from "@earendil-works/pi-durable/env/node";
import { MemoryStorage } from "@earendil-works/pi-durable/storage/memory";
import { installFaux } from "../src/faux.js";
import { DURABLE_VERSION } from "../src/store.js";

const OUT = resolve(import.meta.dirname, "../../dpi-sdk/tests/fixtures/agent-nested-turn.json");
const json = <T>(value: T): T => JSON.parse(JSON.stringify(value));

const work = await mkdtemp(join(tmpdir(), "dpi-record-nested-"));
const models = createModels();
const faux = installFaux(models);

// Scripted answers, consumed in order. Anything unscripted echoes, so the recorder never wedges.
const script: FauxResponseStep[] = [
  // 1. The user turn: the model calls the fixture tool, which makes a nested bash call.
  fauxAssistantMessage([fauxText("Running the nested tool."), fauxToolCall("outer", { command: "sleep 0.4; echo nested-result" })], {
    stopReason: "toolUse",
  }),
  // 2. After the tool result: a normal answer ends the turn.
  fauxAssistantMessage(fauxText("The nested call returned nested-result.")),
  // 3. First manual compaction: the summarizer fails with a model error.
  fauxAssistantMessage(fauxText(""), { stopReason: "error", errorMessage: "scripted compaction failure" }),
  // 4. Second manual compaction: it succeeds.
  fauxAssistantMessage(fauxText("Summary of the fixture conversation.")),
];
const factory = ((context, options, state, model) => {
  faux.appendResponses([factory]); // every request takes one step and re-arms the script
  const next = script.shift();
  if (next === undefined) return fauxAssistantMessage(fauxText("Echo: fixture fallback"));
  return typeof next === "function" ? next(context, options, state, model) : next;
}) as FauxResponseStep;
faux.setResponses([factory]);

// A fixture tool that makes a real nested call through executeTool().
const outer = defineTool({
  name: "outer",
  description: "Runs a nested tool call and reports what it returned.",
  parameters: Type.Object({ command: Type.String() }),
  execute: async (args, api) => {
    const nested = await api.executeTool("bash", { command: args.command }, ctx);
    return {
      output: [{ type: "text", text: `outer saw: ${JSON.stringify(nested.structuredOutput ?? null)}` }],
    };
  },
});
const fixtureExtension = defineExtension({ name: "fixture-nested", tools: [outer] });

const registry = createRegistry();
registry.install(CodingTools);
registry.install(fixtureExtension);

const harness = await Harness.open(
  new MemoryStorage(),
  {
    models,
    registry,
    env: ({ cwd }) => new NodeExecutionEnv({ cwd: cwd ?? work, shellEnv: { PATH: process.env.PATH ?? "" } }),
    settings: {
      extensions: [CodingTools, fixtureExtension],
      // Tiny reserves so a manual compaction always selects a range, even in a short transcript.
      compaction: { enabled: true, reserveTokens: 8, backgroundTokens: 0, keepRecentTokens: 1 },
      progress: { partialIntervalMs: 100, outputIntervalMs: 100 },
    },
    onReport: (e) => console.error("[record]", String(e)),
  },
  ctx,
);
const conversation = await harness.root(ctx, {
  agent: { cwd: work, model: { provider: "faux", modelId: "echo" }, thinkingLevel: "low" },
});
harness.resume();

const stream = await watchEvents(harness, conversation.id, ctx);
const frames: unknown[] = [{ type: "snapshot", snapshot: json(stream.snapshot), inbox: [] }];
stream.start(async (events) => {
  frames.push({ type: "batch", events: json(events) });
  await Promise.resolve();
});

// 1. A turn that produces a nested call. A second attachment is taken while the nested call is still
// running, so the fixture carries a real mid-nested snapshot (not a hand-written one).
const submission = await conversation.submit(
  { type: "input", content: "nested: echo nested-result", requestId: "fixture-nested-1", whenBusy: "followUp" },
  ctx,
);
let midSnapshot: unknown | undefined;
for (let attempt = 0; attempt < 200 && midSnapshot === undefined; attempt++) {
  const probe = await watchEvents(harness, conversation.id, ctx);
  if (probe.snapshot.nestedTools.some((slot) => slot.status !== "done")) midSnapshot = json(probe.snapshot);
  await probe.stop(ctx);
  if (midSnapshot === undefined) await new Promise((r) => setTimeout(r, 10));
}
if (midSnapshot === undefined) throw new Error("never observed a running nested call; fixture would lack a mid-nested snapshot");
frames.push({ type: "snapshot", snapshot: midSnapshot, inbox: [] });
await harness.waitForIdle(ctx);

// 2. A manual compaction that fails (scripted model error), then one that succeeds.
const failed = await conversation.compact(undefined, ctx);
const failedReceipt = await harness.waitForTask(failed, ctx);
await harness.waitForIdle(ctx);
const ok = await conversation.compact(undefined, ctx);
const okReceipt = await harness.waitForTask(ok, ctx);
await harness.waitForIdle(ctx);

await stream.stop(ctx);
await harness.close(ctx);

const manifest = {
  provenance: {
    note: "Recorded from a real pi-durable Harness (MemoryStorage, fixture extension, scripted faux model). Not hand-authored.",
    piDurable: DURABLE_VERSION,
    node: process.version,
    recordedAt: new Date().toISOString(),
    generator: "apps/dpi-backend/scripts/record-nested-fixture.mts",
    profile: { provider: "faux", model: "echo", turns: 1, nested: 1, compactions: 2 },
    outcomes: {
      submission: submission.id,
      failedCompaction: { taskId: failed, status: failedReceipt.state.status },
      okCompaction: { taskId: ok, status: okReceipt.state.status },
    },
  },
  frames,
};
await mkdir(resolve(OUT, ".."), { recursive: true });
const text = `${JSON.stringify(manifest, null, 2)}\n`;
await writeFile(OUT, text);
console.log(`wrote ${OUT} (${frames.length} frames, sha256 ${createHash("sha256").update(text).digest("hex").slice(0, 16)})`);
console.log("outcomes:", JSON.stringify(manifest.provenance.outcomes));
