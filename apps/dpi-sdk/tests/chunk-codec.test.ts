/**
 * P2-14 — chunk codec, reassembly, byte admission, bounded SSE reader.
 * W-2 sizes (1.100.256 B, 6 MiB, 16 MiB boundary), Unicode boundary, and the
 * invalid/metadata/ownership/overflow matrix.
 */
import test from "node:test";
import assert from "node:assert/strict";
import type { TunnelChunk } from "../src/protocol/tunnel.js";
import { randomBytes } from "node:crypto";
import {
  ByteBudget,
  ChunkReassembler,
  SseReader,
  sendChunked,
  standardBudgets,
  type ChunkCorrelation,
} from "../src/node/chunk.js";
import { LOGICAL_MESSAGE_MAX_BYTES, CHUNK_RAW_BYTES } from "../src/protocol/limits.js";

const corr = (subscriptionId = "00000000-1111-2222-3333-444444444444", sub = "tree"): ChunkCorrelation =>
  ({ kind: "tunnel-data", subscriptionId, sub });

/** Roundtrip helper: chunk then feed all chunks through a reassembler. */
function roundtrip(payload: unknown, opts?: Parameters<typeof sendChunked>[3]) {
  const budget = new ByteBudget("test", LOGICAL_MESSAGE_MAX_BYTES + (1 << 20));
  const re = new ChunkReassembler(budget);
  const chunks: any[] = [];
  const r = sendChunked(payload, corr(), (c) => chunks.push(c), opts);
  if (!r.ok) return { r };
  let final: any = { ok: true };
  for (const c of chunks) {
    const out = re.feed(c as TunnelChunk, () => true);
    if (out.done || !out.ok) final = out;
  }
  return { r, final, chunks };
}

test("W-2 roundtrips: 1.100.256 B, 6 MiB payloads byte-identical", () => {
  for (const size of [1_100_256, 6 * 1024 * 1024]) {
    const payload = { type: "x", blob: randomBytes(size).toString("base64") };
    const { r, final } = roundtrip(payload);
    assert.ok(r.ok, JSON.stringify(r));
    assert.ok(final.ok && final.done, JSON.stringify(final).slice(0, 200));
    assert.deepEqual(final.value, payload, `size ${size}`);
  }
});

test("Unicode boundary: multi-byte codepoint split across the 64 KiB chunk edge roundtrips", () => {
  // Fill so a 4-byte emoji straddles the 65_536 boundary.
  const prefix = "a".repeat(CHUNK_RAW_BYTES - 2);
  const payload = { text: prefix + "🚀🎉𠮷" + "b".repeat(1000) };
  const { r, final } = roundtrip(payload);
  assert.ok(r.ok);
  assert.ok(final.ok && final.done);
  assert.equal((final.value as { text: string }).text, payload.text);
});

test("16 MiB boundary: at cap passes, beyond cap rejected without sending", () => {
  // Just under: raw + envelope ≤ 16 MiB
  // exactly 256 chunks: raw + 256-chunk envelope estimate == cap
  const rawBudget = LOGICAL_MESSAGE_MAX_BYTES - 256 * 256 - 64;
  const okPayload = { blob: "x".repeat(rawBudget) };
  const ok = roundtrip(okPayload);
  assert.ok(ok.r.ok, JSON.stringify(ok.r));
  assert.ok(ok.final.ok && ok.final.done);
  // Over: refuse before any chunk is emitted. Raw beyond 256 chunks trips the
  // count guard; raw within 256 chunks but raw+envelope > cap trips the cap.
  const sent: unknown[] = [];
  const over = sendChunked({ blob: "x".repeat(LOGICAL_MESSAGE_MAX_BYTES + 1) }, corr(), (c) => sent.push(c));
  assert.ok(!over.ok);
  assert.match((over as { error: string }).error, /logical cap|max 256/);
  const sent2: unknown[] = [];
  const over2 = sendChunked(
    { blob: "x".repeat(LOGICAL_MESSAGE_MAX_BYTES - 256 * 256 + 128 - 64) },
    corr(),
    (c) => sent2.push(c),
  );
  assert.ok(!over2.ok, "256-chunk message whose envelope pushes past the cap must be refused");
  assert.match((over2 as { error: string }).error, /logical cap/);
  assert.equal(sent.length, 0);
  assert.equal(sent2.length, 0);
});

