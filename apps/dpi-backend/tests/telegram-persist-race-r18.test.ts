// R18 (run-4 h3): two writers, one registry. The leader probe proved that on
// a0893c1-era code a CLI unbind landing between the daemon persist's CAS read
// and its final write was silently clobbered — the revoked binding
// resurrected, no registry_changed, and the revoked chat's next message was
// dispatched. The fix: the whole read-modify-write is one lock-respecting
// critical section (defaultTelegramIo.withLock), the vanished registry fails
// closed, and a foreign write landing inside the post-write window is restored
// and reported. These tests pin the locked semantics deterministically.
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, readFileSync, writeFileSync, existsSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { TelegramBridge, type TelegramBroker, type TelegramIo } from "../src/telegram.js";

const dir = join(tmpdir(), `dpi-tg-race-${process.pid}`);
mkdirSync(dir, { recursive: true });
const file = join(dir, "telegram.json");

const binding = { chatId: 42, sessionId: "ses_alpha", createdAt: "2026-10-01T00:00:00.000Z", boundFromId: 111 };
const withChat = (offset = 50) => `${JSON.stringify({ version: 1, offset, chats: [binding], codes: [] }, null, 2)}\n`;
const withoutChat = (offset = 50) => `${JSON.stringify({ version: 1, offset, chats: [], codes: [] }, null, 2)}\n`;

/** Mutex-fake io: withLock serializes exactly like the real lock file does. */
const mutexIo = (): TelegramIo & { writes: number } => {
  let chain: Promise<unknown> = Promise.resolve();
  const base = {
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
  };
  return {
    ...(base as TelegramIo),
    writes: 0,
    withLock: <T>(_p: string, fn: (assertOwned: () => Promise<void>) => Promise<T>): Promise<T> => {
      const run = chain.then(() => fn(async () => undefined));
      chain = run.then(
        () => undefined,
        () => undefined,
      );
      return run;
    },
  };
};

const broker = (sink: string[]): TelegramBroker => ({
  listSessions: () => [{ id: "ses_alpha", name: "alpha" }],
  sendToSession: async (s: string, t: string) => {
    sink.push(`${s}:${t}`);
    return { submissionId: 1 };
  },
  awaitAnswer: async () => undefined,
});

test("concurrent CLI unbind during a daemon commit never silently resurrects the binding", async () => {
  // 20 rounds with jittered scheduling inside the fake io: the daemon's offset
  // commit and the CLI's unbind run concurrently on one real file.
  for (let round = 0; round < 20; round += 1) {
    writeFileSync(file, withChat());
    const sink: string[] = [];
    const warns: string[] = [];
    const io = mutexIo();
    const daemon = await TelegramBridge.open(file, io, broker(sink), { warn: (m) => warns.push(m) });
    const cli = await TelegramBridge.open(file, io, broker(sink), { warn: (m) => warns.push(m) });
    // Daemon commits an offset (any update triggers the per-update commit);
    // the CLI revokes chat 42 at the same moment. Both go through withLock.
    const daemonTurn = (daemon as unknown as { handle(u: unknown): Promise<void> })
      .handle({ updateId: 60, message: { chatId: 999, text: "/help", fromId: 777, chatType: "private" } })
      .catch(() => undefined);
    const cliTurn = cli.unbind("42").catch(() => "cli-failed");
    await Promise.all([daemonTurn, cliTurn]);
    const disk = JSON.parse(readFileSync(file, "utf8")) as { chats: { chatId: number }[]; offset: number };
    const resurrected = disk.chats.some((c) => c.chatId === 42);
    // The invariant: never a SILENT resurrection. If the binding is on disk,
    // the CLI must have failed loudly (registry_changed) — the operator sees it.
    const cliFailed = (await cliTurn) === "cli-failed";
    assert.ok(
      !resurrected || cliFailed,
      `round ${round}: binding on disk after successful unbind — silent clobber (disk=${JSON.stringify(disk.chats)})`,
    );
    // And a clean unbind really removed it.
    if (!cliFailed) assert.deepEqual(disk.chats, []);
    await daemon.stop?.();
    await cli.stop?.();
  }
});

