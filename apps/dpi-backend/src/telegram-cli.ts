/**
 * `dpi telegram` — bind a Telegram chat to a device session (checklist Wave 3).
 *
 * Same shape as `dpi backup`: the CLI edits the device's own registry file
 * (`<data dir>/telegram.json`) with the same injectable io the module uses, so
 * the operator mints a bind code or unbinds a chat without the daemon in the
 * way. The one thing the daemon is still asked for is the session list
 * (`GET /v1/sessions`, the same endpoint/`DPI_TOKEN` rule `dpi schedule` uses) —
 * names are nicer than ids in `status`, and `sessions` is only useful live; when
 * the daemon is down both degrade to ids / an honest "no sessions" line.
 *
 * The bot token comes from `DPI_TELEGRAM_TOKEN` (process env or the env file,
 * doctor's `deviceEndpoint` rule); without it `status` and `bind` say so and
 * exit 1, because both would lie otherwise. Exit codes: 0 ok, 1 error, 2 usage
 * error; nothing is ever thrown out of `telegramCli`. `argv` is what follows the
 * `telegram` word (`telegramCli({ argv: ["bind"] })`).
 */
import { homedir } from "node:os";
import { join, resolve } from "node:path";
import { expand, readEnvFile } from "./doctor.js";
import { defaultTelegramIo, TelegramBridge, type TelegramBroker, type TelegramIo } from "./telegram.js";

export interface TelegramCliArgs {
  argv: readonly string[];
}

/** The CLI adds output, env and home to the module's io — one object, so a test fakes exactly what it needs. */
export interface TelegramCliIo extends TelegramIo {
  print: (line: string) => void;
  printErr: (line: string) => void;
  env: Record<string, string | undefined>;
  homedir: () => string;
}

export const defaultTelegramCliIo = (): TelegramCliIo => ({
  ...defaultTelegramIo(),
  print: (line) => process.stdout.write(`${line}\n`),
  printErr: (line) => process.stderr.write(`${line}\n`),
  env: process.env as Record<string, string | undefined>,
  homedir,
});

export const TELEGRAM_HELP = `dpi telegram — bind a Telegram chat to a device session

  dpi telegram status
  dpi telegram bind [--session <id-prefix>]
  dpi telegram unbind <chat-prefix>
  dpi telegram sessions

  status    is a token configured, which chats are bound to which sessions
  bind      mint a single-use /start code (10 min); prints the message to send
            your bot and the t.me deep link
  unbind    remove a chat binding by chat-id prefix
  sessions  the sessions a chat can switch between (/session <id-prefix>)

  --home DIR   device home (default: $DPI_HOME, else ~/.dpi)

  The bot token is DPI_TELEGRAM_TOKEN (process env or the env file); the
  registry is <home>/backend/telegram.json ($DPI_DATA_DIR overrides the dir).
Exit codes: 0 ok, 1 error, 2 usage error.`;

/** Everything the subcommands need from env + flags, resolved once. */
interface TelegramCliEnv {
  home: string;
  envFile: string;
  dataDir: string;
  registryPath: string;
  /** DPI_TELEGRAM_TOKEN — the bot token; empty when unset. */
  token: string;
  /** DPI_TOKEN — the device API token, for the session list; empty when unset. */
  apiToken: string;
  baseUrl: string;
}

const flagValue = (argv: readonly string[], name: string): string | undefined => {
  const i = argv.indexOf(name);
  return i >= 0 && argv[i + 1] ? argv[i + 1] : undefined;
};

/**
 * `--home` wins, then $DPI_HOME (process env only — the env file lives *inside*
 * the home, so it cannot name it), then ~/.dpi. The env file is
 * $DPI_ENV_FILE or `<home>/backend.env`; process env always beats it. This is
 * doctor.ts's `deviceEndpoint` rule, async because this io's fs is async.
 */
