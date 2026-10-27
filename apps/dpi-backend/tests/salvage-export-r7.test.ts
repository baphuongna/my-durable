// R7 resilience-lane fixes, driven against the real Store + storage stack:
//   1 (HIGH) a session db with a corrupt header (the R5 audit recipe: 0x41 over
//            bytes 32-64) is salvaged ON OPEN — a copy is patched, integrity-checked,
//            promoted atomically; the original is kept aside, never modified.
//   2        when the salvage cannot recover (body corruption too), the original is
//            byte-identical and every failure surface says a salvage was attempted
//            and failed — not a bare "unavailable".
//   3        the salvage is time-bounded: a ceiling of 0ms abandons the attempt (worker
//            terminated, copies cleaned, original untouched); the shipped ceiling is 5s.
//   4        export refuses over 32 MiB of raw transcript text with a 4xx-style message
//            naming the size and suggesting compaction, instead of buffering the bundle.
import { test } from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readdir } from "node:fs/promises";
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { openNodeSqliteStorage } from "@earendil-works/pi-durable/storage/sqlite/node";
import { BACKGROUND_CONTEXT as ctx } from "@earendil-works/chord/context";
import type { EntryId } from "@earendil-works/pi-durable";
import { Store } from "../src/store.js";
import { ApiFault } from "../src/errors.js";
import { EXPORT_RAW_LIMIT_BYTES } from "../src/zip.js";
import { SALVAGE_CEILING_MS, salvageSessionDb } from "../src/salvage.js";
import { faux, tempStore, until } from "./helpers.js";

const sha256 = (path: string) => createHash("sha256").update(readFileSync(path)).digest("hex");

/** The R5 audit's proven fixture: write a session, close cleanly (the WAL folds into the main file), corrupt, reopen. */
async function corruptFixture(name: string, extra: (buf: Buffer) => void = () => {}) {
  const t = await tempStore();
  const store = await Store.open({ dataDir: join(t.root, "data"), startDirs: [t.work], name, provider: "faux" });
  await store.create({ name: "salvage-me", cwd: t.work, model: faux });
  const row = store.resolveSession("salvage-me");
  const { c } = await store.resolveAgent("salvage-me", "main");
  await store.send(c, { content: `hello ${name}`, requestId: `${name}-1` });
  await until(async () => ((await store.transcript(c, "json")).items as unknown[]).length >= 2, 20000, "the faux echo to land");
  await store.close();
  // Garbage over header bytes 32-64 (the audit recipe) + optional extra body damage.
  const buf = readFileSync(row.dbPath);
  for (let i = 32; i < 64; i++) buf[i] = 0x41;
  extra(buf);
  writeFileSync(row.dbPath, buf);
  return { t, row };
}

test("a corrupt session header is salvaged on open: copy patched, integrity-gated, promoted, original kept", async () => {
  const { t, row } = await corruptFixture("r7-recover");
  try {
    const before = sha256(row.dbPath);
    const store = await Store.open({ dataDir: join(t.root, "data"), startDirs: [t.work], name: "r7-recover", provider: "faux" });
    try {
      // The open that used to fail forever now recovers through the salvage path.
      const { c } = await store.resolveAgent("salvage-me", "main");
      const items = (await store.transcript(c, "json")).items as unknown[];
      assert.ok(
        items.some((i) => JSON.stringify(i).includes("hello r7-recover")),
        `the recovered transcript still carries the message (${items.length} items)`,
      );
      assert.equal(store.errors.get(row.id), undefined, "no failure note after a recovered salvage");
      // The corrupt original is KEPT aside (house quarantine rule), copies are cleaned.
      const names = await readdir(join(row.dbPath, ".."));
      const kept = names.find((n) => n.startsWith("agent.sqlite.corrupt-"))!;
      assert.ok(kept, `the original was quarantined aside, saw: ${names.join(", ")}`);
      assert.equal(sha256(join(row.dbPath, "..", kept)), before, "the kept original is byte-identical to the corrupt file");
      assert.ok(!names.some((n) => n.includes(".salvage")), `no salvage copies left behind, saw: ${names.join(", ")}`);
    } finally {
      await store.close();
    }
  } finally {
    await t.cleanup();
  }
});

