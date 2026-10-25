/**
 * `dpi telegram` (checklist Wave 3): the CLI over an in-memory fs with the
 * clock pinned and both endpoints (api.telegram.org for getMe, the local device
 * API for the session list) faked — a CLI test must never open a socket.
 */
import test from "node:test";
import assert from "node:assert/strict";
import { telegramCli, TELEGRAM_HELP, type TelegramCliIo } from "../src/telegram-cli.js";
import type { TelegramIo } from "../src/telegram.js";

const NOW = Date.UTC(2026, 9, 25, 4, 0, 0);

/**
 * A CLI io over an in-memory file map, with output captured and fetch answered
 * per URL. `getMe` answers `dpi_bot` unless `failGetMe` is set; `/v1/sessions`
 * answers the daemon's session list unless `failApi` is set.
 */
function harness(over: { env?: Record<string, string | undefined>; files?: Array<[string, string]>; failGetMe?: boolean; failApi?: boolean } = {}) {
  const files = new Map<string, string>(over.files ?? []);
  const lines: string[] = [];
  const errors: string[] = [];
  const fetches: Array<{ url: string; init?: { method?: string; headers?: Record<string, string>; body?: string } }> = [];
  const sessions = [
    { id: "ses_alpha", name: "alpha" },
    { id: "ses_beta", name: "beta" },
  ];
  const io: TelegramCliIo = {
    ...((): TelegramIo => ({
      fetch: async (url, init) => {
        fetches.push({ url, init });
        const json = async (body: unknown) => ({ ok: true, status: 200, json: async () => body });
        if (url.includes("/getMe")) {
          if (over.failGetMe) throw new Error("connect ETIMEDOUT (faked)");
          return json({ ok: true, result: { id: 1, username: "dpi_bot" } });
        }
        if (url.endsWith("/v1/sessions")) {
          if (over.failApi) return { ok: false, status: 403, json: async () => ({}) };
          return json(sessions);
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
      },
      chmod: async () => {},
      exists: async (path) => files.has(path),
      now: () => NOW,
      setTimeout: (cb) => {
        // The CLI never starts the loop; if something schedules, run it next tick.
        setImmediate(cb);
        return { unref: () => {} };
      },
      clearTimeout: () => {},
    }))(),
    print: (line) => lines.push(line),
    printErr: (line) => errors.push(line),
    env: over.env ?? {},
    homedir: () => "/home/tester",
  };
  return { io, files, lines, errors, fetches, sessions };
}

const HOME = "/dpi-home";
const ENV_FILE = `${HOME}/backend.env`;
const REGISTRY = `${HOME}/backend/telegram.json`;

/** A home with a token (and optionally DPI_TOKEN) in its env file. */
const homeWithToken = (over: { apiToken?: boolean } = {}): Array<[string, string]> => [
  [ENV_FILE, `DPI_TELEGRAM_TOKEN=tg-token\n${over.apiToken ? "DPI_TOKEN=dev-token\n" : ""}`],
];

test("status without a token exits 1 naming the env file it looked in", async () => {
  const h = harness();
  assert.equal(await telegramCli({ argv: ["status"] }, h.io), 1);
  assert.deepEqual(h.errors, ["dpi telegram: no DPI_TELEGRAM_TOKEN in /home/tester/.dpi/backend.env"]);
  assert.deepEqual(h.fetches, [], "nothing is asked of the network without a token");
});

test("status prints bound chats (named via the device API) and pending codes", async () => {
  const h = harness({
    env: { DPI_HOME: HOME },
    files: [
      ...homeWithToken({ apiToken: true }),
      [
        REGISTRY,
        `${JSON.stringify(
          {
            version: 1,
            offset: 12,
            chats: [
              { chatId: 42, sessionId: "ses_beta", createdAt: "2026-10-01T00:00:00.000Z" },
              { chatId: 99, sessionId: "ses_gone", createdAt: "2026-10-01T00:00:00.000Z" },
            ],
            codes: [{ code: "ab12cd34", sessionId: "ses_alpha", createdAt: "2026-10-01T00:00:00.000Z", expiresAt: "2999-01-01T00:00:00.000Z" }],
          },
          null,
          2,
        )}\n`,
      ],
    ],
  });

  assert.equal(await telegramCli({ argv: ["status"] }, h.io), 0);
  const text = h.lines.join("\n");
  assert.match(text, /token: configured/);
  assert.match(text, /2 chat\(s\) bound:/);
  assert.match(text, /42 → beta/);
  assert.match(text, /99 → ses_gone/, "a session the daemon no longer lists falls back to its id");
  assert.match(text, /1 pending bind code\(s\)/);

  const api = h.fetches.find((f) => f.url.endsWith("/v1/sessions"))!;
  assert.ok(api, "the session list came from the device API");
  assert.equal(api.init?.headers?.authorization, "Bearer dev-token");
  assert.equal(api.url, "http://127.0.0.1:4780/v1/sessions");
});

test("bind mints a code, prints the /start line and the t.me deep link", async () => {
  const h = harness({ env: { DPI_HOME: HOME }, files: homeWithToken() });

  assert.equal(await telegramCli({ argv: ["bind"] }, h.io), 0);
  const text = h.lines.join("\n");
  const code = /\/start ([0-9a-f]{8})/.exec(text)![1];
  assert.match(text, new RegExp(`send this to your bot: /start ${code}`));
  assert.match(text, new RegExp(`https://t\\.me/dpi_bot\\?start=${code}`));
  assert.match(text, /the code expires /);

  const disk = JSON.parse(h.files.get(REGISTRY)!) as { codes: Array<{ code: string; createdAt: string; expiresAt: string }> };
  assert.deepEqual(
    disk.codes,
    [{ code, createdAt: new Date(NOW).toISOString(), expiresAt: new Date(NOW + 600_000).toISOString() }],
    "no DPI_TOKEN → no session list → the code defers its target to /start time",
  );
  assert.equal(h.fetches.find((f) => f.url.includes("/getMe"))?.init?.method, "GET");
  assert.deepEqual(h.errors, []);
});

test("bind --session targets a session by prefix and falls back to the plain code when getMe fails", async () => {
  const ok = harness({ env: { DPI_HOME: HOME }, files: homeWithToken({ apiToken: true }) });
  assert.equal(await telegramCli({ argv: ["bind", "--session", "ses_be"] }, ok.io), 0);
  const disk = JSON.parse(ok.files.get(REGISTRY)!) as { codes: Array<{ sessionId: string }> };
  assert.equal(disk.codes[0].sessionId, "ses_beta", "the prefix resolved through the session list");

  const failing = harness({ env: { DPI_HOME: HOME }, files: homeWithToken(), failGetMe: true });
  assert.equal(await telegramCli({ argv: ["bind"] }, failing.io), 0, "a dead getMe is not a failed bind");
  const text = failing.lines.join("\n");
  assert.match(text, /send this to your bot: \/start [0-9a-f]{8}/);
  assert.doesNotMatch(text, /t\.me\//);
  assert.match(text, /could not reach api\.telegram\.org/);
});

test("unbind removes a chat by prefix and exits 1 for an unknown prefix", async () => {
  const files: Array<[string, string]> = [
    [REGISTRY, `${JSON.stringify(
      { version: 1, offset: 0, chats: [{ chatId: 4242, sessionId: "ses_alpha", createdAt: "2026-10-01T00:00:00.000Z" }], codes: [] },
    )}\n`],
  ];
  const h = harness({ env: { DPI_HOME: HOME }, files });
  assert.equal(await telegramCli({ argv: ["unbind", "42"] }, h.io), 0);
  assert.deepEqual(h.lines, ["unbound chat 4242"]);
  assert.deepEqual(JSON.parse(h.files.get(REGISTRY)!).chats, [], "the binding is gone from the registry");

  const miss = harness({ env: { DPI_HOME: HOME }, files: [...h.files] });
  assert.equal(await telegramCli({ argv: ["unbind", "99"] }, miss.io), 1);
  assert.deepEqual(miss.errors, ["dpi telegram unbind: no bound chat matching '99'"]);

  const usage = harness({ env: { DPI_HOME: HOME }, files: [...h.files] });
  assert.equal(await telegramCli({ argv: ["unbind"] }, usage.io), 2, "a missing prefix is a usage error");
});

test("sessions lists the bindable sessions, and says so when the daemon is unreachable", async () => {
  const h = harness({ env: { DPI_HOME: HOME }, files: homeWithToken({ apiToken: true }) });
  assert.equal(await telegramCli({ argv: ["sessions"] }, h.io), 0);
  const text = h.lines.join("\n");
  assert.match(text, /2 session\(s\) a chat can switch to:/);
  assert.match(text, /ses_alpha {2}alpha/);
  assert.match(text, /ses_beta {2}beta/);

  const down = harness({ env: { DPI_HOME: HOME }, files: homeWithToken({ apiToken: true }), failApi: true });
  assert.equal(await telegramCli({ argv: ["sessions"] }, down.io), 0, "a down daemon is not an error here");
  assert.match(down.lines.join("\n"), /no sessions \(looked at http:\/\/127\.0\.0\.1:4780\/v1\/sessions/);
});

test("unknown subcommands exit 2 and --help exits 0", async () => {
  const h = harness({ env: { DPI_HOME: HOME }, files: homeWithToken() });
  assert.equal(await telegramCli({ argv: ["send"] }, h.io), 2);
  assert.match(h.errors[0], /unknown subcommand 'send'/);
  assert.equal(await telegramCli({ argv: [] }, h.io), 2);
  assert.match(h.errors[1], /unknown subcommand '\(none\)'/);

  const helped = harness();
  assert.equal(await telegramCli({ argv: ["--help"] }, helped.io), 0);
  assert.ok(helped.lines[0].startsWith(TELEGRAM_HELP.slice(0, 40)));
});
