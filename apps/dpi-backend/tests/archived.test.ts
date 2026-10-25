/**
 * Archived-session browsing ("old sessions as feature surface"): manifests
 * round-trip and degrade (corrupt → undefined), `listArchived` merges manifest
 * identity with dirname-only bundles (newest first, turns/lastMessageAt/bytes
 * from a REAL sqlite bundle, -1/null degradation when there is no readable
 * sqlite), `findBundle` never matches a uuid prefix, `archivedTranscript`
 * renders like the live endpoint while skipping corrupt rows, and
 * `restoreArchive` renames one bundle back under sessions/, synthesizing a
 * manifest for old bundles and refusing to clobber a live session.
 *
 * Fixtures are real `node:sqlite` bundles built with the exact STRICT schema
 * the device writes (conversations/entries, `record` JSON via json_valid), in
 * temp dirs under os.tmpdir — the backup.ts test pattern.
 */
import test, { type TestContext } from "node:test";
import assert from "node:assert/strict";
import { DatabaseSync } from "node:sqlite";
import { mkdir, mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  archivedTranscript,
  findBundle,
  listArchived,
  readArchiveManifest,
  restoreArchive,
  writeArchiveManifest,
  type ArchiveManifest,
  type ArchivedTranscript,
} from "../src/archived.js";
import type { TranscriptItem } from "../../dpi-sdk/src/transcript.js";

/** Full uuid shape (8-4-4-4-12), lowercase hex — the shape store.archive() names bundle dirs with. */
const UUID_A = "11111111-2222-3333-4444-555555555555";
const UUID_B = "aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee";
const AT_OLD = 1790000000001;
const AT_NEW = 1790000000009;

/** 13-digit ms timestamps, like every wire-entry model[].timestamp the device records. */
const TS_1 = 1792909232982;
const TS_2 = 1792909257660;
const TS_3 = 1792909277111;

const SCHEMA = `
CREATE TABLE conversations (id INTEGER PRIMARY KEY, owner_conversation_id INTEGER, owner_task_id INTEGER, record TEXT NOT NULL CHECK (json_valid(record))) STRICT;
CREATE TABLE entries (id INTEGER PRIMARY KEY, conversation_id INTEGER NOT NULL, head INTEGER, commit_seq INTEGER NOT NULL, record TEXT NOT NULL CHECK (json_valid(record))) STRICT;
`;

