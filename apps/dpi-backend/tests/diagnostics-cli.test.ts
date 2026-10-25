/**
 * `dpi diagnostics` (checklist Wave 3): over the real fs in a temp dir, with
 * the clock pinned and the device faked — a real device listening on
 * 127.0.0.1:4780 must never make a test machine-dependent. The interesting
 * invariants: failed sections still exit 0 (the bundle built), only a bundle
 * that cannot be written exits 1, and usage errors exit 2.
 */
import test from "node:test";
import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { diagnosticsCli, defaultDiagnosticsCliIo, type DiagnosticsCliIo } from "../src/diagnostics-cli.js";
import { readZipEntries } from "../src/backup.js";

/** Fixed clock: the default out name is deterministic modulo the timezone. */
const NOW = Date.UTC(2026, 9, 25, 3, 54, 9, 123);
const TOKEN = "dpi_0123456789abcdefghijklmnopqrstuvwxyz012345";
const BASE = "http://127.0.0.1:4780";

type Reply = { status?: number; body?: unknown };
type Route = Reply | Error;

/** A device that is fully healthy for every route diagnostics and doctor ask for. */
function healthyRoutes(): Record<string, Route> {
  return {
    [`${BASE}/healthz`]: { body: { ok: true } },
    [`${BASE}/v1/device`]: { body: { name: "test-device", defaultModel: "faux/echo", models: [{ provider: "faux", id: "echo" }] } },
    [`${BASE}/v1/device/probe-model`]: { body: { ok: true, detail: "answered" } },
    [`${BASE}/v1/device/vitals`]: { body: { uptimeMs: 1_000 } },
    [`${BASE}/v1/device/env`]: { body: { vars: {} } },
    [`${BASE}/v1/sessions`]: { body: [] },
    [`${BASE}/v1/projects`]: { body: { projects: [] } },
    [`${BASE}/v1/schedules`]: { body: { schedules: [] } },
    [`${BASE}/v1/notify/sinks`]: { body: { sinks: [] } },
  };
}

/**
 * A CLI io over the real fs with the clock pinned, a configurable env, captured
 * output and a device that is refused by default (the diagnostics case that
 * matters most).
 */
const harness = (over: { env?: Record<string, string | undefined>; routes?: Record<string, Route> } = {}) => {
  const lines: string[] = [];
  const errors: string[] = [];
  const routes = over.routes ?? {};
  const io: DiagnosticsCliIo = {
    ...defaultDiagnosticsCliIo(),
    env: over.env ?? {},
    now: () => NOW,
    fetch: async (url) => {
      const reply = routes[url];
      if (!reply) throw new Error(`connect ECONNREFUSED ${url} (faked)`);
      if (reply instanceof Error) throw reply;
      const status = reply.status ?? 200;
      return { ok: status >= 200 && status < 300, status, text: async () => JSON.stringify(reply.body ?? {}) };
    },
    print: (line) => lines.push(line),
    printErr: (line) => errors.push(line),
  };
  return { io, lines, errors };
};

/** A small fake device home: an env file with the token, and a log with a leak. */
async function fakeHome(root: string, name = "home"): Promise<string> {
  const home = join(root, name);
  await mkdir(home, { recursive: true });
  await writeFile(join(home, "backend.env"), `DPI_TOKEN=${TOKEN}\n`);
  await writeFile(join(home, "device.log"), `started\ntoken ${TOKEN} accepted\n`);
  return home;
}

const exists = async (path: string): Promise<boolean> => {
  try {
    await stat(path);
    return true;
  } catch {
    return false;
  }
};

