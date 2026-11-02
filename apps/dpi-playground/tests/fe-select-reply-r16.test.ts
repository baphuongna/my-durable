// R16 reply-to-passage (Unit B): the selection decision is pure in
// client/find.ts (pickAssistantReply) — AgentView only resolves DOM nodes to
// entry ids. Only assistant replies quote; user messages and selections
// spanning several entries never do. The excerpt is oneLine-sanitized before
// it reaches Unit A's useReplyQuote contract; the strip itself is Unit A's.
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

const picker = () => vite.ssrLoadModule("/src/client/find.ts");

const entries = [
  { id: 1, role: "user" },
  { id: 2, role: "assistant" },
  { id: 3, role: "assistant" },
  { id: "live", role: "assistant" },
];

test("selection: one assistant reply quotes with a one-line excerpt", async () => {
  const { pickAssistantReply } = await picker();
  assert.deepEqual(
    pickAssistantReply(entries, {
      anchorId: "2",
      focusId: "2",
      text: "the plan\nchanged   today",
    }),
    { entryId: 2, excerpt: "the plan changed today", label: "Pi · entry #2" },
    "newlines and runs collapse before the quote is stored",
  );
});

test("selection: a user message never quotes", async () => {
  const { pickAssistantReply } = await picker();
  assert.equal(
    pickAssistantReply(entries, { anchorId: "1", focusId: "1", text: "my own words" }),
    null,
  );
});

test("selection: a sweep across two entries never quotes", async () => {
  const { pickAssistantReply } = await picker();
  assert.equal(
    pickAssistantReply(entries, { anchorId: "2", focusId: "3", text: "across replies" }),
    null,
    "two assistant entries",
  );
  assert.equal(
    pickAssistantReply(entries, { anchorId: "1", focusId: "2", text: "into a reply" }),
    null,
    "user message into a reply",
  );
});

test("selection: reaching outside the transcript never quotes", async () => {
  const { pickAssistantReply } = await picker();
  assert.equal(
    pickAssistantReply(entries, { anchorId: null, focusId: "2", text: "outside" }),
    null,
    "anchor outside",
  );
  assert.equal(
    pickAssistantReply(entries, { anchorId: "2", focusId: "7", text: "unknown entry" }),
    null,
    "focus in an entry the transcript does not have",
  );
});

test("selection: an empty or whitespace-only selection never quotes", async () => {
  const { pickAssistantReply } = await picker();
  assert.equal(pickAssistantReply(entries, { anchorId: "2", focusId: "2", text: "" }), null);
  assert.equal(pickAssistantReply(entries, { anchorId: "2", focusId: "2", text: " \n\t " }), null);
});

test("selection: control characters collapse out of the excerpt", async () => {
  const { pickAssistantReply } = await picker();
  const target = pickAssistantReply(entries, {
    anchorId: "3",
    focusId: "3",
    text: "a\u2028b\u0007c",
  });
  assert.equal(target?.excerpt, "a b c", "r15 sanitize discipline before rendering");
});

test("selection: the live streaming reply quotes under its live id", async () => {
  const { pickAssistantReply } = await picker();
  const target = pickAssistantReply(entries, {
    anchorId: "live",
    focusId: "live",
    text: "still streaming",
  });
  assert.equal(target?.label, "Pi · entry #live");
});

test("AgentView wiring: selection → Reply chip → Unit A's quote contract", () => {
  const view = src("components/AgentView.vue");
  assert.match(view, /import \{ useReplyQuote \} from "\.\.\/client\/quote"/, "the pinned Unit A contract");
  assert.match(
    view,
    /replyQuote\.setQuote\(target\.excerpt, target\.label\)/,
    "the chip stores the sanitized excerpt with its source label",
  );
  assert.match(view, /pickAssistantReply\(/, "the pure decision drives the chip");
  assert.match(view, /selectionchange/, "selections are tracked as they change");
  assert.match(
    view,
    /scrollIntoView\(\{ behavior: "smooth", block: "center" \}\)/,
    "a chosen result centers its entry",
  );
  assert.match(view, /classList\.add\("flash"\)/, "the entry flashes on arrival");
  assert.match(view, /1500/, "the flash clears after 1.5s");
});

test("TranscriptItem wiring: stable entry id + the flash class hook", () => {
  const item = src("components/TranscriptItem.vue");
  assert.match(item, /:data-entry-id="item\.id"/, "every entry carries its stable id");
  assert.match(item, /\.entry\.flash/, "the flash hook is a class on the entry");
  assert.match(item, /1\.5s/, "the flash animation lasts as long as the highlight");
});
