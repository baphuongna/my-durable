/**
 * `dpi diagnostics` (checklist Wave 3, "Diagnostic bundle"): the redaction is
 * the point, so the masks are pinned pattern by pattern; the bundle is built
 * through an in-memory io + fake device (routes keyed by URL), so no test
 * touches the real fs or network; and every section failure mode still
 * produces a bundle — a broken device is exactly when diagnostics matter most.
 */
import test from "node:test";
import assert from "node:assert/strict";
import { readZipEntries } from "../src/backup.js";
import {
  collectDiagnostics,
  DiagnosticsError,
  redact,
  redactJson,
  type DiagnosticsIo,
} from "../src/diagnostics.js";
import { PACKAGE_VERSION } from "../src/store.js";

const NOW = Date.UTC(2026, 9, 25, 3, 54, 9, 123);
const HOME = "/home/tester";
const DPI_HOME = `${HOME}/.dpi`;
const ENV_FILE = `${DPI_HOME}/backend.env`;
const LOG = `${DPI_HOME}/device.log`;
const BASE = "http://127.0.0.1:4780";
const TOKEN = "dpi_0123456789abcdefghijklmnopqrstuvwxyz012345";
const SECTION_NAMES = [
  "manifest.json",
  "doctor.json",
  "device.json",
  "vitals.json",
  "env.json",
  "sessions.json",
  "projects.json",
  "schedules.json",
  "notify.json",
];

// ------------------------------------------------------------------ redact

test("redact masks each secret shape, prefix and all", () => {
  assert.equal(redact(`token ${TOKEN} accepted`), "token dpi_•••• accepted");
  assert.equal(redact("Authorization: Bearer abcdefghijklmnop rejected"), "Authorization: Bearer •••• rejected");
  assert.equal(redact("key sk-abcdefghijklmnop expired"), "key sk-•••• expired");
  assert.equal(redact("key pk-abcdefghijklmnop expired"), "key pk-•••• expired");
  assert.equal(redact("key rk-abcdefghijklmnopqrst expired"), "key rk-•••• expired");
  // a raw long run with no prefix — the catch-all (safe here: no transcripts in the bundle)
  assert.equal(redact("raw abcdefghijklmnopqrstuvwxyz012345 tail"), "raw •••• tail");
  // two secrets on one line, and only the values change
  assert.equal(redact(`a ${TOKEN} b Bearer abcdefghijklmnop c`), "a dpi_•••• b Bearer •••• c");
});

test("redact leaves normal words, urls and paths alone", () => {
  assert.equal(redact("the device at 127.0.0.1:4780 is fine"), "the device at 127.0.0.1:4780 is fine");
  assert.equal(redact("GET https://hub.example/healthz → 200"), "GET https://hub.example/healthz → 200");
  assert.equal(redact("/home/tester/.dpi/device.log"), "/home/tester/.dpi/device.log");
  // 26 chars: under the 32-char cutoff, like every plausible filename segment
  assert.equal(redact("dpi-backup-20261025-035409.zip"), "dpi-backup-20261025-035409.zip");
  assert.equal(redact("DPI_TOKEN is set (masked by design)"), "DPI_TOKEN is set (masked by design)");
});

test("redactJson walks nested objects and arrays without mutating the input", () => {
  const input = {
    token: TOKEN,
    list: ["sk-abcdefghijklmnop", "plain"],
    nested: { auth: "Bearer abcdefghijklmnop", n: 7, flag: true, none: null },
  };
  const out = redactJson(input) as typeof input;
  assert.deepEqual(out, {
    token: "dpi_••••",
    list: ["sk-••••", "plain"],
    nested: { auth: "Bearer ••••", n: 7, flag: true, none: null },
  });
  assert.equal(input.token, TOKEN, "the original is untouched");
  assert.deepEqual(redactJson(["a", ["b", TOKEN]]), ["a", ["b", "dpi_••••"]]);
  assert.deepEqual(redactJson({ empty: {} }), { empty: {} });
  assert.equal(redactJson(7), 7);
  assert.equal(redactJson(null), null);
});

// ----------------------------------------------------------------- harness

