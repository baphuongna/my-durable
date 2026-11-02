// R16 find-in-session (Unit B): client/find.ts is the pure core — flatten
// markdown, match case-insensitively, newest first, cap 200, empty query
// returns nothing. The overlay itself is wiring: asserted from source below
// and exercised by review, because searchTranscript must stay DOM-free.
import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { createServer } from "vite";

globalThis.window = globalThis.window ?? {
  matchMedia: (q) => ({
    matches: false,
    media: q,
    addEventListener() {},
    removeEventListener() {},
  }),
};
if (!globalThis.navigator)
  Object.defineProperty(globalThis, "navigator", {
    value: { userAgent: "node-test" },
    configurable: true,
  });

const FE_ROOT = new URL("../apps/dpi-playground-fe/", import.meta.url);
let vite: Awaited<ReturnType<typeof createServer>>;

test.before(async () => {
  vite = await createServer({
    configFile: new URL("vite.config.ts", FE_ROOT).pathname,
    server: { middlewareMode: true, hmr: false, watch: null },
    appType: "custom",
    logLevel: "error",
  });
});
test.after(async () => {
  await vite?.close();
});

const src = (p: string) =>
  readFileSync(new URL(`../apps/dpi-playground-fe/src/${p}`, import.meta.url), "utf8");

const find = () => vite.ssrLoadModule("/src/client/find.ts");

test("find: newest-first, case-insensitive, every hit carries its entry id", async () => {
  const { searchTranscript } = await find();
  const items = [
    { kind: "user", id: 1, text: "hello world" },
    { kind: "user", id: 2, text: "Hello again" },
    {
      kind: "assistant",
      id: 3,
      streaming: false,
      blocks: [{ type: "text", text: "say HELLO loudly" }],
    },
  ];
  const hits = searchTranscript(items, "hello");
  assert.deepEqual(
    hits.map((h) => h.itemId),
    [3, 2, 1],
    "results run newest entry first regardless of case",
  );
});

test("find: markdown is flattened before matching", async () => {
  const { searchTranscript } = await find();
  const items = [
    {
      kind: "assistant",
      id: 7,
      streaming: false,
      blocks: [{ type: "text", text: "## Ship it\n\n- **bold** claim and `code` too" }],
    },
    { kind: "user", id: 8, text: "see [docs](https://example.com/x) here" },
  ];
  assert.equal(searchTranscript(items, "ship it").length, 1, "heading markers drop out");
  assert.equal(
    searchTranscript(items, "bold claim and code too").length,
    1,
    "emphasis and code fences drop out",
  );
  assert.equal(searchTranscript(items, "docs").length, 1, "a link matches by its label");
  assert.equal(
    searchTranscript(items, "example.com").length,
    0,
    "the link target is not transcript text",
  );
});

test("find: excerpts are ≤160 chars, one line, centered on the match", async () => {
  const { searchTranscript } = await find();
  const text = `${"filler word ".repeat(50)}NEEDLE${" tail words".repeat(30)}`;
  const [hit] = searchTranscript([{ kind: "user", id: 1, text }], "needle");
  assert.ok(hit, "the match is found");
  assert.ok(hit.excerpt.length <= 160, `excerpt capped, got ${hit.excerpt.length}`);
  assert.ok(hit.excerpt.includes("NEEDLE"), "the excerpt shows the match, original case");
  assert.ok(!hit.excerpt.includes("\n"), "excerpt is one line");
  assert.ok(hit.excerpt.startsWith("…") && hit.excerpt.endsWith("…"), "clipped edges are marked");
});

test("find: empty or whitespace query returns nothing", async () => {
  const { searchTranscript } = await find();
  const items = [{ kind: "user", id: 1, text: "hello world" }];
  assert.deepEqual(searchTranscript(items, ""), []);
  assert.deepEqual(searchTranscript(items, "   "), []);
  assert.deepEqual(searchTranscript(items, "\n\t "), []);
});

test("find: results cap at 200 with the newest entries winning", async () => {
  const { searchTranscript } = await find();
  const many = Array.from({ length: 250 }, (_, i) => ({
    kind: "user",
    id: i + 1,
    text: `entry ${i} needle`,
  }));
  const hits = searchTranscript(many, "needle");
  assert.equal(hits.length, 200, "hard cap");
  assert.equal(hits[0].itemId, 250, "newest entry first");
  assert.equal(hits[199].itemId, 51, "oldest 50 fall off the end");
});

test("find: thinking blocks stay private, text blocks are searched", async () => {
  const { searchTranscript } = await find();
  const items = [
    {
      kind: "assistant",
      id: 5,
      streaming: false,
      blocks: [
        { type: "thinking", text: "secret-plan" },
        { type: "text", text: "visible answer" },
      ],
    },
  ];
  assert.deepEqual(searchTranscript(items, "secret"), [], "thinking is not transcript text");
  assert.equal(searchTranscript(items, "visible").length, 1);
});

test("find: tool results and events are searched, live tool calls are not", async () => {
  const { searchTranscript } = await find();
  const items = [
    { kind: "tool-result", id: 9, name: "read_file", text: "needle in result", isError: false },
    { kind: "event", id: 10, entryKind: "demo.state-change", text: "state needle", note: "extra detail" },
    { kind: "tool", id: "call_1", call: { callId: "call_1", name: "bash", args: {}, status: "running" } },
  ];
  assert.equal(searchTranscript(items, "needle in result").length, 1, "tool-result text");
  assert.equal(searchTranscript(items, "extra detail").length, 1, "event note");
  assert.deepEqual(searchTranscript(items, "bash"), [], "a live tool slot has no stable text");
});

test("find: several matches in one entry are separate hits with their indexes", async () => {
  const { searchTranscript } = await find();
  const hits = searchTranscript([{ kind: "user", id: 4, text: "a X b X c X" }], "x");
  assert.deepEqual(
    hits.map((h) => h.index),
    [2, 6, 10],
    "each match reports its offset in the flattened text",
  );
  assert.ok(hits.every((h) => h.itemId === 4));
});

test("FindOverlay wiring: debounced input, keyboard navigation, no Escape of its own", () => {
  const overlay = src("components/FindOverlay.vue");
  assert.match(overlay, /searchTranscript/, "the pure search drives the results");
  assert.match(overlay, /FIND_DEBOUNCE_MS = 150/, "input is debounced 150ms");
  assert.match(overlay, /"ArrowDown"/, "↓ moves through results");
  assert.match(overlay, /"ArrowUp"/, "↑ moves through results");
  assert.match(overlay, /"Enter"/, "Enter jumps to the highlighted result");
  assert.doesNotMatch(
    overlay,
    /e\.key === "Escape"/,
    "Escape belongs to AgentView's esc-stop policy, not the overlay",
  );
  assert.match(overlay, /min-height: 2\.75rem/, "result rows keep a ≥44px target");
});
