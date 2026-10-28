/**
 * R15 (run-2 h14): the `dpi telegram` CLI is a designed second writer of
 * telegram.json, while the daemon used to authorize every update from a
 * boot-time in-memory copy and re-persist that stale snapshot on every poll —
 * an operator revocation was ignored by the live bridge AND resurrected on
 * disk, and CLI-minted codes were invisible to the daemon and erased by its
 * next commit. The bridge now re-reads the registry before every handle.
 * Level: unit, two real bridges on ONE file, no token (fetch never called).
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { readFileSync, writeFileSync } from "node:fs";
import { TelegramBridge, type TelegramIo, type TelegramBroker } from "../src/telegram.ts";

const io = (): TelegramIo => ({
  fetch: async () => {
    throw new Error("probe must never fetch");
  },
  readFile: (p) => Promise.resolve(readFileSync(p, "utf8")),
  writeFile: (p, d) => {
    writeFileSync(p, d);
    return Promise.resolve();
  },
  chmod: () => Promise.resolve(),
  exists: () => Promise.resolve(true),
  now: () => Date.parse("2026-10-28T12:00:00.000Z"),
  setTimeout: (cb) => {
    void cb;
    return { unref: () => undefined };
  },
  clearTimeout: () => undefined,
});

const calls: Array<{ session: string; text: string }> = [];
const broker: TelegramBroker = {
  listSessions: () => [{ id: "ses_alpha", name: "alpha" }, { id: "ses_beta", name: "beta" }],
  sendToSession: async (session, text) => {
    calls.push({ session, text });
    return { submissionId: 1 };
  },
  awaitAnswer: async () => undefined,
};

const read = (p: string) => JSON.parse(readFileSync(p, "utf8"));

test("R15 h14: CLI revocation is honored live and never resurrected; CLI codes bind", async () => {
  const dir = await mkdtemp(join(tmpdir(), "dpi-tg-r15-"));
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
  const daemon = await TelegramBridge.open(file, io(), broker);
  const cli = await TelegramBridge.open(file, io(), broker);

  // P1: the CLI (second bridge) unbinds chat 42.
  assert.equal(await cli.unbind("42"), 42);
  assert.deepEqual(read(file).chats, []);

  // P2: ANY bot traffic through the daemon must NOT resurrect the binding.
  await daemon.handle({ updateId: 60, message: { chatId: 999, text: "/help", fromId: 777, chatType: "private" } } as never);
  assert.deepEqual(read(file).chats, [], "stranger traffic must not resurrect the revoked binding");
  assert.equal(read(file).offset, 61, "ack offset still advances");

  // P3: the revoked pinned sender's plain text must NOT reach the session.
  await daemon.handle({ updateId: 61, message: { chatId: 42, text: "hostile turn", fromId: 111, chatType: "private" } } as never);
  assert.deepEqual(calls, [], "revoked chat must not submit agent turns");

  // P4: a code minted by the CLI while the daemon runs binds normally.
  const minted = await cli.bind("ses_beta");
  await daemon.handle({
    updateId: 62,
    message: { chatId: 55, text: `/start ${minted.code}`, fromId: 222, chatType: "private" },
  } as never);
  const fin = read(file);
  const bound = fin.chats.find((c: { chatId: number }) => c.chatId === 55);
  assert.ok(bound, "CLI-minted code must bind through the running daemon");
  assert.equal(bound.sessionId, "ses_beta");
  assert.equal(bound.boundFromId, 222);
});
