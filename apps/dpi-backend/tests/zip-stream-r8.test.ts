// R8 zip-stream lane: the export route streams the bundle through a temp file
// (deflate piped to disk) instead of buffering raw texts + zip + base64 in RAM.
// Covers: entry-for-entry parity with the legacy `Store.exportSession` bundle,
// the closed-session README shape, the 256 MiB streaming ceiling (same
// invalid-fault style, size named, temp file cleaned up), the zip64-less
// refusal, incremental CRC correctness, and the route's streamed HTTP shape.
import test from "node:test";
import assert from "node:assert/strict";
import express from "express";
import { createServer } from "node:http";
import { readdir, readFile, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Store, type SessionRow } from "../src/store.js";
import { bearerAuth } from "../src/auth.js";
import { ApiFault, errorMiddleware } from "../src/errors.js";
import { v1 } from "../src/routes.js";
import { readZipEntries } from "../src/backup.js";
import { Crc32, EXPORT_TOTAL_LIMIT_BYTES, ZIP_MAX_ENTRIES, ZIP_U32_MAX, crc32, streamSessionBundle, zip64Problem } from "../src/zip.js";
import { faux, newToken, tempStore, until } from "./helpers.js";

/** The leftovers tell the truth: every path through a streamed export must
 *  leave no temp archive behind — success cleans up in the caller's finally,
 *  every refusal in the writer's own catch. Snapshot-and-diff: the OS temp dir
 *  is shared, so only NEW dpi-export files count against this test. */
async function exportSnapshot(): Promise<string[]> {
  return (await readdir(tmpdir())).filter((n) => n.startsWith("dpi-export-"));
}

async function assertNoNewExports(before: string[], message: string) {
  const fresh = (await exportSnapshot()).filter((n) => !before.includes(n));
  assert.deepEqual(fresh, [], message);
}

/** A session with a real faux transcript, the R7 fixture's open-and-send recipe. */
async function sessionWithTranscript(name: string) {
  const t = await tempStore();
  const store = await Store.open({ ...t.options, name });
  await store.create({ name, cwd: t.work, model: faux });
  const row = store.resolveSession(name);
  const { c } = await store.resolveAgent(name, "main");
  await store.send(c, { content: `hello ${name}`, requestId: `${name}-1` });
  await until(async () => ((await store.transcript(c, "json")).items as unknown[]).length >= 2, 20000, "the faux echo to land");
  return { t, store, row };
}

test("streamed export matches the legacy bundle entry-for-entry", async () => {
  const { t, store, row } = await sessionWithTranscript("r8-parity");
  try {
    const before = await exportSnapshot();
    // The same session through both paths, no mutations in between.
    const legacy = await store.exportSession(row);
    const legacyEntries = readZipEntries(Buffer.from(legacy.base64, "base64"));
    const bundle = await streamSessionBundle(store, row);
    try {
      assert.equal(bundle.filename, legacy.filename, "the download name is unchanged");
      assert.equal(bundle.mime, legacy.mime, "the mime is unchanged");
      const zip = await readFile(bundle.path);
      assert.equal(zip.readUInt32LE(0) & 0xffff, 0x4b50, "the payload is a zip (PK magic)");
      assert.equal(bundle.bytes, zip.length, "the advertised length is the archive on disk");

      const streamed = readZipEntries(zip);
      assert.deepEqual(
        streamed.map((e) => e.name).sort(),
        legacyEntries.map((e) => e.name).sort(),
        "identical entry layout: manifest, record, per-agent transcript/config",
      );
      // Every entry matches the legacy bytes, except the manifest whose only
      // legitimate difference is exportedAt (two `new Date()`s a beat apart).
      const bytesOf = (entries: { name: string; data: Uint8Array }[]) =>
        Object.fromEntries(
          entries
            .filter((e) => e.name !== "manifest.json")
            .map((e) => [e.name, Buffer.from(e.data).toString("utf8")]),
        );
      assert.deepEqual(bytesOf(streamed), bytesOf(legacyEntries), "every non-manifest entry's bytes match the legacy bundle");
      const strip = (text: string) => {
        const { exportedAt, ...rest } = JSON.parse(text) as { exportedAt: string };
        return rest;
      };
      assert.deepEqual(
        strip(Buffer.from(streamed.find((e) => e.name === "manifest.json")!.data).toString("utf8")),
        strip(Buffer.from(legacyEntries.find((e) => e.name === "manifest.json")!.data).toString("utf8")),
        "the manifest shape is unchanged (modulo the export timestamp)",
      );
    } finally {
      await bundle.cleanup();
    }
    await assert.rejects(() => stat(bundle.path), /ENOENT/, "cleanup unlinks the temp archive");
    await assertNoNewExports(before, "no temp exports left behind");
  } finally {
    await store.close();
    await t.cleanup();
  }
});

