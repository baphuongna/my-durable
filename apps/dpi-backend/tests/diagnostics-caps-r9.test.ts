/**
 * R9 unit C (u7 — the run-8 uncovered finding): the diagnostics bundle caps.
 * (1) device.log is read tail-bounded — `readFile` never fires for the log, the
 * io's `readFileTail` carries the byte ceiling; (2) an apiSection body over
 * the raw cap is refused with a named size instead of parsed, and a parseable
 * body whose pretty-printed section would blow past the per-section ceiling is
 * byte-capped with an explicit truncation marker; (3) an aggregate ceiling
 * refuses the bundle export-style (invalid fault, nothing written); (4) the
 * shareable mode strips device.log (not even read) and hard-redacts env values
 * — the bundle operators paste into bug reports never carries env/log payloads.
 * Harness style copied from diagnostics.test.ts: in-memory io, fake device, no
 * real network; the tail-bounded default io is proven against a real file
 * under tmpdir() (repo helpers.ts convention).
 */
import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { readZipEntries } from "../src/backup.js";
import {
  API_BODY_MAX_BYTES,
  BUNDLE_MAX_BYTES,
  collectDiagnostics,
  defaultDiagnosticsIo,
  DEVICE_LOG_TAIL_BYTES,
  DiagnosticsError,
  SECTION_MAX_BYTES,
  type DiagnosticsIo,
} from "../src/diagnostics.js";

const NOW = Date.UTC(2026, 9, 25, 3, 54, 9, 123);
const HOME = "/home/tester";
const DPI_HOME = `${HOME}/.dpi`;
const ENV_FILE = `${DPI_HOME}/backend.env`;
const LOG = `${DPI_HOME}/device.log`;
const BASE = "http://127.0.0.1:4780";
const TOKEN = "dpi_0123456789abcdefghijklmnopqrstuvwxyz012345";
const OUT = "/out/diag.zip";

// ------------------------------------------------------------------ harness

type Reply = { status?: number; body?: unknown; text?: string } | Error;
type Route = Reply | ((init?: { method?: string; headers?: Record<string, string>; body?: string }) => Reply);

function healthyRoutes(): Record<string, Route> {
  return {
    [`${BASE}/healthz`]: { body: { ok: true } },
    [`${BASE}/v1/device`]: { body: { name: "test-device", defaultModel: "faux/echo" } },
    [`${BASE}/v1/device/probe-model`]: { body: { ok: true, detail: "answered" } },
    [`${BASE}/v1/device/vitals`]: { body: { uptimeMs: 1_000, counts: { sessions: 1, archived: 0 } } },
    [`${BASE}/v1/device/env`]: { body: { vars: { OPENROUTER_API_KEY: "sk-abcdefghijklmnop" } } },
    [`${BASE}/v1/sessions`]: { body: [] },
    [`${BASE}/v1/projects`]: { body: { projects: [] } },
    [`${BASE}/v1/schedules`]: { body: { schedules: [] } },
    [`${BASE}/v1/notify/sinks`]: { body: { sinks: [] } },
  };
}

interface Harness {
  io: DiagnosticsIo;
  /** Every path handed to the whole-file `readFile` — the log must never appear. */
  reads: string[];
  /** Every (path, maxBytes) handed to the tail-bounded `readFileTail`. */
  tailReads: { path: string; maxBytes: number }[];
  written: Map<string, { data: Buffer; mode?: number }>;
  routes: Record<string, Route>;
}

