// R19 (run-5 h3, leader-confirmed HIGH): the registry lock was ownership-blind
// (stale-break stat→unlink raced a successor; finally unlinked "whatever file is
// there") and persist's CAS→write window was verify-blind, so a non-locking peer
// (operator hand-edit, pre-R18 writer during the post-upgrade window) could be
// silently clobbered: the revoke reported success while the revoked binding
// stayed on disk and the next message from that chat was dispatched.
// These tests pin the two closers: ownership-checked unlink, and the .bak
// re-read compared against the CAS baseline BEFORE any write.
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, readFileSync, writeFileSync, existsSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { TelegramBridge, defaultTelegramIo, type TelegramBroker, type TelegramIo } from "../src/telegram.js";

const dir = join(tmpdir(), `dpi-tg-r19-${process.pid}`);
mkdirSync(dir, { recursive: true });
const file = join(dir, "telegram.json");

const binding = { chatId: 42, sessionId: "ses_alpha", createdAt: "2026-10-01T00:00:00.000Z", boundFromId: 111 };
const withChat = (offset = 50) => `${JSON.stringify({ version: 1, offset, chats: [binding], codes: [] }, null, 2)}\n`;
const withoutChat = (offset = 50) => `${JSON.stringify({ version: 1, offset, chats: [], codes: [] }, null, 2)}\n`;

const baseIo = () => ({
  fetch: async () => {
    throw new Error("probe must never fetch");
  },
  readFile: (p: string) => (existsSync(p) ? readFileSync(p, "utf8") : Promise.reject(new Error("ENOENT"))),
  writeFile: (p: string, d: string) => {
    writeFileSync(p, d);
    return Promise.resolve();
  },
  chmod: () => Promise.resolve(),
  exists: (p: string) => Promise.resolve(existsSync(p)),
  now: () => Date.parse("2026-10-29T12:00:00.000Z"),
  setTimeout: (cb: () => void) => {
    void cb;
    return { unref: () => undefined };
  },
  clearTimeout: () => undefined,
});

const broker = (sink: string[]): TelegramBroker => ({
  listSessions: () => [{ id: "ses_alpha", name: "alpha" }],
  sendToSession: async (session: string, text: string) => {
    sink.push(`${session}:${text}`);
    return { submissionId: 1 };
  },
  awaitAnswer: async () => undefined,
});

test("R19 h3-a: a foreign write landing between the CAS read and the write is REFUSED, not clobbered", async () => {
  rmSync(file, { force: true });
  rmSync(`${file}.bak`, { force: true });
  writeFileSync(file, withChat(50));
  const sink: string[] = [];
  const warnings: string[] = [];
  // Read #1 of main is load()'s baseline; read #2 is persist's CAS. Inject the
  // foreign (revoked) write immediately AFTER the CAS returns — the exact window
  // the old code wrote over (its post-write verify only ever saw its own bytes).
  let mainReads = 0;
  const io: TelegramIo = {
    ...(baseIo() as TelegramIo),
    readFile: (p: string) => {
      const text = readFileSync(p, "utf8");
      if (p === file) {
        mainReads += 1;
        if (mainReads === 2) {
          const foreign = withoutChat(50);
          writeFileSync(file, foreign);
          return Promise.resolve(text); // the CAS still sees OUR baseline
        }
      }
      return Promise.resolve(text);
    },
    withLock: <T>(_p: string, fn: () => Promise<T>) => fn(),
  } as TelegramIo;
  const bridge = await TelegramBridge.open(file, io, broker(sink), { warn: (m) => warnings.push(m) });
  // handle() is private; the r18 suite reaches it with the same structural cast.
  const handle = (b: unknown, u: unknown) => (b as { handle(u: unknown): Promise<void> }).handle(u);
  // A daemon-side commit (any handle() that persists) must now fail loudly.
  const result = await handle(bridge, { updateId: 60, message: { chatId: 999, text: "/help", fromId: 777, chatType: "private" } })
    .then(() => "ok")
    .catch((e) => (e as { code?: string }).code ?? String(e));
  assert.equal(result, "registry_changed", `expected a loud refusal, got ${result}`);
  // The foreign (revoked) bytes are still authoritative on disk — never overwritten.
  assert.equal(JSON.parse(readFileSync(file, "utf8")).chats.length, 0, "the foreign revoke must survive");
  // And the revoked chat cannot drive the session afterwards.
  const hostile = await handle(bridge, { updateId: 61, message: { chatId: 42, text: "hostile turn", fromId: 111, chatType: "private" } })
    .then(() => "ok")
    .catch((e) => (e as { code?: string }).code ?? String(e));
  assert.ok(!sink.some((s) => s.includes("hostile turn")), `revoked chat must not dispatch (${hostile})`);
});

test("R19 h3-b: the lock release removes only the holder's own lock (never a successor's)", async () => {
  rmSync(file, { force: true });
  writeFileSync(file, withChat(50));
  const lockPath = `${file}.lock`;
  const io = defaultTelegramIo();
  let released = false;
  await io.withLock!(file, async () => {
    // While we hold it, a successor replaces the lock file (as a stale-break race would).
    writeFileSync(lockPath, "someone-else\n");
    released = true;
  });
  assert.ok(released, "critical section ran");
  // The successor's lock must still exist — the old blind finally-unlink deleted it.
  assert.ok(existsSync(lockPath), "a successor's lock must not be removed by our release");
  assert.equal(readFileSync(lockPath, "utf8").trim(), "someone-else");
  rmSync(lockPath, { force: true });
});