test("a session whose store is closed still streams manifest + record + README", async () => {
  const t = await tempStore();
  const store = await Store.open({ ...t.options, name: "r8-closed" });
  const before = await exportSnapshot();
  try {
    // The FE keeps ids from the archive list, so the route can be asked for a
    // session the catalog no longer holds (the wave1b recipe): no opened store,
    // no agents — the README explains what is missing instead of failing.
    const ghost: SessionRow = {
      id: "00000000-0000-0000-0000-000000000000",
      name: "Closed R8",
      cwd: t.work,
      model: faux.modelId,
      provider: faux.provider,
      createdAt: 1,
      dbPath: join(t.root, "nope"),
    };
    const bundle = await streamSessionBundle(store, ghost);
    try {
      const zip = await readFile(bundle.path);
      const entries = readZipEntries(zip);
      assert.deepEqual(
        entries.map((e) => e.name).sort(),
        ["README.txt", "manifest.json", "session.json"],
        "the not-opened bundle is manifest + record + README",
      );
      const readme = Buffer.from(entries.find((e) => e.name === "README.txt")!.data).toString("utf8");
      assert.match(readme, /store was closed/, "the README still explains the missing transcripts");
    } finally {
      await bundle.cleanup();
    }
    await assertNoNewExports(before, "no temp exports left behind");
  } finally {
    await store.close();
    await t.cleanup();
  }
});

test("the streaming ceiling refuses with the R7 style, size named, temp file cleaned", async () => {
  assert.equal(EXPORT_TOTAL_LIMIT_BYTES, 256 * 1024 * 1024, "the shipped ceiling is the agreed 256 MiB");
  const { t, store, row } = await sessionWithTranscript("r8-ceiling");
  const before = await exportSnapshot();
  try {
    // A 512-byte ceiling trips on this small fixture's very first entry (the
    // manifest alone exceeds it) — the refusal is the point, and a real
    // 256 MiB transcript is not test-size.
    await assert.rejects(
      () => streamSessionBundle(store, row, { ceilingBytes: 512 }),
      (e: unknown) =>
        e instanceof ApiFault &&
        e.code === "invalid" &&
        // R11 1.2: the db-size PRE-CHECK fires first (a real session's store is
        // already over a 512-byte ceiling) — same "Export refused" family,
        // size named, remedy named, as the streaming guard below.
        /Export refused: this session's store is/.test(e.message) &&
        /over the 0\.0 MiB export ceiling/.test(e.message) &&
        /Compact the session first/.test(e.message),
      "the pre-check refusal names the size and the remedy",
    );
    // The STREAMING guard still exists for dbs that fit the ceiling but whose
    // rendered entries do not — exercise it with a stub row whose dbPath is
    // tiny (the manifest alone busts a 512-byte ceiling).
    const tiny = join(t.options.dataDir, "tiny.db");
    await writeFile(tiny, "x");
    const stubRow = { ...row, dbPath: tiny } as typeof row;
    await assert.rejects(
      () => streamSessionBundle(store, stubRow, { ceilingBytes: 512 }),
      (e: unknown) =>
        e instanceof ApiFault &&
        e.code === "invalid" &&
        /Export refused: transcripts are/.test(e.message) &&
        /over the 0\.0 MiB streaming ceiling/.test(e.message) &&
        /Compact the session first/.test(e.message),
      "the streaming refusal names the size and the remedy",
    );
    await assertNoNewExports(before, "the failed export left no temp file");
  } finally {
    await store.close();
    await t.cleanup();
  }
});

