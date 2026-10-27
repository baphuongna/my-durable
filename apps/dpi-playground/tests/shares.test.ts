/**
 * Conversation shares (Wave 3): the token is the capability, every share
 * expires, and the public renderer never lets markdown become HTML.
 */
import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, readFile, readdir, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Shares, defaultSharesIo, renderShareNotFound, renderSharePage } from "../apps/dpi-playground-hub/src/shares.js";

/** A clock the tests walk by hand. */
function clockIo(start = 1_000_000_000_000) {
  let now = start;
  const io = { ...defaultSharesIo(), now: () => now };
  return { io, tick: (ms: number) => (now += ms) };
}

const agents = [{ name: "main", markdown: "# hello\n\nworld" }];

test("create → get round-trips; files are owner-only", async () => {
  const dir = await mkdtemp(join(tmpdir(), "shares-"));
  try {
    const { io } = clockIo();
    const shares = await Shares.open(dir, { io });
    const meta = await shares.create({ title: "Git demo session", agents });
    assert.match(meta.token, /^[A-Za-z0-9_-]{24}$/);
    const doc = await shares.get(meta.token);
    assert.equal(doc?.meta.title, "Git demo session");
    assert.deepEqual(doc?.agents, agents);
    const mode = (await stat(join(dir, meta.token, "page.json"))).mode & 0o777;
    assert.equal(mode, 0o600);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("an expired share is gone on read and swept on create/list", async () => {
  const dir = await mkdtemp(join(tmpdir(), "shares-"));
  try {
    const { io, tick } = clockIo();
    const shares = await Shares.open(dir, { io, ttlDays: 1 });
    const meta = await shares.create({ title: "short-lived", agents });
    tick(24 * 3600_000 + 1);
    assert.equal(await shares.get(meta.token), undefined, "expired must read as gone");
    assert.equal((await shares.list()).length, 0, "expired must not be listed");
    assert.equal((await readdir(dir)).includes(meta.token), false, "sweep must delete the dir");
    assert.equal(await shares.remove(meta.token), false, "double removal is not an error");
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("input limits are enforced before anything is written", async () => {
  const dir = await mkdtemp(join(tmpdir(), "shares-"));
  try {
    const shares = await Shares.open(dir, { io: clockIo().io });
    await assert.rejects(() => shares.create({ title: "  ", agents }), /title is required/);
    await assert.rejects(() => shares.create({ title: "x", agents: [] }), /at least one agent/);
    await assert.rejects(
      () => shares.create({ title: "x", agents: [{ name: "a", markdown: "y".repeat(2 * 1024 * 1024 + 1) }] }),
      /larger than/,
    );
    await assert.rejects(
      () =>
        shares.create({
          title: "x",
          agents: Array.from({ length: 21 }, (_, i) => ({ name: `a${i}`, markdown: "x" })),
        }),
      /at most 20/,
    );
    assert.equal((await readdir(dir)).length, 0, "nothing was written");
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("a junk token answers gone without touching the disk", async () => {
  const dir = await mkdtemp(join(tmpdir(), "shares-"));
  try {
    const shares = await Shares.open(dir, { io: clockIo().io });
    for (const bad of ["", "../network.sqlite", "short", "WITH SPACE", "x".repeat(40)])
      assert.equal(await shares.get(bad), undefined);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("the public page escapes markdown and carries no scripts", () => {
  const doc = {
    meta: { token: "t".repeat(24), title: "<script>alert(1)</script>", createdAt: "2026-10-25T00:00:00.000Z", expiresAt: "2026-11-01T00:00:00.000Z", bytes: 1 },
    agents: [{ name: "main", markdown: "```html\n<img src=x onerror=alert(1)>\n```" }],
  };
  const html = renderSharePage(doc);
  assert.ok(!html.includes("<script>"), "raw script tag leaked");
  assert.ok(!html.includes("<img"), "raw html leaked");
  assert.ok(html.includes("&lt;script&gt;"), "the title is not escaped");
  assert.match(html, /<style>/, "styles are inline");
  assert.ok(!html.match(/<script[^>]*src/i), "no external scripts");
  const gone = renderShareNotFound();
  assert.ok(!gone.includes("script"), "the 404 page must stay inert");
});

test("list is newest first and remove kills the link", async () => {
  const dir = await mkdtemp(join(tmpdir(), "shares-"));
  try {
    const { io, tick } = clockIo();
    const shares = await Shares.open(dir, { io });
    const a = await shares.create({ title: "first", agents });
    tick(1000);
    const b = await shares.create({ title: "second", agents });
    assert.deepEqual((await shares.list()).map((m) => m.title), ["second", "first"]);
    assert.equal(await shares.remove(b.token), true);
    assert.equal(await shares.get(b.token), undefined);
    assert.equal((await shares.get(a.token))?.meta.title, "first");
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("R5: escapeHtml strips C0/C1 controls from share text (formatting newlines survive)", () => {
  const doc = {
    meta: {
      token: "t".repeat(24),
      title: "bell\u0007and\u0001soh",
      createdAt: "2026-10-25T00:00:00.000Z",
      expiresAt: "2026-11-01T00:00:00.000Z",
      bytes: 1,
    },
    agents: [{ name: "main", markdown: "one\u0001two\u0007three\n\nfour\tfive" }],
  };
  const html = renderSharePage(doc);
  assert.ok(!html.includes("\u0001"), "SOH leaked into the page");
  assert.ok(!html.includes("\u0007"), "BEL leaked into the page");
  assert.ok(html.includes("onetwothree"), "controls stripped, text kept");
  assert.ok(html.includes("four\tfive"), "a tab is formatting, kept");
  assert.ok(html.includes("three\n\nfour"), "newlines are formatting, kept");
});
