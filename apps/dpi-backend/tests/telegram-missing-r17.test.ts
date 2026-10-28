/**
 * R17 (run-3 h4): the missing-registry branch of syncForeign.
 * Pre-fix: a deleted (or unreadable → "absent") registry returned TRUE — the
 * revoked binding kept authorizing agent turns from stale memory AND the very
 * next commit resurrected the file with the revoked binding (probe-observed).
 * Post-fix: known-then-vanished → no dispatch, no persist; fresh (never had a
 * registry) → bind works, exactly like load()'s fresh-device semantics.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync, rmSync, existsSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { TelegramBridge, type TelegramBroker, type TelegramIo } from "../src/telegram.ts";

const io = (): TelegramIo => ({
  fetch: async () => {
    throw new Error("probe must never fetch");
  },
  readFile: (p) =>
    existsSync(p) ? Promise.resolve(readFileSync(p, "utf8")) : Promise.reject(new Error("ENOENT")),
  writeFile: (p, d) => {
    writeFileSync(p, d);
    return Promise.resolve();
  },
  chmod: () => Promise.resolve(),
  exists: (p) => Promise.resolve(existsSync(p)),
  mkdir: () => Promise.resolve(),
  now: () => Date.parse("2026-10-29T12:00:00.000Z"),
  setTimeout: (cb) => {
    void cb;
    return { unref: () => undefined };
  },
  clearTimeout: () => undefined,
});

const broker = (sink: string[]): TelegramBroker => ({
  listSessions: () => [{ id: "ses_alpha", name: "alpha" }],
  sendToSession: async (session, text) => {
    sink.push(`${session}:${text}`);
    return { submissionId: 1 };
  },
  awaitAnswer: async () => undefined,
});

const hostileTurn = { updateId: 60, message: { chatId: 42, text: "hostile turn", fromId: 111, chatType: "private" } } as never;

test("R17 h4: vanished registry → no dispatch, no resurrection, no throw", async () => {
  const dir = mkdtempSync(join(tmpdir(), "dpi-tg-r17a-"));
  const file = join(dir, "telegram.json");
  writeFileSync(
    file,
    JSON.stringify({
      version: 1,
      offset: 50,
      chats: [{ chatId: 42, sessionId: "ses_alpha", createdAt: "2026-10-01T00:00:00.000Z", boundFromId: 111 }],
      codes: [],
    }),
  );
  const sink: string[] = [];
  const daemon = await TelegramBridge.open(file, io(), broker(sink));
  rmSync(file); // operator revokes by removal while the daemon lives
  await daemon.handle(hostileTurn);
  assert.deepEqual(sink, [], "no agent turn from stale memory");
  assert.ok(!existsSync(file), "the deleted registry must NOT be resurrected by a commit");
});

test("R17 h4: fresh device (registry never existed) still binds", async () => {
  const dir = mkdtempSync(join(tmpdir(), "dpi-tg-r17b-"));
  const file = join(dir, "telegram.json");
  const sink: string[] = [];
  const cli = await TelegramBridge.open(file, io(), broker(sink));
  const { code } = await cli.bind("ses_alpha");
  assert.match(code, /^[0-9a-f]{8}$/);
  const onDisk = JSON.parse(readFileSync(file, "utf8")) as { codes: { code: string }[] };
  assert.equal(onDisk.codes.length, 1);
});

test("R17 h4: second-writer bind adopts daemon state instead of clobbering it (CAS discipline)", async () => {
  const dir = mkdtempSync(join(tmpdir(), "dpi-tg-r17c-"));
  const file = join(dir, "telegram.json");
  writeFileSync(file, JSON.stringify({ version: 1, offset: 50, chats: [], codes: [] }));
  const sink: string[] = [];
  const daemon = await TelegramBridge.open(file, io(), broker(sink));
  const cli = await TelegramBridge.open(file, io(), broker(sink));
  // daemon commits first (a binding appears via the file)
  writeFileSync(
    file,
    JSON.stringify({
      version: 1,
      offset: 51,
      chats: [{ chatId: 99, sessionId: "ses_alpha", createdAt: "2026-10-01T00:00:00.000Z", boundFromId: 111 }],
      codes: [],
    }),
  );
  await daemon.handle(hostileTurn); // daemon adopts the foreign binding and persists its offset
  // the CLI (opened BEFORE the daemon's commit) must not clobber: its bind
  // re-reads via syncForeign and the daemon's binding survives.
  await cli.bind("ses_alpha");
  const onDisk = JSON.parse(readFileSync(file, "utf8")) as {
    chats: { chatId: number }[];
    codes: unknown[];
  };
  assert.ok(onDisk.chats.some((c) => c.chatId === 99), "daemon-adopted binding survives the CLI write");
  assert.equal(onDisk.codes.length, 1, "the CLI's minted code is present");
});