test("invalid chunks: bad base64, count/total mismatch, index errors, duplicate, foreign correlation", () => {
  const budget = new ByteBudget("t", LOGICAL_MESSAGE_MAX_BYTES);
  const re = new ChunkReassembler(budget);
  // mathematically consistent single-chunk message: 4 raw bytes, count=1
  const make = (over: Record<string, unknown> = {}, index = 0): any => ({
    type: "tunnel-chunk", v: 1, messageId: "00000000-1111-2222-3333-444444444444", index,
    count: 1, totalBytes: 4, data: Buffer.from("aaaa").toString("base64"), kind: "tunnel-data",
    subscriptionId: "00000000-1111-2222-3333-444444444444", sub: "tree", ...over,
  });
  // foreign correlation with a VALID chunk: owns=false → rejected, ZERO allocation
  let allocated = 0;
  const budget2 = new ByteBudget("t2", 1024);
  const orig = budget2.reserve.bind(budget2);
  budget2.reserve = (n: number) => (allocated++, orig(n));
  const re2 = new ChunkReassembler(budget2);
  const foreign = re2.feed(make() as TunnelChunk, () => false);
  assert.ok(!foreign.ok);
  assert.match(foreign.error!, /no live reader/);
  assert.equal(allocated, 0, "ownership gate must run BEFORE allocation");
  // envelope math errors
  assert.match(re.feed(make({ count: 5 }) as TunnelChunk, () => true).error!, /count\/totalBytes/);
  assert.match(re.feed(make({ index: 1 }) as TunnelChunk, () => true).error!, /index out of range/);
  assert.match(re.feed(make({ data: "!!!!" }) as TunnelChunk, () => true).error!, /base64/);
  assert.match(re.feed(make({ data: Buffer.from("aa").toString("base64") }) as TunnelChunk, () => true).error!, /size mismatch/);
});

test("ordering + immutable metadata: duplicate/skip/mutation fail the assembly and release budget", () => {
  const budget = new ByteBudget("t", LOGICAL_MESSAGE_MAX_BYTES);
  const re = new ChunkReassembler(budget);
  const TOTAL = 2 * 65536 + 4;
  const full = Buffer.from("a".repeat(65536)).toString("base64");
  const tail = Buffer.from("bbbb").toString("base64");
  const base = {
    type: "tunnel-chunk", v: 1, messageId: "00000000-1111-2222-3333-444444444444",
    count: 3, totalBytes: TOTAL, kind: "tunnel-data" as const,
    subscriptionId: "00000000-1111-2222-3333-444444444444", sub: "tree",
  };
  const c = (data: string, index: number, over: Partial<typeof base> = {}) =>
    ({ ...base, data, index, ...over }) as TunnelChunk;
  assert.ok(re.feed(c(full, 0), () => true).ok);
  // duplicate index 0
  assert.match(re.feed(c(full, 0), () => true).error!, /expected index 1/);
  assert.equal(budget.used, 0, "failed assembly released its reservation");
  // skip: 0 then 2
  assert.ok(re.feed(c(full, 0), () => true).ok);
  assert.match(re.feed(c(tail, 2), () => true).error!, /expected index 1/);
  // metadata mutation mid-assembly
  assert.ok(re.feed(c(full, 0), () => true).ok);
  assert.match(
    re.feed(c(full, 1, { count: 4, totalBytes: TOTAL + 65536 }), () => true).error!,
    /metadata changed/,
  );
  assert.equal(budget.used, 0);
});