async function resolveEnv(argv: readonly string[], io: TelegramCliIo): Promise<TelegramCliEnv> {
  const hd = io.homedir();
  const home = resolve(expand(flagValue(argv, "--home") ?? io.env.DPI_HOME ?? join(hd, ".dpi"), hd));
  const envFile = resolve(expand(io.env.DPI_ENV_FILE || join(home, "backend.env"), hd));
  let fileEnv: Record<string, string> = {};
  if (await io.exists(envFile)) {
    try {
      fileEnv = readEnvFile(await io.readFile(envFile));
    } catch {
      /* unreadable env file: fall back to process env, like doctor.ts */
    }
  }
  const value = (key: string): string | undefined => io.env[key] ?? fileEnv[key];
  const dataDir = resolve(expand(value("DPI_DATA_DIR") || join(home, "backend"), hd));
  const host = value("DPI_HOST") || "127.0.0.1";
  // A device listening on every interface is still reached over loopback here.
  const probeHost = host === "0.0.0.0" || host === "::" ? "127.0.0.1" : host;
  const port = Number(value("DPI_PORT") || "4780");
  return {
    home,
    envFile,
    dataDir,
    registryPath: join(dataDir, "telegram.json"),
    token: value("DPI_TELEGRAM_TOKEN") || "",
    apiToken: value("DPI_TOKEN") || "",
    baseUrl: `http://${probeHost}:${Number.isInteger(port) && port > 0 ? port : 4780}`,
  };
}

/**
 * The session list for names and `dpi telegram sessions`. Asked of the local
 * daemon over its API; any failure (down, no token, odd shape) is an empty
 * list, because a CLI that only *decorates* must not fail because of it.
 */
async function fetchSessions(io: TelegramCliIo, env: TelegramCliEnv): Promise<Array<{ id: string; name: string }>> {
  if (!env.apiToken) return [];
  try {
    const res = await io.fetch(`${env.baseUrl}/v1/sessions`, {
      method: "GET",
      headers: { authorization: `Bearer ${env.apiToken}` },
      signal: AbortSignal.timeout(4_000),
    });
    if (!res.ok) return [];
    const body = (await res.json()) as unknown;
    const rows = Array.isArray(body)
      ? body
      : body !== null && typeof body === "object" && Array.isArray((body as { sessions?: unknown }).sessions)
        ? (body as { sessions: unknown[] }).sessions
        : [];
    const out: Array<{ id: string; name: string }> = [];
    for (const row of rows) {
      if (row === null || typeof row !== "object") continue;
      const source = row as Record<string, unknown>;
      if (typeof source.id !== "string" || !source.id) continue;
      out.push({ id: source.id, name: typeof source.name === "string" && source.name ? source.name : source.id });
    }
    return out;
  } catch {
    return [];
  }
}

/** The bot's @username via getMe, for the t.me deep link; undefined whenever anything is off. */
async function botUsername(io: TelegramCliIo, token: string): Promise<string | undefined> {
  try {
    const res = await io.fetch(`https://api.telegram.org/bot${token}/getMe`, {
      method: "GET",
      signal: AbortSignal.timeout(8_000),
    });
    if (!res.ok) return undefined;
    const body = (await res.json()) as { ok?: unknown; result?: { username?: unknown } };
    return typeof body?.result?.username === "string" && body.result.username ? body.result.username : undefined;
  } catch {
    return undefined;
  }
}

export async function telegramCli(args: TelegramCliArgs, io: TelegramCliIo = defaultTelegramCliIo()): Promise<number> {
  try {
    return await run(args, io);
  } catch (error) {
    // The CLI contract is an exit code, never a stack trace (backupCli's rule).
    io.printErr(`dpi telegram: ${error instanceof Error ? error.message : String(error)}`);
    return 1;
  }
}

async function run(args: TelegramCliArgs, io: TelegramCliIo): Promise<number> {
  const argv = args.argv;
  if (argv.includes("--help") || argv.includes("-h")) {
    io.print(TELEGRAM_HELP);
    return 0;
  }
  const [sub = "", ...rest] = argv;
  const env = await resolveEnv(rest, io);
  const sessions = await fetchSessions(io, env);
  const broker: TelegramBroker = {
    listSessions: () => sessions.map((session) => ({ ...session })),
    sendToSession: async () => {
      throw new Error("the CLI does not submit to sessions; the device daemon does");
    },
    awaitAnswer: async () => undefined,
  };
  const openBridge = () =>
    TelegramBridge.open(env.registryPath, io, broker, { warn: (message) => io.printErr(`[telegram] ${message}`) });

  switch (sub) {
    case "status":
      return await statusCmd(io, env, openBridge);
    case "bind":
      return await bindCmd(rest, io, env, sessions, openBridge);
    case "unbind":
      return await unbindCmd(rest, io, openBridge);
    case "sessions":
      return sessionsCmd(io, env, sessions);
    default:
      io.printErr(
        `dpi telegram: unknown subcommand '${sub || "(none)"}' — expected status, bind, unbind or sessions\n\n${TELEGRAM_HELP}`,
      );
      return 2;
  }
}