type Reply = { status?: number; body?: unknown; text?: string } | Error;
type Route = Reply | ((init?: { method?: string; headers?: Record<string, string>; body?: string }) => Reply);

/** A device that is fully healthy — tests override one piece at a time. */
function healthyRoutes(): Record<string, Route> {
  return {
    [`${BASE}/healthz`]: { body: { ok: true } },
    [`${BASE}/v1/device`]: {
      body: { name: "test-device", defaultModel: "faux/echo", models: [{ provider: "faux", id: "echo" }] },
    },
    [`${BASE}/v1/device/probe-model`]: { body: { ok: true, detail: "answered" } },
    [`${BASE}/v1/device/vitals`]: { body: { uptimeMs: 1_000, counts: { sessions: 1, archived: 0 } } },
    [`${BASE}/v1/device/env`]: { body: { vars: { OPENROUTER_API_KEY: "sk-abcdefghijklmnop" } } },
    [`${BASE}/v1/sessions`]: {
      body: [{ id: "s1", name: `build ${TOKEN}`, cwd: "/work", model: "faux/echo", busy: false }],
    },
    [`${BASE}/v1/projects`]: { body: { projects: [] } },
    [`${BASE}/v1/schedules`]: { body: { schedules: [] } },
    [`${BASE}/v1/notify/sinks`]: { body: { sinks: [] } },
  };
}

interface Harness {
  io: DiagnosticsIo;
  calls: { url: string; init?: { method?: string; headers?: Record<string, string> } }[];
  written: Map<string, { data: Buffer; mode?: number }>;
  mkdirs: { path: string; mode?: number }[];
  chmods: { path: string; mode: number }[];
  routes: Record<string, Route>;
}

function harness(o: { env?: Record<string, string | undefined>; files?: Record<string, string>; routes?: Record<string, Route> } = {}): Harness {
  const files = new Map<string, string>(Object.entries(o.files ?? { [ENV_FILE]: `DPI_TOKEN=${TOKEN}\n` }));
  const writable = new Set(["/work"]);
  const routes = o.routes ?? healthyRoutes();
  const calls: Harness["calls"] = [];
  const written = new Map<string, { data: Buffer; mode?: number }>();
  const mkdirs: { path: string; mode?: number }[] = [];
  const chmods: { path: string; mode: number }[] = [];

  const existsSync = (p: string): boolean => files.has(p) || writable.has(p);
  const readFileSync = (p: string): string => {
    const text = files.get(p);
    if (text === undefined) throw Object.assign(new Error(`ENOENT: no such file or directory, open '${p}'`), { code: "ENOENT" });
    return text;
  };
  const accessSync = (p: string): void => {
    if (!existsSync(p)) throw Object.assign(new Error(`EACCES: permission denied, access '${p}'`), { code: "EACCES" });
  };

  const io: DiagnosticsIo = {
    env: o.env ?? { DPI_START_DIRS: "/work" },
    nodeVersion: "22.23.1",
    homedir: () => HOME,
    now: () => NOW,
    fetch: async (url, init) => {
      calls.push({ url, init });
      const reply = routes[url];
      if (!reply) throw new Error(`connect ECONNREFUSED ${url} (faked)`);
      const r = typeof reply === "function" ? reply(init) : reply;
      if (r instanceof Error) throw r;
      const status = r.status ?? 200;
      return { ok: status >= 200 && status < 300, status, text: async () => r.text ?? JSON.stringify(r.body ?? {}, null, 2) };
    },
    exists: async (p) => existsSync(p),
    readFile: async (p) => readFileSync(p),
    writeFile: async (p, data, mode) => {
      written.set(p, { data: Buffer.from(data), mode });
    },
    chmod: async (p, mode) => {
      chmods.push({ path: p, mode });
    },
    mkdir: async (p, mode) => {
      mkdirs.push({ path: p, mode });
    },
    existsSync,
    readFileSync,
    accessSync,
  };
  return { io, calls, written, mkdirs, chmods, routes };
}

const OUT = "/out/diag.zip";
const collect = (h: Harness, over: { home?: string; out?: string; files?: Record<string, string> } = {}) =>
  collectDiagnostics(h.io, { home: over.home ?? DPI_HOME, out: over.out ?? OUT });