test("full-envelope correlation after decode: same key, different sub is a foreign assembly", () => {
  const budget = new ByteBudget("t", 1024 * 1024);
  const re = new ChunkReassembler(budget);
  const payload = "hello world this fits one chunk";
  const chunks: any[] = [];
  assert.ok(sendChunked({ m: payload }, corr("00000000-1111-2222-3333-444444444444", "tree"), (c) => chunks.push(c)).ok);
  // receiver expects sub "session" — ownership gate rejects before allocation
  const out = re.feed(chunks[0] as TunnelChunk, (c) => c.kind === "tunnel-data" && c.sub === "session");
  assert.ok(!out.ok);
  assert.match(out.error!, /no live reader/);
  assert.equal(budget.used, 0);
});

test("concurrency ≤4/connection; 5th rejected without touching existing assemblies", () => {
  const budget = new ByteBudget("t", LOGICAL_MESSAGE_MAX_BYTES);
  const re = new ChunkReassembler(budget);
  const mk = (uuid: string): any[] => {
    const chunks: any[] = [];
    sendChunked({ a: "x".repeat(200_000) }, { kind: "tunnel-data", subscriptionId: uuid, sub: "tree" }, (c) => chunks.push(c));
    return chunks;
  };
  const first: any[][] = [];
  for (let i = 0; i < 4; i++) {
    const cs = mk(`${i}0000000-1111-2222-3333-444444444444`.slice(0, 36));
    first.push(cs);
    assert.ok(re.feed(cs[0] as TunnelChunk, () => true).ok);
  }
  assert.equal(re.active, 4);
  const fifth = mk(`50000000-1111-2222-3333-444444444444`);
  const out = re.feed(fifth[0] as TunnelChunk, () => true);
  assert.ok(!out.ok);
  assert.match(out.error!, /assemblies in flight/);
  assert.equal(re.active, 4, "rejection must not disturb live assemblies");
  // completing one frees a slot
  for (let k = 1; k < first[0].length; k++) {
    const out = re.feed(first[0][k] as TunnelChunk, () => true);
    assert.ok(out.ok);
    if (k === first[0].length - 1) assert.ok(out.done);
  }
  assert.ok(re.feed(fifth[0] as TunnelChunk, () => true).ok);
});

test("timeout: stuck assembly is evicted and budget released exactly once", async () => {
  const budget = new ByteBudget("t", 1024 * 1024);
  const re = new ChunkReassembler(budget, { timeoutMs: 30 });
  const chunks: any[] = [];
  assert.ok(sendChunked({ b: "x".repeat(130_000) }, corr(), (c) => chunks.push(c)).ok);
  assert.ok(re.feed(chunks[0] as TunnelChunk, () => true).ok);
  assert.ok(budget.used > 0);
  await new Promise((r) => setTimeout(r, 60));
  assert.equal(re.active, 0);
  assert.equal(budget.used, 0);
  // late chunk for the timed-out assembly: fresh start, index must be 0
  const late = re.feed(chunks[1] as TunnelChunk, () => true);
  assert.match(late.error!, /index 0/);
});

test("byte admission: connection 32 MiB / hub 64 MiB aggregate; release restores; double-release safe", () => {
  const { connection, hub } = standardBudgets();
  const c1 = connection.reserve(30 * 1024 * 1024);
  assert.ok(c1);
  assert.equal(connection.reserve(3 * 1024 * 1024), null, "connection budget exhausted");
  const h1 = hub.reserve(64 * 1024 * 1024); // exactly full
  assert.ok(h1);
  assert.equal(hub.reserve(1), null, "hub budget exhausted at capacity");
  c1!.release();
  c1!.release(); // double release: no-op
  assert.equal(connection.used, 0);
  assert.ok(connection.reserve(3 * 1024 * 1024));
  h1!.release();
  assert.equal(hub.used, 0);
});