test("a salvage that cannot recover leaves the original byte-identical and says a salvage was attempted", async () => {
  // Header garbage AND body garbage: the header patch cannot make integrity_check pass.
  const { t, row } = await corruptFixture("r7-fail", (buf) => {
    for (let i = 5000; i < 20000; i++) buf[i] = 0x41;
  });
  try {
    const before = sha256(row.dbPath);
    const store = await Store.open({ dataDir: join(t.root, "data"), startDirs: [t.work], name: "r7-fail", provider: "faux" });
    try {
      await assert.rejects(
        () => store.resolveAgent("salvage-me", "main"),
        (e: unknown) =>
          e instanceof ApiFault &&
          e.code === "unavailable" &&
          /salvage copy was attempted/i.test(e.message) &&
          /original file is untouched/i.test(e.message),
        `the fault explains the failed salvage, got: ${store.errors.get(row.id)}`,
      );
      // The row-level note rides the session summary (the existing list surface).
      const summary = await store.sessionSummary(store.resolveSession("salvage-me"));
      assert.match(String(summary.error ?? ""), /salvage copy was attempted/, "the summary carries why");
      // Original untouched: byte-identical, no quarantine, no leftover copies.
      assert.equal(sha256(row.dbPath), before, "the original is byte-identical after the failed salvage");
      const names = await readdir(join(row.dbPath, ".."));
      assert.ok(!names.some((n) => n.includes(".salvage") || n.includes(".corrupt-")), `no leftover files, saw: ${names.join(", ")}`);
    } finally {
      await store.close();
    }
  } finally {
    await t.cleanup();
  }
});

test("salvage is time-bounded: a zero ceiling abandons the attempt, cleans up, and never touches the original", async () => {
  const { t, row } = await corruptFixture("r7-bound");
  try {
    const before = sha256(row.dbPath);
    const outcome = await salvageSessionDb(row.dbPath, 0); // the seam: the ceiling is a parameter
    assert.equal(SALVAGE_CEILING_MS, 5000, "the shipped ceiling is the agreed 5s");
    assert.ok(outcome.attempted, "the attempt was made");
    assert.equal(outcome.recovered, false, "a 0ms ceiling cannot recover");
    assert.match(String(outcome.reason), /timed out/i, `the reason names the bound, got: ${outcome.reason}`);
    assert.equal(sha256(row.dbPath), before, "the original is untouched by an abandoned salvage");
    const names = await readdir(join(row.dbPath, ".."));
    assert.ok(!names.some((n) => n.includes(".salvage")), `abandoned copies were cleaned, saw: ${names.join(", ")}`);
  } finally {
    await t.cleanup();
  }
});

test("export refuses over the raw limit with a compactable message; under it, the bundle builds", async () => {
  const t = await tempStore();
  const store = await Store.open({ dataDir: join(t.root, "data"), startDirs: [t.work], name: "r7-export", provider: "faux" });
  try {
    await store.create({ name: "big", cwd: t.work, model: faux });
    const big = store.resolveSession("big");
    const { c } = await store.resolveAgent("big", "main");
    await store.send(c, { content: "seed", requestId: "exp-1" });
    // Synthesize the over-limit transcript through the same storage export reads
    // from (store.send caps content at 100k chars, and the faux model streams at
    // 400 tok/s — neither can produce 32 MiB in test time): a second connection
    // commits entry records the harness's view picks up like any turn's.
    const st = await openNodeSqliteStorage(big.dbPath);
    const half = "x".repeat(Math.ceil(EXPORT_RAW_LIMIT_BYTES / 2) + 1024 * 1024);
    for (let i = 0; i < 2; i++)
      await st.commit(
        [
          {
            type: "entry" as const,
            value: {
              id: await st.mintId<EntryId>(),
              conversationId: c.id,
              kind: "pi.user",
              model: [{ role: "user", content: half, timestamp: Date.now() }],
            },
          },
        ],
        ctx,
      );
    await st.close(ctx);
    await assert.rejects(
      () => store.exportSession(big),
      (e: unknown) =>
        e instanceof ApiFault &&
        e.code === "invalid" &&
        /Export refused/.test(e.message) &&
        /over the 32\.0 MiB/.test(e.message) &&
        /Compact the session first/.test(e.message),
      "the refusal names the size and the remedy",
    );

    // Under the threshold: current behavior — a real zip bundle comes back.
    await store.create({ name: "small", cwd: t.work, model: faux });
    const small = store.resolveSession("small");
    const { c: smallTalk } = await store.resolveAgent("small", "main");
    await store.send(smallTalk, { content: "tiny", requestId: "exp-2" });
    await until(async () => ((await store.transcript(smallTalk, "json")).items as unknown[]).length >= 2, 20000, "the echo to land");
    const bundle = await store.exportSession(small);
    assert.match(bundle.filename, /\.bundle\.zip$/);
    assert.ok(bundle.bytes > 0 && bundle.base64.length > 0);
    const zip = Buffer.from(bundle.base64, "base64");
    assert.equal(zip.readUInt32LE(0) & 0xffff, 0x4b50, "the payload is a zip (PK magic)");
  } finally {
    await store.close();
    await t.cleanup();
  }
});