test("zip64-less limits refuse cleanly before the archive is written", () => {
  const GiB = 1024 * 1024 * 1024;
  assert.equal(zip64Problem({ raw: 4 * GiB + 1 }), "an entry is 4096.0 MiB uncompressed, over the 4 GiB zip limit");
  assert.equal(zip64Problem({ compressed: 4 * GiB + 1 }), "an entry is 4096.0 MiB deflated, over the 4 GiB zip limit");
  assert.equal(zip64Problem({ archive: 4 * GiB + 1 }), "the archive is 4096.0 MiB, over the 4 GiB zip limit");
  assert.match(zip64Problem({ entries: 0xffff + 1 })!, /65535 zip limit/);
  assert.equal(zip64Problem({ raw: ZIP_U32_MAX, archive: ZIP_U32_MAX, entries: ZIP_MAX_ENTRIES }), undefined, "exactly at the limits still fits");
  assert.equal(zip64Problem({}), undefined, "no quantities, no problem");
});

test("Crc32 fed in slices equals the one-shot crc32", () => {
  const raw = Buffer.from(
    Array.from({ length: 5000 }, (_, i) => String.fromCharCode(0x20 + (i % 0x5f))).join(""),
    "utf8",
  );
  const incremental = new Crc32();
  for (let at = 0; at < raw.length; at += 7) incremental.update(raw.subarray(at, at + 7));
  assert.equal(incremental.get(), crc32(raw), "chunked updates checksum identically");
});

test("the export route streams zip bytes with attachment headers and leaves no temp files", async () => {
  const { t, store, row } = await sessionWithTranscript("r8-route");
  const before = await exportSnapshot();
  const token = newToken();
  const app = express();
  app.disable("x-powered-by");
  app.use("/v1", bearerAuth(token), express.json({ limit: "256kb" }), v1(store));
  app.use(errorMiddleware);
  const server = createServer(app);
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", () => r()));
  const base = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
  try {
    const res = await fetch(`${base}/v1/sessions/${row.id}/export`, { headers: { authorization: `Bearer ${token}` } });
    assert.equal(res.status, 200);
    assert.equal(res.headers.get("content-type"), "application/zip", "the body is the zip itself, not base64 JSON");
    assert.equal(res.headers.get("content-disposition"), `attachment; filename="r8-route.bundle.zip"`);
    const body = Buffer.from(await res.arrayBuffer());
    assert.equal(Number(res.headers.get("content-length")), body.length, "the Content-Length matches the bytes sent");
    assert.equal(body.readUInt32LE(0) & 0xffff, 0x4b50, "the payload is a zip (PK magic)");
    const entries = readZipEntries(body);
    assert.ok(entries.some((e) => e.name === "manifest.json"), "the manifest travels in the streamed bundle");
    assert.ok(
      entries.some(
        (e) => e.name === "agents/1/transcript.md" && Buffer.from(e.data).toString("utf8").includes("hello r8-route"),
      ),
      "the transcript travels in the streamed bundle",
    );
    await until(
      async () => (await exportSnapshot()).filter((n) => !before.includes(n)).length === 0,
      5000,
      "the route's temp file to be cleaned up",
    );
    await assertNoNewExports(before, "no temp exports left behind");
  } finally {
    server.closeAllConnections();
    await new Promise<void>((r) => server.close(() => r()));
    await store.close();
    await t.cleanup();
  }
});