test("GA-04: a child budget draws from its parent; refusal at either level reserves nothing; release returns both", () => {
  const hub = new ByteBudget("hub", 100);
  const a = new ByteBudget("connection", 60, hub);
  const b = new ByteBudget("connection", 60, hub);
  const a1 = a.reserve(60);
  assert.ok(a1);
  assert.equal(a.reserve(1), null, "child cap reached");
  assert.equal(hub.used, 60);
  const b1 = b.reserve(40);
  assert.ok(b1);
  assert.equal(hub.used, 100);
  assert.equal(b.reserve(1), null, "parent cap reached although the child has room");
  assert.equal(b.used, 40, "a parent refusal leaves the child untouched");
  a1!.release();
  a1!.release(); // double release must not over-credit the parent
  assert.equal(a.used, 0);
  assert.equal(hub.used, 40);
  assert.ok(b.reserve(20), "parent room freed by the other child is usable");
  b1!.release();
  assert.equal(hub.used, 20);
});

test("abort/abortAll release reservations; SseReader admits bytes before parse, handles Unicode + heartbeat comments", () => {
  const budget = new ByteBudget("t", 1024 * 1024);
  const re = new ChunkReassembler(budget);
  const chunks: any[] = [];
  sendChunked({ c: "y".repeat(130_000) }, corr(), (c) => chunks.push(c));
  assert.ok(re.feed(chunks[0] as TunnelChunk, () => true).ok);
  assert.ok(budget.used > 0);
  assert.equal(re.abort(corr()), true);
  assert.equal(budget.used, 0);
  assert.equal(re.abort(corr()), false);

  const sse = new SseReader(new ByteBudget("sse", 1024 * 1024));
  const r1 = sse.feed(`: ping\n\nevent: tree\nid: 42\ndata: {"n":"🚀"}\n\n`);
  assert.equal(r1.error, null);
  assert.equal(r1.events.length, 1);
  assert.equal(r1.events[0].event, "tree");
  assert.equal(r1.events[0].id, "42");
  assert.equal(r1.events[0].data, '{"n":"🚀"}');
  // split across feeds: framing survives partial buffers
  const r2a = sse.feed(Buffer.from("event: doc\n", "utf8"));
  const r2b = sse.feed(Buffer.from('data: {"z":"🎉"}\n\n', "utf8"));
  assert.equal(r2a.events.length, 0);
  assert.equal(r2b.events.length, 1);
  assert.equal(r2b.events[0].data, '{"z":"🎉"}');
  // oversized event rejected as BYTES before framing (admission first)
  const small = new SseReader(new ByteBudget("sse", 1024 * 1024), 64);
  const r3 = small.feed("data: " + "a".repeat(100));
  assert.match(r3.error!, /exceeds/);
  assert.equal(r3.events.length, 0);
});

test("overhead recorded separately: raw bytes and envelope overhead are distinct metrics", () => {
  const sent: any[] = [];
  const r = sendChunked({ pad: "x".repeat(200_000) }, corr(), (c) => sent.push(c));
  assert.ok(r.ok);
  const raw = (r as { rawBytes: number }).rawBytes;
  const overhead = (r as { overheadBytes: number }).overheadBytes;
  assert.ok(raw > 200_000);
  assert.equal(overhead, sent.length * 256);
  assert.ok(overhead < raw, "parser/string overhead tracked apart from payload bytes");
});

test("chunk budget rejection: assembly larger than budget → no allocation, clean error", () => {
  const small = new ByteBudget("tiny", 1024);
  const re = new ChunkReassembler(small);
  const chunks: any[] = [];
  sendChunked({ big: "z".repeat(50_000) }, corr(), (c) => chunks.push(c));
  const out = re.feed(chunks[0] as TunnelChunk, () => true);
  assert.ok(!out.ok);
  assert.match(out.error!, /cannot admit/);
  assert.equal(small.used, 0);
});