const tempRoot = async (t: TestContext): Promise<string> => {
  const root = await mkdtemp(join(tmpdir(), "dpi-archived-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  return root;
};

/** A pi.user wire-entry record — string content is what user messages carry. */
const userEntry = (id: number, content: string, timestamp: number) => ({
  id,
  kind: "pi.user",
  model: [{ role: "user", content, timestamp }],
});

/** A pi.assistant wire-entry record — array-of-blocks content (toTranscript flatMaps it). */
const assistantEntry = (id: number, text: string, timestamp: number) => ({
  id,
  kind: "pi.assistant",
  model: [{ role: "assistant", content: [{ type: "text", text }], timestamp }],
});

/**
 * Build `<root>/<sessionId>-<archivedAt>/agent.sqlite` with the device's exact
 * schema and one conversation holding `records` (already-JSON-string rows pass
 * through verbatim, so corrupt-but-json_valid rows can be inserted). Optional
 * manifest written through the module itself.
 */
async function makeBundle(
  root: string,
  sessionId: string,
  archivedAt: number,
  records: unknown[],
  manifest?: ArchiveManifest,
): Promise<string> {
  const dir = join(root, `${sessionId}-${archivedAt}`);
  await mkdir(dir, { recursive: true });
  const db = new DatabaseSync(join(dir, "agent.sqlite"));
  db.exec(SCHEMA);
  db.prepare("INSERT INTO conversations (record) VALUES (?)").run(JSON.stringify({ id: 1 }));
  const insert = db.prepare("INSERT INTO entries (conversation_id, commit_seq, record) VALUES (?, ?, ?)");
  records.forEach((record, i) => insert.run(1, i + 1, typeof record === "string" ? record : JSON.stringify(record)));
  db.close();
  if (manifest) writeArchiveManifest(dir, manifest);
  return dir;
}

const manifest = (over: Partial<ArchiveManifest> = {}): ArchiveManifest => ({
  sessionId: UUID_A,
  name: "bench run",
  cwd: "/home/bom/bench",
  model: "sonnet-4.5",
  provider: "anthropic",
  createdAt: 1789000000000,
  archivedAt: AT_OLD,
  packageVersion: "0.4.0",
  ...over,
});

test("manifest round-trips; overwrites silently; corrupt reads as undefined", async (t) => {
  const dir = await tempRoot(t);
  const m = manifest();
  writeArchiveManifest(dir, m);
  assert.deepEqual(readArchiveManifest(dir), m);

  // 2-space JSON with a trailing newline, 0600 even across overwrites
  const raw = await readFile(join(dir, "session.json"), "utf8");
  assert.equal(raw, `${JSON.stringify(m, null, 2)}\n`);
  writeArchiveManifest(dir, manifest({ name: "renamed" }));
  assert.equal(readArchiveManifest(dir)?.name, "renamed");
  assert.equal((await stat(join(dir, "session.json"))).mode & 0o777, 0o600);

  // corrupt: bad JSON, then a parsed value that is not a manifest
  await writeFile(join(dir, "session.json"), "{ nope");
  assert.equal(readArchiveManifest(dir), undefined);
  await writeFile(join(dir, "session.json"), JSON.stringify({ sessionId: "x" }));
  assert.equal(readArchiveManifest(dir), undefined);
  // absent → undefined, never a throw
  await rm(join(dir, "session.json"));
  assert.equal(readArchiveManifest(dir), undefined);
});

test("listArchived: manifests + dirname fallbacks, newest first, turns/last/bytes/hasManifest", async (t) => {
  const archive = await tempRoot(t);
  await makeBundle(archive, UUID_A, AT_OLD, [userEntry(1, "Count slowly", TS_1), assistantEntry(2, "One.", TS_2)], manifest());
  await makeBundle(archive, UUID_B, AT_NEW, [userEntry(1, "hello", TS_3)]); // old bundle: no manifest

  const views = listArchived(archive);
  assert.equal(views.length, 2);

  // newest archivedAt first
  assert.equal(views[0].sessionId, UUID_B);
  assert.equal(views[0].archivedAt, AT_NEW);
  assert.equal(views[0].name, `archived ${UUID_B.slice(0, 8)}`);
  assert.equal(views[0].cwd, "");
  assert.equal(views[0].model, "");
  assert.equal(views[0].hasManifest, false);
  assert.equal(views[0].turns, 1);
  assert.equal(views[0].lastMessageAt, TS_3);
  assert.ok(views[0].bytes > 0);

  assert.equal(views[1].sessionId, UUID_A);
  assert.equal(views[1].archivedAt, AT_OLD);
  assert.equal(views[1].name, "bench run");
  assert.equal(views[1].cwd, "/home/bom/bench");
  assert.equal(views[1].model, "sonnet-4.5");
  assert.equal(views[1].hasManifest, true);
  assert.equal(views[1].turns, 2); // pi.user + pi.assistant
  assert.equal(views[1].lastMessageAt, TS_2); // max timestamp across entries
  assert.ok(views[1].bytes > 0);
});

test("findBundle: newest match wins; a uuid prefix never matches", async (t) => {
  const archive = await tempRoot(t);
  await makeBundle(archive, UUID_A, AT_OLD, []);
  assert.equal(findBundle(archive, UUID_A.slice(0, 8)), null); // prefix of the full uuid
  assert.equal(findBundle(archive, "aaaaaaaa"), null); // prefix of ANOTHER session's uuid
  assert.equal(findBundle(archive, UUID_A), join(archive, `${UUID_A}-${AT_OLD}`));

  await makeBundle(archive, UUID_A, AT_NEW, []); // re-archived later
  assert.equal(findBundle(archive, UUID_A), join(archive, `${UUID_A}-${AT_NEW}`));
  assert.equal(findBundle(archive, UUID_B), null);
});

test("degraded bundle: no readable sqlite still lists (turns -1, lastMessageAt null)", async (t) => {
  const archive = await tempRoot(t);
  const dir = join(archive, `${UUID_A}-${AT_OLD}`);
  await mkdir(dir, { recursive: true });
  await writeFile(join(dir, "agent.sqlite"), "this is not a database");

  const views = listArchived(archive);
  assert.equal(views.length, 1);
  assert.equal(views[0].sessionId, UUID_A);
  assert.equal(views[0].turns, -1);
  assert.equal(views[0].lastMessageAt, null);
  assert.equal(views[0].hasManifest, false);
  assert.ok(views[0].bytes > 0); // the junk file still has size

  // the transcript endpoint's 404 source: unreadable sqlite throws, never half-renders
  assert.throws(() => archivedTranscript(dir, "markdown"), /archive bundle unreadable/);
});

test("archivedTranscript: markdown + json like the live endpoint; corrupt rows skipped", async (t) => {
  const archive = await tempRoot(t);
  // corrupt-but-json_valid records: a JSON string, JSON null, and a non-entry object
  const dir = await makeBundle(archive, UUID_A, AT_OLD, [
    userEntry(1, "Count slowly", TS_1),
    assistantEntry(2, "One. Two. Three.", TS_2),
    '"garbage-not-an-entry"',
    "null",
    { id: 3, kind: "pi.system", model: [{ role: "system", content: "noise", timestamp: TS_3 }] },
  ]);

  const md = archivedTranscript(dir, "markdown");
  if (md.format !== "markdown") return assert.fail("expected markdown");
  assert.match(md.text, /Count slowly/);
  assert.match(md.text, /One\. Two\. Three\./);

  const js = archivedTranscript(dir, "json");
  if (js.format !== "json") return assert.fail("expected json");
  const kinds = (item: TranscriptItem) => item.kind;
  // corrupt rows skipped; pi.system is skipped by toTranscript by design, so exactly one user + one assistant
  assert.deepEqual(js.items.map(kinds), ["user", "assistant"]);

  // missing bundle dir → the route's 404 error
  assert.throws(() => archivedTranscript(join(archive, "nope-000000000000-0"), "json"), /archive bundle unreadable/);
});

test("restoreArchive: moves the bundle under sessions/, synthesizing a manifest for old bundles", async (t) => {
  const archive = await tempRoot(t);
  const dataDir = await tempRoot(t);
  await makeBundle(archive, UUID_A, AT_OLD, [userEntry(1, "Count slowly", TS_1)]);

  const restored = await restoreArchive(archive, dataDir, UUID_A);
  assert.deepEqual(restored, {
    sessionId: UUID_A,
    name: `archived ${UUID_A.slice(0, 8)}`,
    cwd: "",
    model: "",
    provider: "",
    createdAt: AT_OLD,
    archivedAt: AT_OLD,
    packageVersion: "",
  });
  // the dir moved (not copied), and the synthesized manifest was written into it
  assert.equal(listArchived(archive).length, 0);
  const liveDir = join(dataDir, "sessions", UUID_A);
  await stat(join(liveDir, "agent.sqlite"));
  assert.deepEqual(readArchiveManifest(liveDir), restored);

  // a manifest-bearing bundle restores with its identity intact
  await makeBundle(archive, UUID_B, AT_NEW, [], manifest({ sessionId: UUID_B }));
  const kept = await restoreArchive(archive, dataDir, UUID_B);
  assert.equal(kept?.name, "bench run");
  assert.equal(kept?.sessionId, UUID_B);
  assert.equal(listArchived(archive).length, 0);
});

test("restoreArchive: refuses a live session, throws for unknown ids", async (t) => {
  const archive = await tempRoot(t);
  const dataDir = await tempRoot(t);

  await assert.rejects(restoreArchive(archive, dataDir, UUID_A), /no archived session/);

  await makeBundle(archive, UUID_A, AT_OLD, []);
  await mkdir(join(dataDir, "sessions", UUID_A), { recursive: true });
  await assert.rejects(restoreArchive(archive, dataDir, UUID_A), /a live session with this id already exists/);
  // the refusal left the bundle in place
  assert.equal(listArchived(archive).length, 1);
});

test("listArchived on a missing archive dir → []", async (t) => {
  const root = await tempRoot(t);
  assert.deepEqual(listArchived(join(root, "archive-that-is-not-there")), []);
});