test("device down: failed sections still exit 0, and the bundle lands at the default path", async () => {
  const root = await mkdtemp(join(tmpdir(), "dpi-diag-cli-"));
  try {
    const home = await fakeHome(root);
    const { io, lines, errors } = harness(); // no routes: the device refuses every connection
    assert.equal(await diagnosticsCli({ argv: ["--home", home] }, io), 0);

    const sections = lines.filter((l) => l.startsWith("ok ") || l.startsWith("failed "));
    assert.ok(sections.length >= 9, "one line per section");
    assert.match(sections.find((l) => l.startsWith("failed device.json: "))!, /failed device\.json: .*ECONNREFUSED/);
    assert.ok(sections.some((l) => l.startsWith("ok manifest.json ")));
    assert.ok(sections.some((l) => l.startsWith("ok doctor.json ")), "doctor ran — its report just records the failures");
    assert.ok(sections.some((l) => l.startsWith("ok device.log ")), "the log tail is on-disk, not from the device");

    const zip = lines[lines.length - 2];
    assert.ok(zip.startsWith(root), `the bundle lands next to home: ${zip}`);
    assert.match(zip, /home-diagnostics\/dpi-diagnostics-\d{8}-\d{6}\.zip$/);
    assert.ok(await exists(zip), "the zip exists at the printed path");
    assert.match(lines[lines.length - 1], /diagnostic bundle: \d+ section\(s\), .+ total, \d+ failed/);
    assert.equal(errors.length, 0, "failed sections are not errors");

    const entries = readZipEntries(await readFile(zip));
    assert.equal(entries.length, 10, "manifest + doctor + 7 api sections + device.log");
    assert.ok(!entries.some((e) => Buffer.from(e.data).toString("utf8").includes(TOKEN)), "the leaked token is masked everywhere");
    if (process.platform !== "win32") assert.equal((await stat(zip)).mode & 0o777, 0o600);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("device up: every section is ok, and --out lands where it is told", async () => {
  const root = await mkdtemp(join(tmpdir(), "dpi-diag-cli-"));
  try {
    const home = await fakeHome(root);
    const custom = join(root, "nested", "diag.zip");
    const { io, lines } = harness({ env: { DPI_HOME: home }, routes: healthyRoutes() });
    assert.equal(await diagnosticsCli({ argv: ["--out", custom] }, io), 0);

    assert.equal(lines.find((l) => l === custom), custom, "the printed path is the --out path");
    assert.ok(await exists(custom), "missing parent dirs are created");
    const sections = lines.filter((l) => l.startsWith("ok ") || l.startsWith("failed "));
    assert.equal(sections.length, 10);
    assert.ok(sections.every((l) => l.startsWith("ok ")), `no failures: ${sections.join(" | ")}`);
    assert.match(sections.find((l) => l.startsWith("ok device.json "))!, /^ok device\.json [0-9.]+ (B|KiB|MiB)$/);
    assert.match(lines[lines.length - 1], /total$/);

    const names = readZipEntries(await readFile(custom)).map((e) => e.name);
    assert.deepEqual(names, [
      "manifest.json",
      "doctor.json",
      "device.json",
      "vitals.json",
      "env.json",
      "sessions.json",
      "projects.json",
      "schedules.json",
      "notify.json",
      "device.log",
    ]);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("a bundle that cannot be written exits 1 and says why", async () => {
  const root = await mkdtemp(join(tmpdir(), "dpi-diag-cli-"));
  try {
    const home = await fakeHome(root);
    await writeFile(join(root, "afile"), "in the way");
    const { io, lines, errors } = harness();
    const code = await diagnosticsCli({ argv: ["--home", home, "--out", join(root, "afile", "diag.zip")] }, io);
    assert.equal(code, 1);
    assert.match(errors.join("\n"), /dpi diagnostics: /);
    assert.equal(lines.length, 0, "no section lines without a bundle");
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("usage errors exit 2, help exits 0, and nothing is ever thrown", async () => {
  const { io, lines, errors } = harness();
  assert.equal(await diagnosticsCli({ argv: ["--bogus"] }, io), 2);
  assert.match(errors.join("\n"), /unknown flag '--bogus'/);
  errors.length = 0;

  assert.equal(await diagnosticsCli({ argv: ["stray.zip"] }, io), 2, "no positional arguments");
  assert.match(errors.join("\n"), /unexpected argument 'stray\.zip'/);
  errors.length = 0;

  assert.equal(await diagnosticsCli({ argv: ["--help"] }, io), 0);
  assert.match(lines.join("\n"), /dpi diagnostics \[--out FILE\] \[--home DIR\]/);
  assert.equal(errors.length, 0);
});