function harness(o: { files?: Record<string, string>; routes?: Record<string, Route> } = {}): Harness {
  const files = new Map<string, string>(Object.entries(o.files ?? { [ENV_FILE]: `DPI_TOKEN=${TOKEN}\n` }));
  const writable = new Set(["/work"]);
  const routes = o.routes ?? healthyRoutes();
  const reads: string[] = [];
  const tailReads: Harness["tailReads"] = [];
  const written = new Map<string, { data: Buffer; mode?: number }>();

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
    env: { DPI_START_DIRS: "/work" },
    nodeVersion: "22.23.1",
    homedir: () => HOME,
    now: () => NOW,
    fetch: async (url) => {
      const reply = routes[url];
      if (!reply) throw new Error(`connect ECONNREFUSED ${url} (faked)`);
      const r = typeof reply === "function" ? reply(undefined) : reply;
      if (r instanceof Error) throw r;
      const status = r.status ?? 200;
      return { ok: status >= 200 && status < 300, status, text: async () => r.text ?? JSON.stringify(r.body ?? {}, null, 2) };
    },
    exists: async (p) => existsSync(p),
    readFile: async (p) => {
      reads.push(p);
      return readFileSync(p);
    },
    // The tail-bounded surface the caps require: at most maxBytes from the END
    // of the file, dropped past the first newline so the tail is line-aligned.
    readFileTail: async (p, maxBytes) => {
      tailReads.push({ path: p, maxBytes });
      const text = files.get(p);
      if (text === undefined) throw Object.assign(new Error(`ENOENT: no such file or directory, open '${p}'`), { code: "ENOENT" });
      const bytes = Buffer.from(text, "utf8");
      if (bytes.length <= maxBytes) return text;
      const cut = bytes.subarray(bytes.length - maxBytes).toString("utf8");
      const nl = cut.indexOf("\n");
      return nl >= 0 ? cut.slice(nl + 1) : cut;
    },
    writeFile: async (p, data, mode) => {
      written.set(p, { data: Buffer.from(data), mode });
    },
    chmod: async () => {},
    mkdir: async () => {},
    existsSync,
    readFileSync,
    accessSync,
  };
  return { io, reads, tailReads, written, routes };
}

const collect = (h: Harness, over: { home?: string; out?: string; shareable?: boolean; maxBundleBytes?: number } = {}) =>
  collectDiagnostics(h.io, { home: over.home ?? DPI_HOME, out: over.out ?? OUT, ...over });

/** The zip the harness io received, parsed back with backup.ts's own reader. */
const entriesOf = (h: Harness): Array<{ name: string; text: string }> =>
  readZipEntries(h.written.get(OUT)!.data).map((e) => ({ name: e.name, text: Buffer.from(e.data).toString("utf8") }));

// ------------------------------------------------- (1) tail-bounded log read

test("device.log is read tail-bounded: readFileTail carries the ceiling, readFile never fires", async () => {
  const lines = Array.from({ length: 30_000 }, (_, i) => `line-${String(i).padStart(6, "0")}-${"x".repeat(12)}`); // ~720 KB, over the tail ceiling
  // NOTE: each line stays under redact()'s 32-char catch-all — the point here
  // is the bounded read, not the masking (diagnostics.test.ts owns that).
  const logText = `${lines.join("\n")}\n`;
  assert.ok(Buffer.byteLength(logText, "utf8") > DEVICE_LOG_TAIL_BYTES, "fixture is oversized");
  lines[29_998] = `${lines[29_998]} leaked ${TOKEN}`; // inside the tail: masked
  const h = harness({ files: { [ENV_FILE]: `DPI_TOKEN=${TOKEN}\n`, [LOG]: `${lines.join("\n")}\n` } });
  const result = await collect(h);

  assert.deepEqual(h.tailReads, [{ path: LOG, maxBytes: DEVICE_LOG_TAIL_BYTES }], "the bounded read is used, with the ceiling");
  assert.ok(!h.reads.includes(LOG), "the whole-file readFile never fires for device.log");

  const section = result.sections.find((s) => s.name === "device.log")!;
  assert.equal(section.ok, true);
  assert.ok(section.bytes <= SECTION_MAX_BYTES, "the log section is under the per-section ceiling");
  const text = entriesOf(h).find((e) => e.name === "device.log")!.text;
  const kept = text.split("\n").filter(Boolean);
  assert.equal(kept.length, 400, "still exactly the last 400 lines");
  assert.equal(kept[kept.length - 1], lines[lines.length - 1], "the very last line survived");
  assert.ok(!text.includes("line-000000"), "the head of the log is gone");
  assert.ok(!text.includes(TOKEN), "the raw token never enters the zip");
});

