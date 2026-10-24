/**
 * Wave 1b of docs/host-project-checklist.md: device vitals, session search, and
 * the export bundle. The ZIP writer is verified against a reader we implement
 * here (central directory walk + inflate + CRC), so a real archive tool is not a
 * test dependency.
 */
import test from "node:test";
import assert from "node:assert/strict";
import { inflateRawSync } from "node:zlib";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { mkdtemp, readdir, rm, writeFile } from "node:fs/promises";
import { crc32, zipSync } from "../src/zip.js";
import { deviceVitals, diskVitals, humanBytes, humanDuration } from "../src/vitals.js";
import { faux, tempStore } from "./helpers.js";

/** Minimal reader: walk the central directory, inflate every entry, check the CRC. */
function unzip(buffer: Buffer): { path: string; text: string; method: number }[] {
  const eocd = buffer.lastIndexOf(Buffer.from([0x50, 0x4b, 0x05, 0x06]));
  assert.ok(eocd >= 0, "end-of-central-directory record present");
  const count = buffer.readUInt16LE(eocd + 10);
  let at = buffer.readUInt32LE(eocd + 16);
  const out: { path: string; text: string; method: number }[] = [];
  for (let i = 0; i < count; i += 1) {
    assert.equal(buffer.readUInt32LE(at), 0x02014b50, "central header signature");
    const method = buffer.readUInt16LE(at + 10);
    const crc = buffer.readUInt32LE(at + 16);
    const compressed = buffer.readUInt32LE(at + 20);
    const nameLen = buffer.readUInt16LE(at + 28);
    const extraLen = buffer.readUInt16LE(at + 30);
    const commentLen = buffer.readUInt16LE(at + 32);
    const localAt = buffer.readUInt32LE(at + 42);
    const name = buffer.subarray(at + 46, at + 46 + nameLen).toString("utf8");
    assert.equal(buffer.readUInt32LE(localAt), 0x04034b50, "local header signature");
    const localNameLen = buffer.readUInt16LE(localAt + 26);
    const localExtraLen = buffer.readUInt16LE(localAt + 28);
    const dataAt = localAt + 30 + localNameLen + localExtraLen;
    const body = buffer.subarray(dataAt, dataAt + compressed);
    const raw = method === 8 ? inflateRawSync(body) : Buffer.from(body);
    assert.equal(crc32(raw), crc, `crc matches for ${name}`);
    out.push({ path: name, text: raw.toString("utf8"), method });
    at += 46 + nameLen + extraLen + commentLen;
  }
  return out;
}

test("zipSync writes archives a real reader accepts", () => {
  const entries = [
    { path: "manifest.json", text: '{"name":"xin chào"}\n' },
    { path: "nested/transcript.md", text: `# Session\n\n${"line\n".repeat(400)}` },
    { path: "/leading-slash.txt", text: "trimmed\n" },
    { path: "empty.txt", text: "" },
  ];
  const archive = zipSync(entries, new Date(2026, 0, 2, 3, 4, 6));
  const read = unzip(archive);
  assert.deepEqual(
    read.map((entry) => entry.path),
    ["manifest.json", "nested/transcript.md", "leading-slash.txt", "empty.txt"],
  );
  assert.equal(read[0].text, entries[0].text);
  assert.equal(read[1].text, entries[1].text);
  // Repetitive text is deflated; the tiny/empty ones stay stored.
  assert.equal(read[1].method, 8);
  assert.equal(read[3].method, 0);
  assert.ok(archive.length < entries[1].text.length, "deflate actually shrinks the transcript");
});

test("crc32 matches the reference value for 123456789", () => {
  assert.equal(crc32(Buffer.from("123456789", "utf8")), 0xcbf43926);
});

