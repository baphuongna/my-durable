/**
 * Device-side Telegram channel bridge — "Telegram channel bridge", Wave 3
 * (SHOULD) of docs/host-project-checklist.md.
 *
 * A Telegram chat bound to a device session: plain text the operator types
 * becomes a submission to that session's main agent, and the agent's answer
 * comes back as a Telegram reply. Modelled on zcode's
 * `packages/services/src/bots/telegramChannelRuntime.ts` (a channel message
 * routed into an existing session-submission surface). The adaptation is the
 * binding itself — zcode's channel knows its session by configuration, while a
 * dpi device has many sessions, so a chat is bound to one at a time with a
 * single-use `/start <code>` (minted by `dpi telegram bind`, 10-minute expiry)
 * and can switch with `/session <id-prefix>`.
 *
 * Discipline, in the order the checklist cares about it:
 *  - **Acknowledge before handle.** The update offset is advanced and persisted
 *    *before* an update is handled, so a crash re-delivers at worst one update
 *    and never re-runs a turn. If that persist fails, the update is skipped and
 *    re-delivered by the next poll rather than handled on an unadvanced offset.
 *  - **A stranger learns nothing.** Plain text from an unbound chat is dropped
 *    silently — no usage hint, no error, no ack — because the only thing a
 *    random person who found the bot should take away is that it says nothing.
 *  - **Nothing here can kill a session turn or the loop.** Every update handler
 *    runs inside a catch-all, replies are best-effort (`sendMessage` failures
 *    are warned, never thrown), and a rejected token (401/404) stops the loop
 *    instead of spinning it against a wall of 4xx.
 *  - **The registry file is the truth.** Same handling as `notify-sinks.ts`:
 *    versioned JSON, 0600, `.bak` rolling backup, an unreadable file moved
 *    aside with a warning instead of overwritten, serialized mutations.
 *
 * Everything that touches a session goes through `TelegramBroker` — the daemon
 * wires that to the Store; this module never imports it. Everything that
 * touches the world (fs, clock, fetch, timers) goes through `TelegramIo`, so
 * the tests run against fakes with zero sockets and zero real time.
 */