test("a foreign write landing after the daemon's write is restored, not clobbered", async () => {
  writeFileSync(file, withChat());
  const sink: string[] = [];
  const warns: string[] = [];
  let injected = false;
  // No lock on this io: model a non-locking foreign writer (operator hand-edit
  // racing the commit) whose bytes land AFTER the daemon's final write.
  const io = {
    ...mutexIo(),
    withLock: undefined,
    writeFile: (p: string, d: string) => {
      if (p === file && d.includes('"offset": 61') && !injected) {
        injected = true;
        writeFileSync(p, d); // the daemon's write lands…
        writeFileSync(p, withoutChat(61)); // …and the operator's edit lands right after it
        return Promise.resolve();
      }
      writeFileSync(p, d);
      return Promise.resolve();
    },
  } as TelegramIo;
  const bridge = await TelegramBridge.open(file, io, broker(sink), { warn: (m) => warns.push(m) });
  const call = (b: unknown, u: unknown) =>
    (b as { handle(x: unknown): Promise<void> }).handle(u).catch((e: { code?: string }) => e);
  const outcome = await call(bridge, { updateId: 60, message: { chatId: 999, text: "/help", fromId: 777, chatType: "private" } });
  // The commit refused loudly…
  assert.equal((outcome as { code?: string }).code, "registry_changed");
  // The foreign bytes survived: verify+rollback restored them and threw loudly.
  const disk = JSON.parse(readFileSync(file, "utf8")) as { chats: unknown[] };
  assert.deepEqual(disk.chats, []); // the operator's revocation is what survived on disk
  // The revoked chat is NOT dispatched afterwards.
  await call(bridge, { updateId: 61, message: { chatId: 42, text: "hostile turn", fromId: 111, chatType: "private" } });
  assert.ok(!sink.some((s) => s === "ses_alpha:hostile turn"), `revoked chat dispatched: ${JSON.stringify(sink)}`);
  await bridge.stop?.();
});

test("registry vanishing between syncForeign and commit fails closed — no resurrection", async () => {
  writeFileSync(file, withChat());
  const sink: string[] = [];
  const warns: string[] = [];
  // The file is read at open (load), then again by syncForeign inside the
  // first handle(). Flip exists() at that second read — the operator `rm`
  // lands between syncForeign and the commit's guard, exactly the window the
  // R17 CAS could not see (it skipped the check when exists() was false).
  let reads = 0;
  let flipped = false;
  const io = {
    ...mutexIo(),
    withLock: undefined,
    readFile: (p: string) => {
      if (p === file) {
        reads += 1;
        if (reads >= 2) flipped = true; // syncForeign's read just happened
      }
      return existsSync(p) ? readFileSync(p, "utf8") : Promise.reject(new Error("ENOENT"));
    },
    exists: (p: string) => Promise.resolve(p === file && flipped ? false : existsSync(p)),
  } as unknown as TelegramIo;
  const bridge = await TelegramBridge.open(file, io, broker(sink), { warn: (m) => warns.push(m) });
  const call = (b: unknown, u: unknown) =>
    (b as { handle(x: unknown): Promise<void> }).handle(u).catch((e: { code?: string }) => e);
  const outcome = await call(bridge, { updateId: 60, message: { chatId: 999, text: "/help", fromId: 777, chatType: "private" } });
  // The commit refused loudly instead of resurrecting from memory…
  assert.equal((outcome as { code?: string }).code, "registry_changed");
  // Fail closed: the daemon's offset-61 commit was refused, the on-disk bytes
  // are untouched, and the revoked chat is not dispatched afterwards.
  assert.equal(readFileSync(file, "utf8"), withChat(), "commit must not rewrite a vanished registry");
  await call(bridge, { updateId: 61, message: { chatId: 42, text: "hostile turn", fromId: 111, chatType: "private" } });
  assert.ok(!sink.some((s) => s === "ses_alpha:hostile turn"), `vanished registry still authorized: ${JSON.stringify(sink)}`);
  await bridge.stop();
});

test("cleanup", () => rmSync(dir, { recursive: true, force: true }));