test("deviceVitals reports the host, the process, and the data-dir volume", async () => {
  const dir = await mkdtemp(join(tmpdir(), "dpi-vitals-"));
  try {
    const startedAt = Date.now() - 65_000;
    const vitals = deviceVitals(dir, startedAt);
    assert.ok(vitals.uptime > 0, "host uptime");
    assert.ok(vitals.processUptime >= 64, `process uptime ~65s (got ${vitals.processUptime})`);
    assert.ok(vitals.cpuCount >= 1);
    assert.equal(vitals.loadavg.length, 3);
    assert.ok(vitals.memory.totalBytes > 0);
    assert.ok(vitals.memory.usedBytes > 0);
    assert.ok(vitals.memory.processRssBytes > 0);
    assert.equal(vitals.disk.path, dir);
    assert.equal(vitals.disk.known, true);
    assert.ok(vitals.disk.totalBytes >= vitals.disk.freeBytes);
    assert.equal(vitals.pid, process.pid);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("diskVitals degrades instead of throwing", () => {
  const missing = diskVitals(join(tmpdir(), "dpi-does-not-exist-xyz"));
  assert.equal(missing.known, false);
  assert.equal(missing.totalBytes, 0);
  // A file, not a directory, is not a volume either.
  const file = join(tmpdir(), `dpi-vitals-file-${process.pid}.txt`);
  assert.equal(diskVitals(file).known, false);
});

test("human durations and sizes read like a person wrote them", () => {
  assert.equal(humanDuration(45), "45s");
  assert.equal(humanDuration(12 * 60), "12m");
  assert.equal(humanDuration(3 * 3600 + 4 * 60), "3h 4m");
  assert.equal(humanDuration(50 * 3600), "2d 2h");
  assert.equal(humanBytes(512), "512 B");
  assert.equal(humanBytes(1536), "1.5 KiB");
  assert.equal(humanBytes(5 * 1024 ** 3), "5.0 GiB");
  assert.equal(humanBytes(0), "0 B");
});

test("searchSessions matches names, cwds and models — and ignores short queries", async () => {
  const t = await tempStore();
  const store = await t.open();
  try {
    await store.create({ name: "Fix the parser", cwd: "project/nested", model: faux });
    await store.create({ name: "Notes", cwd: "project", model: faux });

    assert.deepEqual(store.searchSessions("x").matches, [], "one character is not a query");
    assert.deepEqual(store.searchSessions("   ").matches, []);

    const byName = store.searchSessions("parser");
    assert.equal(byName.query, "parser");
    assert.deepEqual(
      byName.matches.map((m) => [m.name, m.where]),
      [["Fix the parser", ["name"]]],
    );
    assert.equal(byName.matches[0].cwd, join(t.work, "project", "nested"));

    const byCwd = store.searchSessions("project");
    assert.equal(byCwd.matches.length, 2, "both sessions live under project/");
    assert.ok(byCwd.matches.every((m) => m.where.includes("cwd")));

    // Name hits rank above cwd-only hits.
    const mixed = store.searchSessions("nested");
    assert.deepEqual(mixed.matches.map((m) => m.name), ["Fix the parser"]);

    // Case-insensitive, like every search box.
    assert.equal(store.searchSessions("FIX").matches.length, 1);
  } finally {
    await store.close();
    await t.cleanup();
  }
});

test("exportSession zips a manifest, the session record and every agent's transcript", async () => {
  const t = await tempStore();
  const store = await t.open();
  try {
    const session = await store.create({ name: "My session #1", cwd: "project", model: faux });
    const bundle = await store.exportSession(store.resolveSession(session.id));
    assert.equal(bundle.filename, "my-session-1.bundle.zip");
    assert.equal(bundle.mime, "application/zip");
    assert.equal(bundle.bytes, Buffer.from(bundle.base64, "base64").length);

    const entries = unzip(Buffer.from(bundle.base64, "base64"));
    const paths = entries.map((e) => e.path).sort();
    assert.deepEqual(paths, ["agents/1/config.json", "agents/1/transcript.json", "agents/1/transcript.md", "manifest.json", "session.json"]);

    const manifest = JSON.parse(entries.find((e) => e.path === "manifest.json")!.text);
    assert.equal(manifest.format, "dpi-session-bundle");
    assert.equal(manifest.version, 1);
    assert.equal(manifest.session.id, session.id);
    assert.equal(manifest.session.name, "My session #1");
    assert.equal(manifest.agents[0].id, 1);
    assert.ok(manifest.device.name, "device identity travels with the bundle");

    const record = JSON.parse(entries.find((e) => e.path === "session.json")!.text);
    assert.equal(record.id, session.id);
    assert.equal(record.cwd, join(t.work, "project"));

    const config = JSON.parse(entries.find((e) => e.path === "agents/1/config.json")!.text);
    assert.ok(config && typeof config === "object");
  } finally {
    await store.close();
    await t.cleanup();
  }
});

test("exportSession of a closed session still ships a bundle and counts archived sessions", async () => {
  const t = await tempStore();
  const store = await t.open();
  try {
    const session = await store.create({ name: "Bye", cwd: "project", model: faux });
    await store.archive(store.resolveSession(session.id));
    assert.equal((await store.vitals()).counts.archived, 1);
    assert.equal((await store.vitals()).counts.sessions, 0);

    // The row is gone from the catalog, but its record can still be exported by id
    // (the FE keeps the id in the archive list) — no agents means no transcript.
    const gone = {
      id: "x",
      name: "Gone",
      cwd: t.work,
      model: faux.modelId,
      provider: faux.provider,
      createdAt: 1,
      dbPath: join(t.root, "nope"),
    };
    const bundle = await store.exportSession(gone);
    const entries = unzip(Buffer.from(bundle.base64, "base64")).map((e) => e.path);
    assert.deepEqual(entries, ["manifest.json", "session.json", "README.txt"]);
  } finally {
    await store.close();
    await t.cleanup();
  }
});