/** The zip the harness io received, parsed back with backup.ts's own reader. */
const entriesOf = (h: Harness): Array<{ name: string; text: string }> =>
  readZipEntries(h.written.get(OUT)!.data).map((e) => ({ name: e.name, text: Buffer.from(e.data).toString("utf8") }));

// ---------------------------------------------------------------- collect

test("a healthy device produces every section, redacted, in one 0600 zip", async () => {
  const h = harness({ files: { [ENV_FILE]: `DPI_TOKEN=${TOKEN}\n`, [LOG]: "starting device\ntoken accepted\nready\n" } });
  const result = await collect(h);

  assert.equal(result.path, OUT);
  assert.deepEqual(result.sections.map((s) => s.name), [...SECTION_NAMES, "device.log"]);
  assert.ok(result.sections.every((s) => s.ok), "every section collected");
  assert.ok(result.bytes > 0);

  const entries = entriesOf(h);
  assert.deepEqual(entries.map((e) => e.name), [...SECTION_NAMES, "device.log"]);

  // 0600 write + forced chmod, 0700 parent — backup.ts's rule
  assert.equal(h.written.get(OUT)!.mode, 0o600);
  assert.deepEqual(h.chmods, [{ path: OUT, mode: 0o600 }]);
  assert.deepEqual(h.mkdirs, [{ path: "/out", mode: 0o700 }]);

  const manifest = JSON.parse(entries[0].text);
  assert.equal(manifest.createdAt, new Date(NOW).toISOString());
  assert.equal(manifest.packageVersion, PACKAGE_VERSION);
  assert.equal(manifest.node, "22.23.1");
  assert.equal(manifest.home, DPI_HOME);
  assert.equal(typeof manifest.platform, "string");
  assert.equal(typeof manifest.arch, "string");
  assert.deepEqual(manifest.sections, [...SECTION_NAMES.slice(1), "device.log"], "the manifest lists what it contains");

  // doctor.json is doctor's own runner, re-run through this io
  const doctor = JSON.parse(entries.find((e) => e.name === "doctor.json")!.text);
  assert.deepEqual(doctor.checks.map((c: { id: string; status: string }) => `${c.id}:${c.status}`), [
    "node:ok",
    "healthz:ok",
    "start_dir:ok",
    "model_probe:ok",
    "hub:skip",
    "crash-reports:ok",
  ]);
  assert.equal(doctor.ok, true);

  // a clean body round-trips untouched…
  assert.deepEqual(JSON.parse(entries.find((e) => e.name === "device.json")!.text), {
    name: "test-device",
    defaultModel: "faux/echo",
    models: [{ provider: "faux", id: "echo" }],
  });
  // …and a secret-shaped one is masked before it enters the zip
  const env = entries.find((e) => e.name === "env.json")!.text;
  assert.match(env, /sk-••••/);
  assert.ok(!env.includes("sk-abcdefghijklmnop"), "no raw key in env.json");
  const sessions = entries.find((e) => e.name === "sessions.json")!.text;
  assert.match(sessions, /"name": "build dpi_••••"/);
  assert.ok(!sessions.includes(TOKEN), "no raw device token in sessions.json");
  const log = entries.find((e) => e.name === "device.log")!.text;
  assert.deepEqual(log.split("\n").filter(Boolean), ["starting device", "token accepted", "ready"]);

  // section fetches are token-authed, the doctor way
  const sessionCall = h.calls.find((c) => c.url === `${BASE}/v1/sessions`);
  assert.equal(sessionCall?.init?.headers?.authorization, `Bearer ${TOKEN}`);
});

test("a 404 route records the error in its section and the bundle still builds", async () => {
  const h = harness({ routes: { ...healthyRoutes(), [`${BASE}/v1/device/env`]: { status: 404, body: { error: "nope" } } } });
  const result = await collect(h);

  const env = result.sections.find((s) => s.name === "env.json")!;
  assert.equal(env.ok, false);
  assert.equal(env.error, "404");

  const entries = entriesOf(h);
  assert.equal(entries.length, SECTION_NAMES.length, "no device.log file: the entry is skipped");
  assert.deepEqual(JSON.parse(entries.find((e) => e.name === "env.json")!.text), { error: "GET /v1/device/env → 404" });
  assert.ok(result.sections.filter((s) => s.name !== "env.json").every((s) => s.ok), "the other sections are unaffected");
});

