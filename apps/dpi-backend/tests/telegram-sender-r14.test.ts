/**
 * Audit run-1 MEDIUM — the Telegram bridge authorized the chat CONTAINER, not
 * the message sender: dispatch() discarded `from`, the binding stored no sender
 * identity, nothing inspected chat.type, and membership was never re-checked —
 * so one /start in a group chat handed every member (and members added later)
 * the operator's agent authority. The fix pins the /start sender's stable
 * Telegram id on the binding, refuses non-private chats at bind time, and drops
 * every non-bound-sender message like a stranger's.
 */
import test from "node:test";
import assert from "node:assert/strict";
import { TelegramBridge, flattenUpdates, type TelegramBroker, type TelegramIo } from "../src/telegram.js";

const FILE = "/data/telegram.json";

function harness() {
  const files = new Map<string, string>();
  const timers: FakeTimer[] = [];
  const replies: Array<{ chatId: number; text: string }> = [];
  const sent: Array<{ sessionId: string; text: string }> = [];
  const polls: unknown[][] = [];
  let nowMs = 1_700_000_000_000;

  const io: TelegramIo = {
    fetch: async (url, init) => {
      if (url.includes("/getUpdates")) {
        const next = polls.shift() ?? [];
        return { ok: true, status: 200, json: async () => ({ ok: true, result: next }) };
      }
      if (url.includes("/sendMessage")) {
        const body = JSON.parse((init?.body ?? "{}") as string) as { chat_id?: number; text?: string };
        replies.push({ chatId: body.chat_id ?? 0, text: body.text ?? "" });
        return { ok: true, status: 200, json: async () => ({ ok: true, result: { message_id: 1 } }) };
      }
      throw new Error(`fetch not scripted: ${url}`);
    },
    readFile: async (path) => {
      const text = files.get(path);
      if (text === undefined)
        throw Object.assign(new Error(`ENOENT: ${path}`), { code: "ENOENT" });
      return text;
    },
    writeFile: async (path, data) => {
      files.set(path, data);
    },
    chmod: async () => {},
    exists: async (path) => files.has(path),
    now: () => nowMs,
    setTimeout: (cb, ms) => {
      const timer = new FakeTimer(cb, ms);
      timers.push(timer);
      return timer;
    },
    clearTimeout: (t) => {
      (t as FakeTimer).cleared = true;
    },
  };

  const broker: TelegramBroker = {
    listSessions: () => [{ id: "ses_alpha", name: "alpha" }],
    sendToSession: async (sessionId, text) => {
      sent.push({ sessionId, text });
      return { submissionId: sent.length };
    },
    awaitAnswer: async () => "the answer",
  };

  const open = () => TelegramBridge.open(FILE, io, broker, { now: () => nowMs });
  const settle = async () => {
    for (let i = 0; i < 25; i += 1) await new Promise<void>((done) => setImmediate(done));
  };
  const fire = async () => {
    const timer = timers.find((t) => !t.fired && !t.cleared);
    assert.ok(timer, "expected a pending timer");
    timer.fire();
    await settle();
  };
  const registry = () => JSON.parse(files.get(FILE) ?? "{}");
  return { io, polls, replies, sent, open, settle, fire, registry, advance: (ms: number) => (nowMs += ms) };
}

/** A timer the test owns: nothing fires until `fire()` is called. */
class FakeTimer {
  fired = false;
  cleared = false;
  constructor(
    private readonly cb: () => void,
    readonly ms: number,
  ) {}
  fire(): void {
    if (this.cleared || this.fired) return;
    this.fired = true;
    this.cb();
  }
  unref(): void {}
}

/** A raw update shaped like Telegram's wire format. */
const update = (
  updateId: number,
  chatId: number,
  text: string,
  from: { id: number; username: string },
  chatType: string,
) => ({
  update_id: updateId,
  message: { chat: { id: chatId, type: chatType }, from, text },
});