import { randomBytes } from "node:crypto";
import { chmod, mkdir, readFile, rename, stat, unlink, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";

/** Bumped only when the on-disk shape changes; `coerceRegistry` owns the upgrade path. */
export const TELEGRAM_REGISTRY_VERSION = 1;

/** A bind code is typed by a human on a phone; ten minutes is generous and still bounded. */
export const CODE_TTL_MS = 10 * 60_000;
/** How long the bridge waits for a turn to settle before answering "no answer". */
export const ANSWER_TIMEOUT_MS = 120_000;
/** The agent's failure text is a Telegram message; past this it is a pasted stack trace. */
export const MAX_REPLY_ERROR_LENGTH = 200;
/** First retry gap after a failed poll; doubles from there. */
export const BACKOFF_FIRST_MS = 5_000;
/** Backoff ceiling — an hour-long outage should not mean hour-long silence either. */
export const BACKOFF_MAX_MS = 60_000;

/** Telegram's own long-poll window, in seconds, echoed into the request URL. */
const POLL_TIMEOUT_S = 25;
/** Long poll holds ~25s; the fetch deadline must be comfortably past it. */
const POLL_FETCH_TIMEOUT_MS = 35_000;
/** A reply is one small POST. */
const SEND_TIMEOUT_MS = 10_000;
/** Gap between two *successful* polls: the long poll paces itself, this only stops a hot spin against a broken proxy. */
const POLL_PACE_MS = 250;

/** Codes are minted as 8 lowercase hex characters. */
const CODE_PATTERN = /^[0-9a-f]{8}$/;

/**
 * One Telegram update, flattened from the wire shape (`update_id`,
 * `message.chat.id`, `message.text`, `message.from.username`). Non-message and
 * non-text updates arrive with `message` absent: they are acknowledged (offset
 * advanced) and otherwise ignored.
 */
export interface TelegramUpdate {
  updateId: number;
  message?: {
    chatId: number;
    text: string;
    from?: string;
    /** Audit run-1: the sender's STABLE Telegram id (usernames are mutable). */
    fromId?: number;
    /** Audit run-1: chat.type from the wire — "private" vs group/supergroup/channel. */
    chatType?: string;
  };
}

/**
 * The sliver of the world this module touches. `writeFile` is the atomic-write
 * seam: the default io writes temp (0600) → rename, so a reader sees the old
 * bytes or the complete new ones, and creates missing parent dirs 0700 (the
 * private-dir rule) — which keeps the whole module fake-able with a `Map`.
 */
export interface TelegramIo {
  fetch(
    url: string,
    init?: { method?: string; headers?: Record<string, string>; body?: string; signal?: AbortSignal },
  ): Promise<{ ok: boolean; status: number; json(): Promise<unknown> }>;
  readFile(path: string): Promise<string>;
  writeFile(path: string, data: string): Promise<void>;
  chmod(path: string, mode: number): Promise<void>;
  exists(path: string): Promise<boolean>;
  now(): number;
  /** Returns an unref-able handle, so the bridge never holds the event loop open. */
  setTimeout(cb: () => void, ms: number): { unref(): void };
  clearTimeout(t: { unref(): void }): void;
}

export const defaultTelegramIo = (): TelegramIo => ({
  fetch: async (url, init) => fetch(url, init as RequestInit | undefined),
  readFile: (path) => readFile(path, "utf8"),
  writeFile: async (path, data) => {
    // 0600, temp+rename (atomic within the directory), parents 0700.
    await mkdir(dirname(path), { recursive: true, mode: 0o700 });
    const temp = `${path}.tmp-${process.pid}-${randomBytes(4).toString("hex")}`;
    try {
      await writeFile(temp, data, { encoding: "utf8", mode: 0o600 });
      await chmod(temp, 0o600); // umask can only make this stricter, but be explicit
      await rename(temp, path);
      await chmod(path, 0o600);
    } catch (error) {
      await unlink(temp).catch(() => undefined);
      throw error;
    }
  },
  chmod: (path, mode) => chmod(path, mode),
  exists: async (path) => {
    try {
      await stat(path);
      return true;
    } catch {
      return false;
    }
  },
  now: () => Date.now(),
  setTimeout: (cb, ms) => setTimeout(cb, ms),
  clearTimeout: (t) => clearTimeout(t as NodeJS.Timeout),
});

/**
 * Everything that touches a session goes through this seam — the daemon wires it
 * to the Store. The bridge never learns how a submission becomes an answer; it
 * only submits, waits (bounded), and replies.
 */
export interface TelegramBroker {
  /** Sessions the `/session` command may switch to, and `bind`'s default target. */
  listSessions(): Array<{ id: string; name: string }>;
  /** Submit text to the bound session's main agent. Throws only on an invalid session. */
  sendToSession(sessionId: string, text: string): Promise<{ submissionId: number }>;
  /**
   * Wait for a turn to settle and return the agent's answer text (or undefined
   * when it did not settle inside `timeoutMs`). The broker implements the
   * polling; the bridge only calls it with a bounded timeout.
   */
  awaitAnswer(sessionId: string, submissionId: number, timeoutMs: number): Promise<string | undefined>;
}

/** One chat bound to one session. */
export interface TelegramChatBinding {
  chatId: number;
  sessionId: string;
  /** ISO. When this binding was made. */
  createdAt: string;
  /** Audit run-1: the /start sender's stable Telegram id — only that sender may
   * act on this binding. Absent on legacy rows (treated as chat-wide until re-bound). */
  boundFromId?: number;
}

/** One minted `/start` code. `sessionId` is the session the code grants (the CLI's default is the first session). */
export interface TelegramBindCode {
  code: string;
  sessionId?: string;
  /** ISO. */
  createdAt: string;
  /** ISO; after this the code is refused and pruned. */
  expiresAt: string;
}

/** The on-disk document. `version` exists so a future shape can be migrated, not discarded. */
export interface TelegramRegistryFile {
  version: number;
  /** The next `offset` for getUpdates — Telegram's acknowledgement cursor. */
  offset: number;
  chats: TelegramChatBinding[];
  codes: TelegramBindCode[];
}

export type TelegramBridgeErrorCode = "invalid";

/** Typed failure for the mutation paths (`bind`) so a UI can answer without string matching. */
export class TelegramBridgeError extends Error {
  readonly code: TelegramBridgeErrorCode;

  constructor(code: TelegramBridgeErrorCode, message: string) {
    super(message);
    this.name = "TelegramBridgeError";
    this.code = code;
  }
}

export interface TelegramBridgeOptions {
  /** Where recovery / poll / delivery notices go. Defaults to `console.warn`. */
  warn?: (message: string, error?: unknown) => void;
  /** Injectable clock (epoch ms) — tests pin code expiry instead of sleeping. */
  now?: () => number;
}

const defaultWarn = (message: string, error?: unknown): void =>
  console.warn(`[telegram] ${message}`, error === undefined ? "" : describeError(error));

const describeError = (error: unknown): string => (error instanceof Error ? error.message : String(error));

const truncate = (text: string, max: number): string => (text.length > max ? `${text.slice(0, max - 1)}…` : text);

/** What `/help` sends. Commands only — no session names, no device details. */
const CHAT_HELP = `dpi telegram commands:
  /start <code>      bind this chat to a session (code from "dpi telegram bind")
  /stop              unbind this chat
  /status            which session this chat is bound to
  /session <prefix>  switch to another session by id prefix
  /help              this list

Anything else you type goes to the bound session's agent.`;

/** 8 lowercase hex: short enough to type on a phone, wide enough not to be guessable. */
export function mintCode(): string {
  return randomBytes(4).toString("hex");
}

const isoTime = (epochMs: number): string => new Date(epochMs).toISOString();

/**
 * Telegram's `result` array → flattened updates. Rows without a usable
 * `update_id` are dropped (they cannot be acknowledged, so they must not be
 * handled either); messages without text (photos, stickers) flatten to a bare
 * update and are ignored downstream.
 */
export function flattenUpdates(rows: readonly unknown[]): TelegramUpdate[] {
  const out: TelegramUpdate[] = [];
  for (const row of rows) {
    if (row === null || typeof row !== "object") continue;
    const source = row as Record<string, unknown>;
    const updateId = source.update_id;
    if (typeof updateId !== "number" || !Number.isFinite(updateId)) continue;
    let message: TelegramUpdate["message"];
    const raw = source.message;
    if (raw !== null && typeof raw === "object") {
      const msg = raw as Record<string, unknown>;
      const chat = msg.chat;
      const chatId = chat !== null && typeof chat === "object" ? (chat as Record<string, unknown>).id : undefined;
      if (typeof msg.text === "string" && typeof chatId === "number" && Number.isFinite(chatId)) {
        const from = msg.from;
        let fromName: string | undefined;
        let fromId: number | undefined;
        if (from !== null && typeof from === "object") {
          const f = from as Record<string, unknown>;
          fromName =
            typeof f.username === "string" && f.username
              ? f.username
              : typeof f.first_name === "string" && f.first_name
                ? f.first_name
                : undefined;
          if (typeof f.id === "number" && Number.isFinite(f.id)) fromId = Math.trunc(f.id);
        }
        const chatType =
          chat !== null && typeof chat === "object" && typeof (chat as Record<string, unknown>).type === "string"
            ? ((chat as Record<string, unknown>).type as string)
            : undefined;
        message = {
          chatId: Math.trunc(chatId),
          text: msg.text,
          ...(fromName ? { from: fromName } : {}),
          ...(fromId !== undefined ? { fromId } : {}),
          ...(chatType ? { chatType } : {}),
        };
      }
    }
    out.push({ updateId: Math.trunc(updateId), ...(message ? { message } : {}) });
  }
  return out;
}

/** Strict enough to refuse a newer build's file, lenient enough to keep a hand-edited row's siblings. */
function coerceRegistry(raw: unknown, now: number): TelegramRegistryFile {
  if (raw === null || raw === undefined || typeof raw !== "object") throw new Error("registry is not a JSON object");
  const file = raw as Record<string, unknown>;
  const version = file.version;
  if (version !== undefined && version !== null && version !== TELEGRAM_REGISTRY_VERSION) {
    throw new Error(`unsupported telegram registry version ${String(version)}`);
  }
  const offset =
    typeof file.offset === "number" && Number.isFinite(file.offset) && file.offset >= 0 ? Math.floor(file.offset) : 0;

  const chats: TelegramChatBinding[] = [];
  if (file.chats !== undefined && file.chats !== null) {
    if (!Array.isArray(file.chats)) throw new Error("registry `chats` is not a list");
    for (const row of file.chats) {
      if (row === null || typeof row !== "object") continue;
      const source = row as Record<string, unknown>;
      if (typeof source.chatId !== "number" || !Number.isFinite(source.chatId)) continue;
      if (typeof source.sessionId !== "string" || !source.sessionId.trim()) continue;
      const createdAt =
        typeof source.createdAt === "string" && Number.isFinite(Date.parse(source.createdAt))
          ? source.createdAt
          : isoTime(now);
      const boundFromId =
        typeof source.boundFromId === "number" && Number.isFinite(source.boundFromId)
          ? Math.trunc(source.boundFromId)
          : undefined;
      chats.push({
        chatId: Math.trunc(source.chatId),
        sessionId: source.sessionId,
        createdAt,
        ...(boundFromId !== undefined ? { boundFromId } : {}),
      });
    }
  }

  const codes: TelegramBindCode[] = [];
  if (file.codes !== undefined && file.codes !== null) {
    if (!Array.isArray(file.codes)) throw new Error("registry `codes` is not a list");
    for (const row of file.codes) {
      if (row === null || typeof row !== "object") continue;
      const source = row as Record<string, unknown>;
      if (typeof source.code !== "string" || !CODE_PATTERN.test(source.code.toLowerCase())) continue;
      if (typeof source.expiresAt !== "string" || !Number.isFinite(Date.parse(source.expiresAt))) continue;
      const sessionId = typeof source.sessionId === "string" && source.sessionId.trim() ? source.sessionId : undefined;
      const createdAt =
        typeof source.createdAt === "string" && Number.isFinite(Date.parse(source.createdAt))
          ? source.createdAt
          : isoTime(now);
      codes.push({
        code: source.code.toLowerCase(),
        ...(sessionId ? { sessionId } : {}),
        createdAt,
        expiresAt: source.expiresAt,
      });
    }
  }

  return { version: TELEGRAM_REGISTRY_VERSION, offset, chats, codes };
}

/**
 * The Telegram side of the bridge: one registry file, one long-poll loop, one
 * chat-to-session binding at a time.
 *
 * The loop is started with `start(token)` and stopped with `stop()` or by
 * Telegram rejecting the token; timers are unref'd, so a running bridge never
 * keeps the process alive on its own. `open` never throws — an unreadable
 * registry is recovered from `.bak` or started empty, with a warning either way.
 * Mutations are serialized (notify-sinks' `run` queue) so the poll's offset
 * write cannot interleave with a CLI `bind`.
 */
export class TelegramBridge {
  /** Absolute path of the main JSON file. */
  readonly filePath: string;
  /** The rolling backup restored by `open` when `filePath` is unusable. */
  readonly backupPath: string;

  private readonly io: TelegramIo;
  private readonly broker: TelegramBroker;
  private readonly warn: (message: string, error?: unknown) => void;
  private readonly now: () => number;
  private offset = 0;
  private chats: TelegramChatBinding[] = [];
  private codes: TelegramBindCode[] = [];
  /** False until a good file is read or written: while false, `.bak` must not be refreshed from a bad main. */
  private mainIsGood = false;
  private runningValue = false;
  private token?: string;
  private timer?: { unref(): void };
  private backoffMs = 0;
  private queue: Promise<unknown> = Promise.resolve();

  private constructor(filePath: string, io: TelegramIo, broker: TelegramBroker, options: TelegramBridgeOptions) {
    this.filePath = resolve(filePath);
    this.backupPath = `${this.filePath}.bak`;
    this.io = io;
    this.broker = broker;
    this.warn = options.warn ?? defaultWarn;
    this.now = options.now ?? (() => this.io.now());
  }

  /** Load the registry (or recover), never throwing: a broken file must not break the device. */
  static async open(
    filePath: string,
    io: TelegramIo,
    broker: TelegramBroker,
    options: TelegramBridgeOptions = {},
  ): Promise<TelegramBridge> {
    const bridge = new TelegramBridge(filePath, io, broker, options);
    try {
      await bridge.load();
    } catch (error) {
      bridge.warn(`could not load ${bridge.filePath}: ${describeError(error)}`, error);
    }
    return bridge;
  }

  /** True while the poll loop is scheduled or in flight. */
  /** Last registry text this process loaded or wrote (R15 h14 foreign-writer sync). */
  private registryText: string | null = null;
  get running(): boolean {
    return this.runningValue;
  }

  /** Begin polling if not already; a second `start` (even with a new token) changes nothing. */
  start(token: string): void {
    if (this.runningValue) return;
    this.token = token;
    this.runningValue = true;
    this.backoffMs = 0;
    this.schedule(0);
  }

  /** Stop the loop and clear the pending timer. Safe to call when stopped. */
  stop(): void {
    this.runningValue = false;
    this.clearTimer();
  }

  /**
   * The bridge's own state, for `dpi telegram status`. Session names resolve
   * through the broker; a session the broker no longer lists falls back to its
   * id (the binding stays — the operator may just have the daemon down).
   */
  status(): {
    running: boolean;
    chats: Array<{ chatId: number; sessionId: string; sessionName?: string }>;
    pendingCodes: number;
  } {
    const sessions = this.safeListSessions();
    const now = this.now();
    return {
      running: this.runningValue,
      chats: this.chats.map((binding) => {
        const found = sessions.find((session) => session.id === binding.sessionId);
        return {
          chatId: binding.chatId,
          sessionId: binding.sessionId,
          ...(found ? { sessionName: found.name } : {}),
        };
      }),
      pendingCodes: this.codes.filter((code) => Date.parse(code.expiresAt) > now).length,
    };
  }

  /**
   * Mint a single-use bind code into the registry. Without `sessionId` the
   * code targets the first session the broker lists — or none at all when the
   * broker has no sessions to name (the CLI minting while the daemon is down),
   * in which case `/start` resolves "first session" against the *live* broker
   * when the code is spent. An explicit `sessionId` that the broker does not
   * list throws `TelegramBridgeError`; a failed registry write rejects, leaving
   * the registry exactly as it was.
   */
  async bind(sessionId?: string): Promise<{ code: string; expiresAt: string }> {
    const sessions = this.safeListSessions();
    let targetId: string | undefined;
    if (sessionId === undefined) {
      targetId = sessions[0]?.id;
    } else {
      if (!sessions.some((session) => session.id === sessionId)) {
        throw new TelegramBridgeError("invalid", `no session ${sessionId}`);
      }
      targetId = sessionId;
    }
    return this.run(async () => {
      const now = this.now();
      const draft = this.snapshot();
      draft.codes = draft.codes.filter((code) => Date.parse(code.expiresAt) > now); // prune the dead ones
      let code = mintCode();
      while (draft.codes.some((row) => row.code === code)) code = mintCode();
      const record: TelegramBindCode = {
        code,
        ...(targetId ? { sessionId: targetId } : {}),
        createdAt: isoTime(now),
        expiresAt: isoTime(now + CODE_TTL_MS),
      };
      draft.codes.push(record);
      await this.persist(draft);
      this.adopt(draft);
      return { code: record.code, expiresAt: record.expiresAt };
    });
  }

  /** Remove the first binding whose chat id starts with `chatPrefix`; returns the chat id, or undefined when none matched. */
  async unbind(chatPrefix: string): Promise<number | undefined> {
    return this.run(async () => {
      const draft = this.snapshot();
      const hit = draft.chats.find((binding) => String(binding.chatId).startsWith(chatPrefix));
      if (hit === undefined) return undefined;
      draft.chats = draft.chats.filter((binding) => binding !== hit);
      await this.persist(draft);
      this.adopt(draft);
      return hit.chatId;
    });
  }

  /** The sessions a chat can switch between (the broker's answer, copied). */
  sessions(): Array<{ id: string; name: string }> {
    return this.safeListSessions().map((session) => ({ ...session }));
  }

  // ------------------------------------------------------------- load/persist

  /**
   * Main → `.bak` → empty, the notify-sinks ladder. An unusable main is copied
   * to `<file>.corrupt-<ts>` (kept, never deleted) and, when the copy landed,
   * overwritten with the recovered state so the next boot does not re-recover.
   */
  private async load(): Promise<void> {
    const main = await this.readRegistry(this.filePath);
    if (main.ok) {
      this.adopt(main.file);
      this.registryText = main.text ?? null;
      this.mainIsGood = true;
      return;
    }
    if (main.missing) return; // fresh device: nothing configured yet, nothing to complain about

    this.warn(`${this.filePath} is unusable (${describeError(main.error)}); moving it aside`);
    const keptAside = main.text === undefined ? false : await this.keepCorruptCopy(main.text);
    const backup = await this.readRegistry(this.backupPath);
    const recovered = backup.ok
      ? backup.file
      : ({ version: TELEGRAM_REGISTRY_VERSION, offset: 0, chats: [], codes: [] } satisfies TelegramRegistryFile);
    this.adopt(recovered);
    if (backup.ok) this.warn(`recovered ${backup.file.chats.length} chat binding(s) from ${this.backupPath}`);
    else if (!backup.missing) this.warn(`${this.backupPath} is unusable too; starting with an empty registry`);

    if (!keptAside) {
      this.warn(`${this.filePath} was left untouched — fix or remove it before the next change`);
      return;
    }
    try {
      await this.run(async () => {
        await this.persist(recovered);
      });
    } catch (error) {
      this.warn(`could not rewrite ${this.filePath} after recovery`, error);
    }
  }

  private async readRegistry(
    path: string,
  ): Promise<
    { ok: true; file: TelegramRegistryFile; text?: string } | { ok: false; missing: boolean; text?: string; error?: unknown }
  > {
    if (!(await this.io.exists(path))) return { ok: false, missing: true };
    let text: string;
    try {
      text = await this.io.readFile(path);
    } catch (error) {
      return { ok: false, missing: false, error };
    }
    try {
      return { ok: true, file: coerceRegistry(JSON.parse(text), this.now()), text };
    } catch (error) {
      return { ok: false, missing: false, text, error };
    }
  }

  /** Keep the unusable bytes somewhere a human can inspect; false when even that failed. */
  private async keepCorruptCopy(text: string): Promise<boolean> {
    const aside = `${this.filePath}.corrupt-${this.now()}`;
    try {
      await this.io.writeFile(aside, text);
      await this.io.chmod(aside, 0o600);
      this.warn(`kept the unusable registry as ${aside}`);
      return true;
    } catch (error) {
      this.warn(`could not keep a copy at ${aside}`, error);
      return false;
    }
  }

  private snapshot(): TelegramRegistryFile {
    return {
      version: TELEGRAM_REGISTRY_VERSION,
      offset: this.offset,
      chats: this.chats.map((binding) => ({ ...binding })),
      codes: this.codes.map((code) => ({ ...code })),
    };
  }

  private adopt(file: TelegramRegistryFile): void {
    this.offset = file.offset;
    this.chats = file.chats.map((binding) => ({ ...binding }));
    this.codes = file.codes.map((code) => ({ ...code }));
  }

  /**
   * R15 (run-2 h14): the `dpi telegram` CLI is a designed second writer of the
   * registry file. Before authorizing ANY update, re-read the file and adopt
   * foreign changes (bindings removed/added by the CLI, its minted codes), so
   * a revocation takes effect on the live bridge and is never resurrected by
   * the next offset persist. The ack offset only ever moves forward.
   */
  private async syncForeign(): Promise<void> {
    try {
      if (!(await this.io.exists(this.filePath))) return;
      const text = await this.io.readFile(this.filePath);
      if (text === this.registryText) return; // still our own last write
      const file = coerceRegistry(JSON.parse(text), this.now());
      this.adopt({ ...file, offset: Math.max(this.offset, file.offset) });
      this.registryText = text;
    } catch (error) {
      // Best-effort: an unreadable/unparseable file keeps the in-memory state.
      this.warn(`could not re-read ${this.filePath} before dispatch`, error);
    }
  }

  /** Stage → persist → swap. A failed write leaves memory exactly as it was. */
  private commit(apply: (draft: TelegramRegistryFile) => void): Promise<void> {
    return this.run(async () => {
      const draft = this.snapshot();
      apply(draft);
      await this.persist(draft);
      this.adopt(draft);
    });
  }

  private run<T>(task: () => Promise<T>): Promise<T> {
    const started = this.queue.then(task, task);
    // Swallow the rejection on the chain only; the caller still sees it.
    this.queue = started.then(
      () => undefined,
      () => undefined,
    );
    return started;
  }

  /**
   * `.bak` refreshed from the current good main first (best effort), then the
   * new bytes through the io's atomic write, then 0600.
   */
  private async persist(draft: TelegramRegistryFile): Promise<void> {
    if (this.mainIsGood && (await this.io.exists(this.filePath))) {
      try {
        const previous = await this.io.readFile(this.filePath);
        await this.io.writeFile(this.backupPath, previous);
        await this.io.chmod(this.backupPath, 0o600);
      } catch (error) {
        this.warn(`could not refresh ${this.backupPath}`, error);
      }
    }
    const payload = `${JSON.stringify(draft satisfies TelegramRegistryFile, null, 2)}\n`;
    await this.io.writeFile(this.filePath, payload);
    await this.io.chmod(this.filePath, 0o600);
    this.registryText = payload;
    this.mainIsGood = true;
  }

  // --------------------------------------------------------------- poll loop

  private schedule(ms: number): void {
    this.clearTimer();
    const timer = this.io.setTimeout(() => {
      this.timer = undefined;
      void this.poll();
    }, ms);
    timer.unref(); // a bridge timer must never hold the process open
    this.timer = timer;
  }

  private clearTimer(): void {
    if (this.timer === undefined) return;
    const timer = this.timer;
    this.timer = undefined;
    this.io.clearTimeout(timer);
  }

  private api(method: string): string {
    return `https://api.telegram.org/bot${this.token}/${method}`;
  }

  /**
   * One long poll: fetch, walk the updates in order, schedule the next one.
   * Errors back off 5s→10s→…→60s; success resets the ladder. A 401/404 (bad
   * token) stops the loop instead of retrying — retrying a rejected token is
   * just noise with an API call attached.
   */
  private async poll(): Promise<void> {
    if (!this.runningValue || this.token === undefined) return;
    try {
      const res = await this.io.fetch(`${this.api("getUpdates")}?timeout=${POLL_TIMEOUT_S}&offset=${this.offset}`, {
        method: "GET",
        signal: AbortSignal.timeout(POLL_FETCH_TIMEOUT_MS),
      });
      if (res.status === 401 || res.status === 404) {
        this.warn(`DPI_TELEGRAM_TOKEN rejected (HTTP ${res.status}) — the telegram bridge stopped; check the token`);
        this.stop();
        return;
      }
      if (!res.ok) throw new Error(`getUpdates answered HTTP ${res.status}`);
      const body = (await res.json()) as { ok?: unknown; result?: unknown };
      if (body === null || typeof body !== "object" || body.ok !== true || !Array.isArray(body.result)) {
        throw new Error("getUpdates did not answer an ok result list");
      }
      this.backoffMs = 0;
      for (const update of flattenUpdates(body.result)) {
        if (!this.runningValue) return; // stopped mid-batch (bad token, stop()): drop the rest
        try {
          await this.handle(update);
        } catch (error) {
          // Includes a failed offset persist: the update is re-delivered by the
          // next poll, which is the safe direction to err in.
          this.warn(`update ${update.updateId} was not handled: ${describeError(error)}`, error);
        }
      }
    } catch (error) {
      this.backoffMs = this.backoffMs === 0 ? BACKOFF_FIRST_MS : Math.min(this.backoffMs * 2, BACKOFF_MAX_MS);
      this.warn(`getUpdates failed (${describeError(error)}); retrying in ${this.backoffMs / 1000}s`, error);
      if (this.runningValue) this.schedule(this.backoffMs);
      return;
    }
    if (this.runningValue) this.schedule(POLL_PACE_MS);
  }

  /** Acknowledge first (persist the new offset), then handle. Never both-half-heartedly. */
  private async handle(update: TelegramUpdate): Promise<void> {
    await this.syncForeign();
    await this.commit((draft) => {
      draft.offset = Math.max(draft.offset, update.updateId + 1);
    });
    if (!update.message) return; // non-message or non-text: acknowledged, ignored
    await this.dispatch(
      update.message.chatId,
      update.message.from,
      update.message.text,
      update.message.fromId,
      update.message.chatType,
    );
  }

  /**
   * One message. Commands are exact (case-insensitive) matches; everything else
   * is plain text — including unknown `/words`, which the bound agent can
   * answer better than a canned "unknown command".
   */
  private async dispatch(
    chatId: number,
    _from: string | undefined,
    rawText: string,
    fromId?: number,
    chatType?: string,
  ): Promise<void> {
    const text = rawText.trim();
    const lower = text.toLowerCase();

    if (lower === "/help") {
      await this.reply(chatId, CHAT_HELP);
      return;
    }
    const binding = this.bindingOf(chatId);
    // Audit run-1 (sender binding): a chat container is not a principal — every
    // member of a group shares one chatId, including members added after the
    // bind. When the binding pinned the /start sender's stable id, only that
    // sender may act on it; anyone else's messages are dropped like a
    // stranger's (they learn nothing and change nothing).
    const senderAllowed = binding?.boundFromId === undefined || binding.boundFromId === fromId;
    if (!senderAllowed) return;
    if (lower === "/stop") {
      await this.commit((draft) => {
        draft.chats = draft.chats.filter((row) => row.chatId !== chatId);
      });
      await this.reply(chatId, "unbound");
      return;
    }
    if (lower === "/status") {
      await this.reply(chatId, binding ? this.sessionNameOf(binding.sessionId) : "not bound");
      return;
    }
    if (lower === "/start" || lower.startsWith("/start ")) {
      await this.cmdStart(chatId, text, fromId, chatType);
      return;
    }
    if (lower === "/session" || lower.startsWith("/session ")) {
      await this.cmdSession(chatId, text);
      return;
    }

    if (!binding) return; // unbound chat: drop silently — a stranger learns nothing
    try {
      const { submissionId } = await this.broker.sendToSession(binding.sessionId, text);
      const answer = await this.broker.awaitAnswer(binding.sessionId, submissionId, ANSWER_TIMEOUT_MS);
      await this.reply(chatId, answer && answer.trim() ? answer : "no answer within 2 minutes");
    } catch (error) {
      await this.reply(chatId, truncate(describeError(error), MAX_REPLY_ERROR_LENGTH));
    }
  }

  /** `/start <code>`: single-use, 10-minute code → bind this chat to the code's session. */
  private async cmdStart(
    chatId: number,
    text: string,
    fromId: number | undefined,
    chatType: string | undefined,
  ): Promise<void> {
    // Audit run-1 (chat-type gate): a non-private chat id is shared by every
    // current and future member — binding it would hand all of them the
    // operator's agent authority. Refuse; the operator binds from their own
    // private chat with the bot.
    if (chatType && chatType !== "private") {
      await this.reply(
        chatId,
        "this is not a private chat — every member would inherit the binding; run /start from a private chat with the bot",
      );
      return;
    }
    const code = text.slice("/start".length).trim().toLowerCase();
    const now = this.now();
    const hit = CODE_PATTERN.test(code) ? this.codes.find((row) => row.code === code && Date.parse(row.expiresAt) > now) : undefined;
    const sessionId = hit?.sessionId ?? (hit ? this.safeListSessions()[0]?.id : undefined);
    if (!sessionId) {
      await this.reply(chatId, "unknown or expired code");
      return;
    }
    await this.commit((draft) => {
      draft.codes = draft.codes.filter((row) => row.code !== code); // single use, spent now
      draft.chats = [
        ...draft.chats.filter((binding) => binding.chatId !== chatId),
        {
          chatId,
          sessionId,
          createdAt: isoTime(now),
          // Pin the ceremony sender (audit run-1): stable id, not the mutable username.
          ...(fromId !== undefined ? { boundFromId: fromId } : {}),
        },
      ];
    });
    await this.reply(chatId, `bound to ${this.sessionNameOf(sessionId)}`);
  }

  /** `/session <prefix>`: switch the *bound* chat to the first session whose id starts with the prefix. */
  private async cmdSession(chatId: number, text: string): Promise<void> {
    if (!this.bindingOf(chatId)) {
      await this.reply(chatId, "not bound");
      return;
    }
    const prefix = text.slice("/session".length).trim();
    const target = this.safeListSessions().find((session) => session.id.startsWith(prefix));
    if (!target) {
      await this.reply(chatId, "no such session");
      return;
    }
    await this.commit((draft) => {
      const row = draft.chats.find((binding) => binding.chatId === chatId);
      if (row) row.sessionId = target.id;
    });
    await this.reply(chatId, target.name);
  }

  /** Best-effort reply: a failed sendMessage is warned and forgotten — the turn already happened. */
  private async reply(chatId: number, text: string): Promise<void> {
    if (this.token === undefined) return;
    try {
      const res = await this.io.fetch(this.api("sendMessage"), {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ chat_id: chatId, text }),
        signal: AbortSignal.timeout(SEND_TIMEOUT_MS),
      });
      if (!res.ok) this.warn(`sendMessage to chat ${chatId} answered HTTP ${res.status}`);
    } catch (error) {
      this.warn(`sendMessage to chat ${chatId} failed: ${describeError(error)}`, error);
    }
  }

  // ----------------------------------------------------------------- helpers

  private bindingOf(chatId: number): TelegramChatBinding | undefined {
    return this.chats.find((binding) => binding.chatId === chatId);
  }

  /** The name a human reads; a session the broker no longer lists falls back to its id. */
  private sessionNameOf(sessionId: string): string {
    return this.safeListSessions().find((session) => session.id === sessionId)?.name ?? sessionId;
  }

  /** The broker is injected; a broken one must degrade to "no sessions", not kill the loop. */
  private safeListSessions(): Array<{ id: string; name: string }> {
    try {
      return this.broker.listSessions().map((session) => ({ id: String(session.id), name: String(session.name) }));
    } catch (error) {
      this.warn(`listSessions failed: ${describeError(error)}`, error);
      return [];
    }
  }
}
