// R16 Unit A (long pastes): client/paste.ts folds a >20-line paste into a
// short placeholder token and expands it back, verbatim and in place, only
// for tokens this store actually issued. Pure logic via vite ssrLoadModule;
// the Composer.vue paste interception is asserted on source like
// fe-escape-busy.test.ts does.
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

const lines = (n: number) => Array.from({ length: n }, (_, i) => `line ${i + 1}`).join("\n");

test("boundary: 20 lines paste verbatim, 21 lines fold (CRLF counts once)", async () => {
  const { shouldFoldPaste, lineCount, PASTE_LINE_LIMIT } = await vite.ssrLoadModule(
    "/src/client/paste.ts",
  );
  assert.equal(PASTE_LINE_LIMIT, 20);
  assert.equal(lineCount(lines(20)), 20);
  assert.equal(shouldFoldPaste(lines(20)), false, "exactly 20 lines is not folded");
  assert.equal(shouldFoldPaste(lines(21)), true, "21 lines folds");
  assert.equal(shouldFoldPaste(""), false, "an empty paste never folds");
  assert.equal(lineCount("a\r\nb\r\nc"), 3, "CRLF breaks count as single newlines");
  assert.equal(shouldFoldPaste("a\r\nb"), false);
});

test("two pastes get sequential ids #1, #2 with their own line counts", async () => {
  const { createPasteStore, addPaste, pasteToken } = await vite.ssrLoadModule("/src/client/paste.ts");
  const store = createPasteStore();
  assert.equal(addPaste(store, lines(5)), "[Pasted text #1 · 5 lines]");
  assert.equal(addPaste(store, "y\ny"), "[Pasted text #2 · 2 lines]", "ids are sequential per store");
  assert.equal(pasteToken(3, 7), "[Pasted text #3 · 7 lines]", "token format is stable");
});

test("insertPlaceholder drops the token at the caret, replacing the selection", async () => {
  const { createPasteStore, addPaste, insertPlaceholder } = await vite.ssrLoadModule(
    "/src/client/paste.ts",
  );
  const store = createPasteStore();
  const token = addPaste(store, lines(30));
  // composer "before sel after", selection covers "sel" (7..10)
  const replaced = insertPlaceholder("before sel after", token, 7, 10);
  assert.equal(replaced.text, `before ${token} after`);
  assert.equal(replaced.caret, 7 + token.length, "caret lands just past the token");
  // no selection: plain insertion at the caret
  const atEnd = insertPlaceholder("tail", token, 4);
  assert.equal(atEnd.text, `tail${token}`);
  // clamped out-of-range selections cannot throw or duplicate text
  const clamped = insertPlaceholder("abc", token, 99, -1);
  assert.equal(clamped.text, `abc${token}`);
});

test("send expansion puts the full text back exactly where the placeholder sits", async () => {
  const { createPasteStore, addPaste, expandPastes, hasPasteTokens } = await vite.ssrLoadModule(
    "/src/client/paste.ts",
  );
  const store = createPasteStore();
  const body = lines(25);
  const token = addPaste(store, body);
  const composed = `look at this:\n${token}\nthanks`;
  assert.equal(expandPastes(composed, store), `look at this:\n${body}\nthanks`, "in place, verbatim");
  assert.ok(hasPasteTokens(composed));
  assert.ok(!hasPasteTokens(expandPastes(composed, store)), "nothing left to expand");
  // two pastes in one message expand independently
  const second = addPaste(store, "p2\np2");
  const two = expandPastes(`${token} and ${second}`, store);
  assert.equal(two, `${body} and p2\np2`);
  // text with no tokens is returned untouched
  assert.equal(expandPastes("plain message", store), "plain message");
});

test("a hand-typed lookalike token is never expanded", async () => {
  const { createPasteStore, addPaste, expandPastes } = await vite.ssrLoadModule(
    "/src/client/paste.ts",
  );
  const literal = "[Pasted text #1 · 5 lines]";
  // nothing issued at all
  assert.equal(
    expandPastes(`I typed ${literal} myself`, createPasteStore()),
    `I typed ${literal} myself`,
    "a fresh store replaces nothing",
  );
  // id issued but the line count in the typed token does not match
  const mismatch = createPasteStore();
  addPaste(mismatch, "only\none"); // id 1, 2 lines
  assert.equal(expandPastes(literal, mismatch), literal, "wrong line count stays literal");
  // id never issued
  const gap = createPasteStore();
  addPaste(gap, lines(9)); // id 1
  assert.equal(
    expandPastes("[Pasted text #2 · 9 lines]", gap),
    "[Pasted text #2 · 9 lines]",
    "an id this store never issued stays literal",
  );
  // while a genuinely issued token elsewhere in the same message expands
  const real = addPaste(gap, lines(4)); // id 2 · 4 lines
  assert.equal(
    expandPastes(`[Pasted text #3 · 9 lines] then ${real}`, gap),
    `[Pasted text #3 · 9 lines] then ${lines(4)}`,
  );
});

test("oneLineExcerpt flattens, strips control characters, and caps on word boundary", async () => {
  const { oneLineExcerpt } = await vite.ssrLoadModule("/src/client/paste.ts");
  assert.equal(oneLineExcerpt("  a\n\nb \t c ", 120), "a b c");
  const noisy = "log\x1b[31m line\n\u0007bell\u2028end\u200b";
  const flat = oneLineExcerpt(noisy, 120);
  assert.ok(!/[\u0000-\u001f\u007f\u2028\u2029\u200b]/.test(flat), "control/zero-width runes gone");
  assert.ok(!flat.includes("\n"), "single line");
  const capped = oneLineExcerpt("word ".repeat(40), 20);
  assert.ok(capped.length <= 20, "cap includes the ellipsis");
  assert.ok(capped.endsWith("…"));
  assert.ok(!capped.slice(0, -1).endsWith(" "), "cut at a word boundary");
});

test("Composer.vue intercepts the textarea paste for >20-line pastes", () => {
  const c = src("components/Composer.vue");
  assert.match(c, /@paste="onPaste"/, "the textarea listens for paste");
  assert.match(c, /function onPaste\(e: ClipboardEvent\)/);
  assert.match(c, /shouldFoldPaste\(text\)/, "fold decision comes from the pure helper");
  assert.match(
    c,
    /if \(!shouldFoldPaste\(text\)\) return;\s*\n\s*e\.preventDefault\(\);/,
    "short pastes fall through untouched; long ones are intercepted",
  );
  assert.match(c, /addPaste\(pastes, text\)/, "the full text is stored");
  assert.match(c, /insertPlaceholder\(/, "only the token enters the composer");
});