test("a fetch that throws records the cause and the bundle still builds", async () => {
  const h = harness({
    routes: { ...healthyRoutes(), [`${BASE}/v1/device/vitals`]: new Error("connect ECONNREFUSED 127.0.0.1:4780") },
  });
  const result = await collect(h);

  const vitals = result.sections.find((s) => s.name === "vitals.json")!;
  assert.equal(vitals.ok, false);
  assert.match(vitals.error ?? "", /ECONNREFUSED/);
  assert.match(entriesOf(h).find((e) => e.name === "vitals.json")!.text, /GET \/v1\/device\/vitals unreachable — connect ECONNREFUSED/);
});

test("a fully broken device still produces a bundle — that is the point", async () => {
  const h = harness({ routes: {} }); // every fetch refuses, and no device.log exists
  const result = await collect(h);

  assert.equal(result.sections.length, SECTION_NAMES.length);
  const manifestOk = result.sections.find((s) => s.name === "manifest.json")!;
  const doctorOk = result.sections.find((s) => s.name === "doctor.json")!;
  assert.equal(manifestOk.ok, true);
  assert.equal(doctorOk.ok, true, "doctor ran — its report just records the failures");
  for (const api of result.sections.filter((s) => s.name.endsWith(".json") && !["manifest.json", "doctor.json"].includes(s.name))) {
    assert.equal(api.ok, false);
    assert.match(api.error ?? "", /ECONNREFUSED/);
  }

  const entries = entriesOf(h);
  assert.deepEqual(entries.map((e) => e.name), SECTION_NAMES);
  const doctor = JSON.parse(entries.find((e) => e.name === "doctor.json")!.text);
  assert.equal(doctor.ok, false);
  assert.equal((doctor.checks.find((c: { id: string }) => c.id === "healthz") as { status: string }).status, "fail");
  assert.ok(!entries.some((e) => e.name === "device.log"), "no log file, no log entry");
});

test("the device.log tail is the last 400 lines, redacted", async () => {
  const lines = Array.from({ length: 500 }, (_, i) => `line-${String(i).padStart(4, "0")}`);
  lines[1] = `${lines[1]} leaked ${TOKEN}`; // outside the tail: dropped whole
  lines[498] = `${lines[498]} leaked ${TOKEN}`; // inside the tail: masked
  const h = harness({ files: { [ENV_FILE]: `DPI_TOKEN=${TOKEN}\n`, [LOG]: `${lines.join("\n")}\n` } });
  const result = await collect(h);

  const section = result.sections.find((s) => s.name === "device.log")!;
  assert.equal(section.ok, true);
  const text = entriesOf(h).find((e) => e.name === "device.log")!.text;
  const kept = text.split("\n").filter(Boolean);
  assert.equal(kept.length, 400, "exactly the last 400 lines");
  assert.equal(kept[0], "line-0100");
  assert.equal(kept[kept.length - 1], "line-0499");
  assert.ok(!text.includes("line-0099"), "the first 100 lines are gone");
  assert.ok(!text.includes(TOKEN), "the raw token never enters the zip");
  assert.ok(text.includes("dpi_••••"), "the leaked token is masked in place");
  assert.equal(section.bytes, Buffer.byteLength(text, "utf8"));
});

test("a missing device.log is a skipped entry, not a failure", async () => {
  const h = harness();
  const result = await collect(h);
  assert.ok(!result.sections.some((s) => s.name === "device.log"));
  assert.ok(!entriesOf(h).some((e) => e.name === "device.log"));
  assert.ok(result.sections.filter((s) => s.name !== "device.log").every((s) => s.ok));
});

test("bad options are DiagnosticsError(invalid) and write nothing", async () => {
  const h = harness();
  await assert.rejects(
    () => collect(h, { home: "" }),
    (error: unknown) => error instanceof DiagnosticsError && error.code === "invalid" && /home is required/.test(error.message),
  );
  await assert.rejects(() => collect(h, { out: "" }), /out is required/);
  assert.equal(h.written.size, 0, "nothing was written");
});
