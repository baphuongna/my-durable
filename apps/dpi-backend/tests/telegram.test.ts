/**
 * Wave 3 of docs/host-project-checklist.md: the Telegram chat ↔ session bridge.
 *
 * Everything here runs against fakes — an in-memory file map, a scripted fetch,
 * a broker that records, timers the test fires by hand — so no test opens a
 * socket, sleeps, or depends on Telegram. The tests that mutate also look at
 * the bytes on disk (a registry that only remembers in RAM is worse than none),
 * and the loop tests assert the ordering guarantees the module promises:
 * acknowledge-before-handle, one update at a time, backoff-on-failure.
 */
import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  ANSWER_TIMEOUT_MS,
  CODE_TTL_MS,
  TelegramBridge,
  defaultTelegramIo,
  flattenUpdates,
  type TelegramBroker,
  type TelegramIo,
} from "../src/telegram.js";

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

interface SentCall {
  sessionId: string;
  text: string;
}

/**
 * The whole world the bridge sees: files in a Map, a fetch scripted per call,
 * a broker that records, warnings captured, a clock the test advances.
 */
function harness(over: { sessions?: Array<{ id: string; name: string }> } = {}) {
  const file = "/data/telegram.json";
  const files = new Map<string, string>();
  const writes: string[] = [];
  const timers: FakeTimer[] = [];
  const warnings: string[] = [];
  const calls: Array<{ url: string; init?: { method?: string; body?: string } }> = [];
  const sent: SentCall[] = [];
  const awaits: Array<{ sessionId: string; submissionId: number; timeoutMs: number }> = [];
  const events: string[] = [];
  const replies: Array<{ chatId: number; text: string }> = [];
  /** Queued getUpdates answers: an Error to throw, a status to fail with, or the raw `result` array. */
  const polls: Array<unknown[] | Error | number> = [];
  /** When true the next sendMessage answers HTTP 500 (one shot per entry). */
  const replyFailures: boolean[] = [];
  const sessions = over.sessions ?? [
    { id: "ses_alpha", name: "alpha" },
    { id: "ses_beta", name: "beta" },
  ];
  let nowMs = 1_700_000_000_000;

  const jsonResponse = (status: number, body: unknown) => ({
    ok: status >= 200 && status < 300,
    status,
    json: async () => body,
  });

  const io: TelegramIo = {
    fetch: async (url, init) => {
      calls.push({ url, init });
      if (url.includes("/getUpdates")) {
        const next = polls.shift() ?? [];
        if (next instanceof Error) throw next;
        if (typeof next === "number") return jsonResponse(next, { ok: false, error_code: next });
        return jsonResponse(200, { ok: true, result: next });
      }
      if (url.includes("/sendMessage")) {
        const body = JSON.parse((init?.body ?? "{}") as string) as { chat_id?: number; text?: string };
        replies.push({ chatId: body.chat_id ?? 0, text: body.text ?? "" });
        events.push(`reply ${body.text}`);
        if (replyFailures.shift() === true) return jsonResponse(500, { ok: false });
        return jsonResponse(200, { ok: true, result: { message_id: 1 } });
      }
      throw new Error(`fetch not scripted: ${url}`);
    },
    readFile: async (path) => {
      const text = files.get(path);
      if (text === undefined) throw Object.assign(new Error(`ENOENT: ${path}`), { code: "ENOENT" });
      return text;
    },
    writeFile: async (path, data) => {
      files.set(path, data);
      writes.push(path);
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
    listSessions: () => sessions.map((session) => ({ ...session })),
    sendToSession: async (sessionId, text) => {
      sent.push({ sessionId, text });
      events.push(`send ${text}`);
      return { submissionId: sent.length };
    },
    awaitAnswer: async (sessionId, submissionId, timeoutMs) => {
      awaits.push({ sessionId, submissionId, timeoutMs });
      events.push(`answer ${submissionId}`);
      return "the answer";
    },
  };

  /** Let the fire-and-forget poll loop run to quiescence — no real timers anywhere. */
  const settle = async () => {
    for (let i = 0; i < 25; i += 1) await new Promise<void>((done) => setImmediate(done));
  };
  /** Fire the oldest pending timer (the loop only ever has one) and settle. */
  const fire = async () => {
    const timer = timers.find((t) => !t.fired && !t.cleared);
    assert.ok(timer, "expected a pending timer");
    timer.fire();
    await settle();
  };

  const open = () =>
    TelegramBridge.open(file, io, broker, {
      warn: (message) => warnings.push(message),
      now: () => nowMs,
    });

  return {
    file,
    backup: `${file}.bak`,
    io,
    broker,
    files,
    writes,
    timers,
    warnings,
    calls,
    sent,
    awaits,
    events,
    replies,
    polls,
    replyFailures,
    sessions,
    open,
    fire,
    settle,
    now: () => nowMs,
    advance: (ms: number) => {
      nowMs += ms;
      return nowMs;
    },
  };
}

/** A raw Telegram-shaped update; `text === undefined` makes a non-text message. */
const rawUpdate = (updateId: number, chatId: number | undefined, text?: string, withText = true) => ({
  update_id: updateId,
  ...(chatId === undefined
    ? {}
    : {
        message: {
          chat: { id: chatId },
          ...(withText ? { text } : { photo: [{ file_id: "x" }] }),
          from: { username: "alice" },
        },
      }),
});

/** Just the identity fields — createdAt is written by the bridge with its clock. */
const bindingsOf = (h: ReturnType<typeof harness>) =>
  readRegistry(h).chats.map((row) => ({ chatId: (row as { chatId: number }).chatId, sessionId: (row as { sessionId: string }).sessionId }));

const chatRow = (chatId: number, sessionId: string) => ({ chatId, sessionId, createdAt: "2026-10-01T00:00:00.000Z" });

const registry = (over: { offset?: number; chats?: unknown[]; codes?: unknown[] } = {}) =>
  `${JSON.stringify(
    { version: 1, offset: over.offset ?? 0, chats: over.chats ?? [], codes: over.codes ?? [] },
    null,
    2,
  )}\n`;

const readRegistry = (h: ReturnType<typeof harness>): { version: number; offset: number; chats: unknown[]; codes: unknown[] } =>
  JSON.parse(h.files.get(h.file)!);

test("bind mints an 8-hex single-use code that round-trips through the registry file", async () => {
  const h = harness();
  const bridge = await h.open();
  const first = await bridge.bind();
  assert.match(first.code, /^[0-9a-f]{8}$/);
  assert.equal(first.expiresAt, new Date(h.now() + CODE_TTL_MS).toISOString(), "10 minutes from mint");

  const disk = readRegistry(h);
  assert.equal(disk.version, 1);
  assert.equal(disk.offset, 0);
  assert.deepEqual(disk.codes, [
    { code: first.code, sessionId: "ses_alpha", createdAt: new Date(h.now()).toISOString(), expiresAt: first.expiresAt },
  ], "bind defaults to the first session the broker lists");

  h.advance(1_000);
  const second = await bridge.bind("ses_beta");
  assert.notEqual(second.code, first.code);
  assert.ok(h.files.has(h.backup), "the second mutation refreshes the .bak");
  assert.equal(JSON.parse(h.files.get(h.backup)!).codes.length, 1, "the .bak holds the previous good state");

  const reopened = await h.open();
  assert.equal(reopened.status().pendingCodes, 2, "codes survive a reopen");
  assert.deepEqual(reopened.sessions().map((s) => s.id), ["ses_alpha", "ses_beta"]);
});

test("a corrupt registry is moved aside and recovered from .bak", async () => {
  const h = harness();
  h.files.set(h.file, "{not json");
  h.files.set(h.backup, registry({ offset: 7, chats: [chatRow(42, "ses_beta")] }));

  const bridge = await h.open();
  assert.ok(h.warnings.some((w) => w.includes("unusable")), "corruption is warned, not silent");
  const aside = [...h.files.keys()].find((path) => path.includes(".corrupt-"));
  assert.ok(aside, "the corrupt bytes are kept");
  assert.equal(h.files.get(aside), "{not json");

  const disk = readRegistry(h);
  assert.equal(disk.offset, 7);
  assert.deepEqual(disk.chats, [chatRow(42, "ses_beta")], "recovered from .bak and rewritten over the corrupt main");

  const status = bridge.status();
  assert.equal(status.chats.length, 1);
  assert.equal(status.chats[0].sessionName, "beta", "names resolve through the broker");
});

test("a corrupt registry with no .bak starts empty but keeps the bad bytes", async () => {
  const h = harness();
  h.files.set(h.file, "]]]");
  const bridge = await h.open();
  assert.deepEqual(bridge.status().chats, []);
  assert.equal(readRegistry(h).offset, 0, "a fresh registry is written over the corrupt one");
  const aside = [...h.files.keys()].find((path) => path.includes(".corrupt-"));
  assert.ok(aside, "the corrupt bytes are kept");
  assert.equal(h.files.get(aside), "]]]");
  assert.ok(h.warnings.some((w) => w.includes("kept the unusable registry")));
});

test("/start with a good code binds the chat (case-insensitive) and spends the code", async () => {
  const h = harness();
  const bridge = await h.open();
  const { code } = await bridge.bind("ses_alpha");

  h.polls.push([rawUpdate(100, 4242, `/START ${code.toUpperCase()}`)]);
  bridge.start("TOKEN:secret");
  await h.fire();

  assert.deepEqual(h.replies, [{ chatId: 4242, text: "bound to alpha" }]);
  assert.ok(h.calls[0].url.includes("/botTOKEN:secret/getUpdates"), "the token rides in the path");
  assert.ok(h.calls[0].url.includes("timeout=25&offset=0"), "long poll with the stored offset");
  const disk = readRegistry(h);
  assert.equal(disk.offset, 101, "offset advanced past the update");
  assert.deepEqual(bindingsOf(h), [{ chatId: 4242, sessionId: "ses_alpha" }]);
  assert.deepEqual(disk.codes, [], "the code is single use");
  assert.equal(bridge.status().pendingCodes, 0);
  assert.equal(bridge.running, true, "the loop keeps going");
});

test("expired and unknown codes are refused", async () => {
  const h = harness();
  const bridge = await h.open();
  const { code } = await bridge.bind();
  h.advance(CODE_TTL_MS + 1);

  h.polls.push([rawUpdate(1, 4242, `/start ${code}`)]);
  bridge.start("TOKEN");
  await h.fire();

  assert.deepEqual(h.replies.map((r) => r.text), ["unknown or expired code"]);
  assert.deepEqual(readRegistry(h).chats, [], "an expired code binds nothing");
  assert.equal(bridge.status().pendingCodes, 0, "expired codes do not count as pending");

  h.polls.push([rawUpdate(2, 4242, "/start deadbeef")]);
  await h.fire();
  assert.deepEqual(h.replies.map((r) => r.text), ["unknown or expired code", "unknown or expired code"]);
});

test("a used code cannot bind a second chat", async () => {
  const h = harness();
  const bridge = await h.open();
  const { code } = await bridge.bind();

  h.polls.push([rawUpdate(1, 4242, `/start ${code}`)]);
  bridge.start("TOKEN");
  await h.fire();
  h.polls.push([rawUpdate(2, 99, `/start ${code}`)]);
  await h.fire();

  assert.deepEqual(h.replies.map((r) => r.text), ["bound to alpha", "unknown or expired code"]);
  assert.deepEqual(bindingsOf(h), [{ chatId: 4242, sessionId: "ses_alpha" }]);
});

test("/stop unbinds the chat and answers 'unbound'", async () => {
  const h = harness();
  h.files.set(h.file, registry({ chats: [chatRow(4242, "ses_alpha")] }));
  const bridge = await h.open();

  h.polls.push([rawUpdate(1, 4242, "/Stop")]);
  bridge.start("TOKEN");
  await h.fire();

  assert.deepEqual(h.replies.map((r) => r.text), ["unbound"]);
  assert.deepEqual(readRegistry(h).chats, []);
  assert.equal(bridge.status().chats.length, 0);
});

test("/status answers the bound session name or 'not bound'", async () => {
  const h = harness();
  h.files.set(h.file, registry({ chats: [chatRow(4242, "ses_beta")] }));
  const bridge = await h.open();

  h.polls.push([rawUpdate(1, 4242, "/status"), rawUpdate(2, 99, "/status")]);
  bridge.start("TOKEN");
  await h.fire();

  assert.deepEqual(h.replies.map((r) => r.text), ["beta", "not bound"]);
});

test("/session switches by id prefix, refuses unknown prefixes, and requires a binding", async () => {
  const h = harness();
  h.files.set(h.file, registry({ chats: [chatRow(4242, "ses_alpha")] }));
  const bridge = await h.open();

  h.polls.push([rawUpdate(1, 4242, "/session ses_be")]);
  bridge.start("TOKEN");
  await h.fire();
  h.polls.push([rawUpdate(2, 4242, "/session nope"), rawUpdate(3, 99, "/session ses_alpha")]);
  await h.fire();

  assert.deepEqual(h.replies.map((r) => r.text), ["beta", "no such session", "not bound"]);
  assert.deepEqual(readRegistry(h).chats, [chatRow(4242, "ses_beta")], "the prefix match won");
});

test("plain text from a bound chat reaches the session and the answer is replied", async () => {
  const h = harness();
  h.files.set(h.file, registry({ chats: [chatRow(4242, "ses_alpha")] }));
  const bridge = await h.open();

  h.polls.push([rawUpdate(5, 4242, "what is the weather?")]);
  bridge.start("TOKEN");
  await h.fire();

  assert.deepEqual(h.sent, [{ sessionId: "ses_alpha", text: "what is the weather?" }]);
  assert.deepEqual(h.awaits, [{ sessionId: "ses_alpha", submissionId: 1, timeoutMs: ANSWER_TIMEOUT_MS }]);
  assert.deepEqual(h.replies.map((r) => r.text), ["the answer"]);
  const sendMessage = h.calls.find((c) => c.url.includes("/sendMessage"))!;
  assert.equal(sendMessage.init?.method, "POST");
  assert.deepEqual(JSON.parse(sendMessage.init?.body as string), { chat_id: 4242, text: "the answer" });
});

test("plain text from an unbound chat is ignored — no submission, no reply", async () => {
  const h = harness();
  const bridge = await h.open();

  h.polls.push([rawUpdate(5, 777, "hello? anyone?")]);
  bridge.start("TOKEN");
  await h.fire();

  assert.deepEqual(h.sent, []);
  assert.deepEqual(h.replies, [], "an unbound stranger learns nothing");
  assert.equal(readRegistry(h).offset, 6, "the update is still acknowledged");
});

test("a failing broker turns into a short error reply and the loop survives", async () => {
  const h = harness();
  h.files.set(h.file, registry({ chats: [chatRow(4242, "ses_alpha")] }));
  const longError = `session ses_alpha is archived: ${"x".repeat(400)}`;
  const originalSend = h.broker.sendToSession;
  h.broker.sendToSession = async () => {
    throw new Error(longError);
  };
  const bridge = await h.open();

  h.polls.push([rawUpdate(1, 4242, "hi")]);
  bridge.start("TOKEN");
  await h.fire();

  const reply = h.replies.find((r) => r.chatId === 4242);
  assert.ok(reply, "the failure was answered");
  assert.ok(reply!.text.length <= 200, `error replies are capped, got ${reply!.text.length}`);
  assert.ok(reply!.text.startsWith("session ses_alpha is archived"));

  // The loop survived: the next update is handled normally.
  h.broker.sendToSession = originalSend;
  h.polls.push([rawUpdate(2, 4242, "again")]);
  await h.fire();
  assert.deepEqual(h.sent, [{ sessionId: "ses_alpha", text: "again" }]);
  assert.equal(bridge.running, true);
});

test("the offset is persisted before the update is handled", async () => {
  const h = harness();
  h.files.set(h.file, registry({ chats: [chatRow(4242, "ses_alpha")] }));
  const offsetsSeenByBroker: number[] = [];
  h.broker.sendToSession = async () => {
    offsetsSeenByBroker.push(readRegistry(h).offset);
    return { submissionId: 1 };
  };
  const bridge = await h.open();

  h.polls.push([rawUpdate(41, 4242, "ack me first")]);
  bridge.start("TOKEN");
  await h.fire();

  assert.deepEqual(offsetsSeenByBroker, [42], "the broker only ever sees an already-acknowledged registry");
  assert.equal(readRegistry(h).offset, 42);
});

test("poll failures back off 5s→10s→20s and success resets the ladder", async () => {
  const h = harness();
  h.files.set(h.file, registry({ chats: [chatRow(4242, "ses_beta")] }));
  const bridge = await h.open();

  h.polls.push(new Error("connect ECONNRESET"), new Error("connect ECONNRESET"), 500, [], [rawUpdate(1, 4242, "/status")], new Error("again"));
  bridge.start("TOKEN");
  await h.fire(); // 1st poll fails → 5s
  await h.fire(); // 2nd poll fails → 10s
  await h.fire(); // 3rd poll HTTP 500 → 20s
  await h.fire(); // 4th poll ok (empty) → pace
  await h.fire(); // 5th poll delivers /status → pace
  await h.fire(); // 6th poll fails → ladder was reset → 5s again

  assert.deepEqual(
    h.timers.map((t) => t.ms),
    [0, 5_000, 10_000, 20_000, 250, 250, 5_000],
    "start(0), backoff doubling from 5s, pace after success, reset after success",
  );
  assert.equal(h.warnings.filter((w) => w.includes("getUpdates failed")).length, 4);
  assert.deepEqual(h.replies.map((r) => r.text), ["beta"], "the loop resumed after the failures");
  assert.equal(bridge.running, true);
});

test("a rejected token (401) stops the loop with one warning", async () => {
  const h = harness();
  const bridge = await h.open();

  h.polls.push(401);
  bridge.start("bad-token");
  await h.fire();

  assert.equal(bridge.running, false);
  assert.deepEqual(
    h.warnings.filter((w) => w.includes("DPI_TELEGRAM_TOKEN rejected")),
    ["DPI_TELEGRAM_TOKEN rejected (HTTP 401) — the telegram bridge stopped; check the token"],
  );
  assert.deepEqual(h.timers.map((t) => t.ms), [0], "nothing is scheduled after the stop");
  assert.equal(h.calls.filter((c) => c.url.includes("/getUpdates")).length, 1, "no retry against a rejected token");
});

test("updates in one poll are handled strictly in order", async () => {
  const h = harness();
  h.files.set(h.file, registry({ chats: [chatRow(4242, "ses_alpha")] }));
  const bridge = await h.open();

  h.polls.push([rawUpdate(1, 4242, "first"), rawUpdate(2, 4242, "second")]);
  bridge.start("TOKEN");
  await h.fire();

  assert.deepEqual(h.events, ["send first", "answer 1", "reply the answer", "send second", "answer 2", "reply the answer"]);
  assert.equal(readRegistry(h).offset, 3);
});

test("non-message and non-text updates are acknowledged and ignored", async () => {
  const h = harness();
  h.files.set(h.file, registry({ chats: [chatRow(4242, "ses_alpha")] }));
  const bridge = await h.open();

  h.polls.push([
    rawUpdate(10, undefined), // edited_message/callback_query-shaped: no message
    rawUpdate(11, 4242, undefined, false), // a photo: a message without text
  ]);
  bridge.start("TOKEN");
  await h.fire();

  assert.deepEqual(h.sent, []);
  assert.deepEqual(h.replies, []);
  assert.equal(readRegistry(h).offset, 12, "both updates were acknowledged");
});

test("/help lists the commands", async () => {
  const h = harness();
  const bridge = await h.open();

  h.polls.push([rawUpdate(1, 99, "/help")]);
  bridge.start("TOKEN");
  await h.fire();

  const text = h.replies[0]?.text ?? "";
  assert.ok(text.includes("/start <code>") && text.includes("/session <prefix>") && text.includes("/stop"));
  assert.equal(h.replies.length, 1);
});

test("a failed sendMessage is warned and the loop continues", async () => {
  const h = harness();
  h.files.set(h.file, registry({ chats: [chatRow(4242, "ses_alpha")] }));
  const bridge = await h.open();

  h.replyFailures.push(true);
  h.polls.push([rawUpdate(1, 4242, "hi")], []);
  bridge.start("TOKEN");
  await h.fire();
  await h.fire();

  assert.ok(h.warnings.some((w) => w.includes("sendMessage to chat 4242 answered HTTP 500")));
  assert.deepEqual(h.sent, [{ sessionId: "ses_alpha", text: "hi" }], "the submission happened regardless");
  assert.equal(bridge.running, true);
});

test("flattenUpdates drops rows it cannot acknowledge and flattens the wire shape", () => {
  const updates = flattenUpdates([
    { update_id: 1.7, message: { chat: { id: 42.2 }, text: "hi", from: { username: "alice" } } },
    { update_id: "x" },
    null,
    { update_id: 2, message: { chat: { id: 7 }, photo: [] } },
    { update_id: 3, message: { chat: { id: 8 }, text: "hey", from: { first_name: "Bo" } } },
  ]);
  assert.deepEqual(updates, [
    { updateId: 1, message: { chatId: 42, text: "hi", from: "alice" } },
    { updateId: 2 },
    { updateId: 3, message: { chatId: 8, text: "hey", from: "Bo" } },
  ]);
});

test("the default io writes 0600 files inside a 0700 parent (real fs)", async () => {
  const io = defaultTelegramIo();
  const root = await mkdtemp(join(tmpdir(), "dpi-telegram-"));
  try {
    const path = join(root, "backend", "telegram.json");
    await io.writeFile(path, '{"version":1}\n');
    assert.equal(await io.readFile(path), '{"version":1}\n');
    if (process.platform !== "win32") {
      assert.equal((await stat(path)).mode & 0o777, 0o600);
      assert.equal((await stat(join(root, "backend"))).mode & 0o777, 0o700);
    }
    assert.equal(await io.exists(path), true);
    assert.equal(await io.exists(join(root, "nope")), false);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