async function statusCmd(io: TelegramCliIo, env: TelegramCliEnv, openBridge: () => Promise<TelegramBridge>): Promise<number> {
  if (!env.token) {
    io.printErr(`dpi telegram: no DPI_TELEGRAM_TOKEN in ${env.envFile}`);
    return 1;
  }
  const status = (await openBridge()).status();
  io.print(`token: configured (looked in ${env.envFile})`);
  io.print(`registry: ${env.registryPath}, bridge ${status.running ? "running" : "stopped"}`);
  if (!status.chats.length) io.print("no chats bound");
  else {
    io.print(`${status.chats.length} chat(s) bound:`);
    for (const chat of status.chats) io.print(`  ${chat.chatId} → ${chat.sessionName ?? chat.sessionId}`);
  }
  io.print(status.pendingCodes > 0 ? `${status.pendingCodes} pending bind code(s)` : "no pending bind codes");
  return 0;
}

async function bindCmd(
  rest: readonly string[],
  io: TelegramCliIo,
  env: TelegramCliEnv,
  sessions: ReadonlyArray<{ id: string; name: string }>,
  openBridge: () => Promise<TelegramBridge>,
): Promise<number> {
  if (!env.token) {
    io.printErr(`dpi telegram: no DPI_TELEGRAM_TOKEN in ${env.envFile}`);
    return 1;
  }
  let sessionId: string | undefined;
  const sessionArg = flagValue(rest, "--session");
  if (sessionArg !== undefined) {
    const target = sessions.find((session) => session.id.startsWith(sessionArg));
    if (!target) {
      io.printErr(`dpi telegram bind: no session matching '${sessionArg}'`);
      return 1;
    }
    sessionId = target.id;
  }
  let minted: { code: string; expiresAt: string };
  try {
    const bridge = await openBridge();
    minted = sessionId === undefined ? await bridge.bind() : await bridge.bind(sessionId);
  } catch (error) {
    io.printErr(`dpi telegram bind: ${error instanceof Error ? error.message : String(error)}`);
    return 1;
  }
  io.print(`send this to your bot: /start ${minted.code}`);
  io.print(`the code expires ${minted.expiresAt}`);
  const username = await botUsername(io, env.token);
  if (username) io.print(`deep link: https://t.me/${username}?start=${minted.code}`);
  else io.print("could not reach api.telegram.org for a deep link — send the /start line above");
  return 0;
}

async function unbindCmd(rest: readonly string[], io: TelegramCliIo, openBridge: () => Promise<TelegramBridge>): Promise<number> {
  const positional = rest.filter((arg) => !arg.startsWith("--") && arg !== flagValue(rest, "--home"));
  if (positional.length !== 1) {
    io.printErr(`dpi telegram unbind: expected exactly one chat-id prefix\n\n${TELEGRAM_HELP}`);
    return 2;
  }
  const chatId = await (await openBridge()).unbind(positional[0]);
  if (chatId === undefined) {
    io.printErr(`dpi telegram unbind: no bound chat matching '${positional[0]}'`);
    return 1;
  }
  io.print(`unbound chat ${chatId}`);
  return 0;
}

function sessionsCmd(io: TelegramCliIo, env: TelegramCliEnv, sessions: ReadonlyArray<{ id: string; name: string }>): number {
  if (!sessions.length) {
    io.print(`no sessions (looked at ${env.baseUrl}/v1/sessions — is the device running?)`);
    return 0;
  }
  io.print(`${sessions.length} session(s) a chat can switch to:`);
  for (const session of sessions) io.print(`  ${session.id}  ${session.name}`);
  return 0;
}