test("an io without readFileTail still gets a capped log section (legacy fallback)", async () => {
  const giant = `${"one very long line ".repeat(100_000)}\n`; // ~1.8 MB single line
  const h = harness({ files: { [ENV_FILE]: `DPI_TOKEN=${TOKEN}\n`, [LOG]: giant } });
  delete (h.io as { readFileTail?: unknown }).readFileTail; // the old-io shape
  const result = await collect(h);

  assert.ok(h.reads.includes(LOG), "fallback uses the legacy readFile");
  const section = result.sections.find((s) => s.name === "device.log")!;
  assert.equal(section.ok, true);
  assert.ok(section.bytes <= SECTION_MAX_BYTES, "even a single giant line is byte-capped");
  const text = entriesOf(h).find((e) => e.name === "device.log")!.text;
  assert.match(text, /truncated at \d+ bytes\]/, "the cap is explicit, not silent");
});

test("the default io's readFileTail reads only the tail bytes of a real file, line-aligned", async () => {
  const dir = await mkdtemp(join(tmpdir(), "dpi-diag-r9-"));
  try {
    const path = join(dir, "big.log");
    const lines = Array.from({ length: 30_000 }, (_, i) => `real-${String(i).padStart(6, "0")}-${"y".repeat(50)}`);
    await writeFile(path, `${lines.join("\n")}\n`, "utf8"); // ~1.7 MB
    const io = defaultDiagnosticsIo();

    const tail = await io.readFileTail!(path, DEVICE_LOG_TAIL_BYTES);
    assert.ok(Buffer.byteLength(tail, "utf8") <= DEVICE_LOG_TAIL_BYTES, "never more than the ceiling");
    const kept = tail.split("\n").filter(Boolean);
    assert.ok(kept.length < lines.length, "the head was never read");
    assert.ok(kept[0].startsWith("real-"), "starts on a line boundary (partial first line dropped)");
    assert.equal(kept[kept.length - 1], lines[lines.length - 1]);

    const small = join(dir, "small.log");
    await writeFile(small, "a\nb\nc\n", "utf8");
    assert.equal(await io.readFileTail!(small, DEVICE_LOG_TAIL_BYTES), "a\nb\nc\n", "a small file comes back whole");
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

// ---------------------------------------------- (2) apiSection body byte caps

test("an oversized API body is refused with a named cap, not parsed", async () => {
  const huge = JSON.stringify({ values: Array.from({ length: 40_000 }, () => "z".repeat(64)) }); // ~2.8 MB
  assert.ok(Buffer.byteLength(huge, "utf8") > API_BODY_MAX_BYTES, "fixture is over the raw cap");
  const h = harness({ routes: { ...healthyRoutes(), [`${BASE}/v1/device/vitals`]: { text: huge } } });
  const result = await collect(h);

  const vitals = result.sections.find((s) => s.name === "vitals.json")!;
  assert.equal(vitals.ok, false);
  assert.match(vitals.error ?? "", /body over \d+ bytes/);
  const entry = entriesOf(h).find((e) => e.name === "vitals.json")!.text;
  assert.ok(Buffer.byteLength(entry, "utf8") < 4096, "the refusal section stays tiny");
  assert.match(entry, /body over \d+ bytes/);
  assert.ok(result.sections.filter((s) => s.name !== "vitals.json").every((s) => s.ok), "the bundle still builds");
});

test("a parseable body whose pretty-printed section blows past the ceiling is truncated and marked", async () => {
  // raw JSON under the raw cap, but jsonText's 2-space indent pushes it over
  // the per-section ceiling (12k rows × ~24 pretty bytes ≈ 288 KB > 256 KiB)
  const body = { rows: Array.from({ length: 12_000 }, () => "z".repeat(16)) };
  const raw = JSON.stringify(body);
  assert.ok(Buffer.byteLength(raw, "utf8") < API_BODY_MAX_BYTES, "raw body is under the raw cap");
  assert.ok(Buffer.byteLength(JSON.stringify(body, null, 2), "utf8") > SECTION_MAX_BYTES, "pretty form is over the cap");
  const h = harness({ routes: { ...healthyRoutes(), [`${BASE}/v1/projects`]: { text: raw } } });
  const result = await collect(h);

  const section = result.sections.find((s) => s.name === "projects.json")!;
  assert.equal(section.ok, true, "the body itself was fine — only the section text is capped");
  assert.equal(section.truncated, true);
  assert.ok(section.bytes <= SECTION_MAX_BYTES, "section.bytes honors the ceiling");
  const entry = entriesOf(h).find((e) => e.name === "projects.json")!.text;
  assert.ok(Buffer.byteLength(entry, "utf8") <= SECTION_MAX_BYTES, "the zip entry honors the ceiling");
  assert.match(entry, /\[projects\.json: truncated at \d+ bytes\]/, "the truncation is explicit");
});

// --------------------------------------------------- (3) aggregate zip ceiling

test("the aggregate bundle ceiling refuses export-style and writes nothing", async () => {
  const h = harness();
  await assert.rejects(
    () => collect(h, { maxBundleBytes: 200 }),
    (error: unknown) =>
      error instanceof DiagnosticsError && error.code === "invalid" && /over the 200 byte ceiling/.test(error.message),
  );
  assert.equal(h.written.size, 0, "a refused bundle is never written");
});

test("a healthy bundle stays comfortably under the default aggregate ceiling", async () => {
  const h = harness({ files: { [ENV_FILE]: `DPI_TOKEN=${TOKEN}\n`, [LOG]: "starting device\nready\n" } });
  const result = await collect(h);
  assert.ok(result.bytes > 0);
  assert.ok(result.bytes < BUNDLE_MAX_BYTES);
});

// ------------------------------------------------------- (4) the shareable mode

test("a shareable bundle strips device.log entirely and hard-redacts env values", async () => {
  const routes = {
    ...healthyRoutes(),
    [`${BASE}/v1/device/env`]: { body: { vars: { OPENROUTER_API_KEY: "sk-abcdefghijklmnop", SECRET_SHORT: "hunter2" } } },
  };
  const h = harness({
    routes,
    files: {
      [ENV_FILE]: `DPI_TOKEN=${TOKEN}\n`,
      [LOG]: "desktop-01 working in /home/tester/secret-project\n",
    },
  });
  const result = await collect(h, { shareable: true });

  // device.log is stripped BEFORE it is even read
  assert.ok(!result.sections.some((s) => s.name === "device.log"), "no log section");
  assert.ok(!h.tailReads.some((t) => t.path === LOG), "the log is never read in shareable mode");
  const entries = entriesOf(h);
  assert.ok(!entries.some((e) => e.name === "device.log"), "no log entry in the zip");
  assert.ok(!entries.some((e) => e.text.includes("secret-project")), "no log content leaked through any section");

  // env values are hard-redacted — not even the masked form of a key survives
  const env = entries.find((e) => e.name === "env.json")!.text;
  assert.ok(!env.includes("hunter2"), "a short non-token-shaped value does not survive");
  assert.ok(!env.includes("sk-"), "no key material at all, not even sk-••••");
  const parsed = JSON.parse(env) as { vars: Record<string, string> };
  assert.deepEqual(Object.keys(parsed.vars).sort(), ["OPENROUTER_API_KEY", "SECRET_SHORT"], "names stay for debugging");
  assert.deepEqual(Object.values(parsed.vars), ["«redacted»", "«redacted»"]);

  // the manifest lists only what shipped, and other sections are untouched
  const manifest = JSON.parse(entries.find((e) => e.name === "manifest.json")!.text);
  assert.ok(!manifest.sections.includes("device.log"));
  assert.equal((JSON.parse(entries.find((e) => e.name === "device.json")!.text) as { name: string }).name, "test-device");
});
