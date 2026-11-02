// R16 Unit A (reply-to-passage): client/quote.ts keeps the shared
// module-singleton quote state (setQuote/clear, the exact contract Unit B's
// transcript selection calls) and folds a quote into the outgoing message as
// a Markdown blockquote. Pure logic runs through vite ssrLoadModule; the
// Composer.vue wiring (strip render, Esc-clear, send path) is asserted on
// source the same way fe-escape-busy.test.ts does — the keydown/paste
// handlers only run in a real browser.
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

test("quote state: module singleton — setQuote/clear visible to every useReplyQuote() caller", async () => {
  const { useReplyQuote } = await vite.ssrLoadModule("/src/client/quote.ts");
  const composer = useReplyQuote();
  const transcript = useReplyQuote(); // Unit B's instance
  assert.equal(composer.quoted, null, "no quote initially");
  composer.setQuote("shared passage", "Pi · #4");
  assert.equal(transcript.quoted?.text, "shared passage", "Unit B sees the strip's quote");
  assert.equal(transcript.quoted?.srcLabel, "Pi · #4");
  composer.clear();
  assert.equal(transcript.quoted, null, "clear() clears it for every caller");
});

test("setQuote caps the stored passage at 1500 chars, cut at a word boundary", async () => {
  const quote = await vite.ssrLoadModule("/src/client/quote.ts");
  assert.equal(quote.QUOTE_MAX, 1500);
  const words = Array.from({ length: 400 }, (_, i) => `word${i}`).join(" ");
  quote.useReplyQuote().setQuote(words, "Pi");
  const stored = quote.useReplyQuote().quoted!;
  assert.ok(stored.text.length <= 1500, "stored quote fits the cap (ellipsis included)");
  assert.ok(stored.text.endsWith("…"), "oversized quotes end with an ellipsis");
  const head = stored.text.slice(0, -1);
  assert.ok(!head.endsWith(" "), "the cut lands on a word boundary, not whitespace");
  assert.ok(words.startsWith(head), "the stored text is a prefix of the original");
  // at or under the cap: verbatim, no ellipsis
  quote.useReplyQuote().setQuote("short and sweet", "Pi");
  assert.equal(quote.useReplyQuote().quoted?.text, "short and sweet");
  // blank quotes are refused, not stored as an empty strip
  quote.useReplyQuote().setQuote("   ", "Pi");
  assert.equal(quote.useReplyQuote().quoted, null);
});

test("quote fold: blockquote lines + attribution + blank line before the user text", async () => {
  const { useReplyQuote, buildQuotedMessage } = await vite.ssrLoadModule("/src/client/quote.ts");
  useReplyQuote().setQuote("line one\nline two\n\nafter a gap", "Pi · 14:02");
  const quoted = useReplyQuote().quoted!;
  assert.equal(
    buildQuotedMessage(quoted, "why this part?"),
    "> line one\n> line two\n>\n> after a gap\n> — Pi · 14:02\n\nwhy this part?",
    "every line prefixed '> ', empty line becomes '>', attribution last, blank line, then reply",
  );
  // after a clear, sending no longer folds anything in
  useReplyQuote().clear();
  assert.equal(useReplyQuote().quoted, null, "cleared — the next send goes out without a blockquote");
});

test("hostile quote: label normalized, excerpt one-lined and control-free before render", async () => {
  const { useReplyQuote } = await vite.ssrLoadModule("/src/client/quote.ts");
  const { oneLineExcerpt } = await vite.ssrLoadModule("/src/client/paste.ts");
  const hostile = ">quoted\n<script>alert(1)</script>\n\x1b[31mred\x07bell\u2028sep";
  useReplyQuote().setQuote(hostile, "Pi \n · \x1boops");
  const quoted = useReplyQuote().quoted!;
  // the label is flattened at set time — no LF/ESC can reach the strip markup
  assert.equal(quoted.srcLabel, "Pi · oops");
  // the strip excerpt flattens to one line with control characters gone
  const strip = oneLineExcerpt(quoted.text, 120);
  assert.ok(!strip.includes("\n"), "excerpt is a single line");
  assert.ok(!/[\u0000-\u001f\u007f\u2028\u2029]/.test(strip), "no control characters survive");
  assert.ok(strip.includes("<script>"), "markup stays as text — the template escapes on render");
  assert.ok(strip.length <= 120, "excerpt fits the 120-char strip cap");
});

test("Composer.vue wires the reply strip, its Esc-clear, and the send path", () => {
  const c = src("components/Composer.vue");
  // strip: sanitized one-line label + ≤120-char excerpt + always-visible clear (44px target)
  assert.match(c, /useReplyQuote\(\)/, "composer consumes the shared quote state");
  assert.match(c, /class="reply-strip"/, "the strip renders above the textarea");
  assert.match(c, /oneLineExcerpt\(replyQuote\.quoted\?\.text \?\? "", 120\)/, "excerpt is one-lined and capped");
  assert.match(c, /aria-label="Clear quoted reply"/, "the × button is labelled");
  assert.match(c, /min-width: 2\.75rem;\s*min-height: 2\.75rem;/, "clear button keeps a 44px touch target");
  const strip = c.slice(c.indexOf('class="reply-strip"'), c.indexOf("slash-menu"));
  assert.ok(!strip.includes("v-html"), "the strip renders text interpolation only");
  // Esc inside the composer clears ONLY the strip (slash menu closed case)
  assert.match(
    c,
    /e\.key === "Escape" && replyQuote\.quoted[\s\S]{0,120}replyQuote\.clear\(\)/,
    "Escape with the strip open clears the strip, and stops propagation",
  );
  assert.match(c, /e\.stopPropagation\(\);/, "the Esc-clear does not reach document Esc listeners");
  // send: unfold pastes first, then fold the quote (never for slash commands), clear on success
  const send = c.slice(c.indexOf("async function send"), c.indexOf("function withdraw"));
  assert.ok(send.includes("expandPastes(ui.composer, pastes)"), "pastes unfold before anything else");
  assert.ok(
    send.indexOf("expandPastes(") < send.indexOf("buildQuotedMessage("),
    "unfold happens before the quote folds in",
  );
  assert.ok(send.indexOf("buildQuotedMessage(") < send.indexOf("handle.send("), "quote folded in before send");
  assert.match(
    c,
    /userText\.startsWith\("\/"\) \|\| !quoted/,
    "slash commands go out verbatim — never prefixed with a blockquote",
  );
  assert.match(
    c,
    /ui\.composer = "";\s*\n\s*replyQuote\.clear\(\);/,
    "the quote clears only after a successful send",
  );
});