test("flattenUpdates carries the stable sender id and chat type", () => {
  const rows = flattenUpdates([
    update(1, 42, "hi", { id: 111, username: "alice" }, "private"),
    update(2, -100, "yo", { id: 222, username: "mallory" }, "supergroup"),
    { update_id: 3, message: { chat: { id: 9 }, from: { username: "old" }, text: "old shape" } },
  ]);
  assert.equal(rows[0].message?.fromId, 111);
  assert.equal(rows[0].message?.chatType, "private");
  assert.equal(rows[1].message?.fromId, 222);
  assert.equal(rows[1].message?.chatType, "supergroup");
  assert.equal(rows[2].message?.fromId, undefined, "absent from.id stays absent");
  assert.equal(rows[2].message?.chatType, undefined, "absent chat.type stays absent");
});

test("only the pinned /start sender may act on the binding (audit run-1)", async () => {
  const h = harness();
  const bridge = await h.open();
  const code = await bridge.bind("ses_alpha");
  bridge.start("TOKEN:secret");

  // The operator binds from their private chat.
  h.polls.push([update(1, 42, `/start ${code.code}`, { id: 111, username: "alice" }, "private")]);
  await h.fire();
  assert.match(h.replies.at(-1)!.text, /bound to alpha/);
  assert.equal(h.registry().chats[0].boundFromId, 111, "the binding pins the sender's stable id");

  // The operator's own message still reaches the agent.
  h.polls.push([update(2, 42, "status report", { id: 111, username: "alice" }, "private")]);
  await h.fire();
  assert.equal(h.sent.length, 1);
  assert.equal(h.sent[0].text, "status report");

  // A DIFFERENT sender in the same chat (or a member of a bound group): dropped
  // like a stranger's — no submission, no reply, no state change.
  const repliesBefore = h.replies.length;
  h.polls.push([
    update(3, 42, "rm -rf /tmp/proof", { id: 222, username: "mallory" }, "private"),
    update(4, 42, "/session", { id: 222, username: "mallory" }, "private"),
    update(5, 42, "/stop", { id: 222, username: "mallory" }, "private"),
  ]);
  await h.fire();
  assert.equal(h.sent.length, 1, "a non-bound sender's text is never submitted");
  assert.equal(h.replies.length, repliesBefore, "a non-bound sender learns nothing");
  assert.equal(h.registry().chats.length, 1, "/stop from a non-bound sender cannot revoke");
  assert.equal(h.registry().chats[0].sessionId, "ses_alpha", "/session from a non-bound sender cannot retarget");
});

test("a non-private chat is refused at bind time (audit run-1)", async () => {
  const h = harness();
  const bridge = await h.open();
  const code = await bridge.bind("ses_alpha");
  bridge.start("TOKEN:secret");

  h.polls.push([update(1, -100200300, `/start ${code.code}`, { id: 111, username: "alice" }, "supergroup")]);
  await h.fire();
  assert.match(h.replies.at(-1)!.text, /not a private chat/);
  assert.equal(h.registry().chats.length, 0, "no binding was created");
  assert.equal(h.registry().codes.length, 1, "the code was not spent by the refused bind");

  // The same code still binds from a private chat.
  h.polls.push([update(2, 42, `/start ${code.code}`, { id: 111, username: "alice" }, "private")]);
  await h.fire();
  assert.match(h.replies.at(-1)!.text, /bound to alpha/);
  assert.equal(h.registry().chats[0].boundFromId, 111);
});

test("a legacy binding without a pinned sender keeps working until re-bound", async () => {
  const h = harness();
  // Pre-existing registry row (pre-fix shape): no boundFromId.
  h.io.writeFile(FILE, JSON.stringify({ version: 1, offset: 0, chats: [{ chatId: 7, sessionId: "ses_alpha", createdAt: "2026-10-01T00:00:00.000Z" }], codes: [] }));
  const bridge = await h.open();
  bridge.start("TOKEN:secret");

  h.polls.push([update(1, 7, "legacy text", { id: 999, username: "whoever" }, "private")]);
  await h.fire();
  assert.equal(h.sent.length, 1, "legacy chat-wide bindings are not bricked by the upgrade");

  // Re-binding upgrades the row to a sender-pinned one.
  const code = await bridge.bind("ses_alpha");
  h.polls.push([update(2, 7, `/start ${code.code}`, { id: 111, username: "alice" }, "private")]);
  await h.fire();
  assert.equal(h.registry().chats[0].boundFromId, 111);
  h.polls.push([update(3, 7, "from someone else", { id: 999, username: "whoever" }, "private")]);
  await h.fire();
  assert.equal(h.sent.length, 1, "after re-bind only the pinned sender acts");
});
