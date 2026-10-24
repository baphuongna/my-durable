/**
 * `dpi doctor` — the one-shot health check (Wave 1b of docs/host-project-checklist.md).
 *
 * Every check is exercised through injected fakes: no network, no real
 * filesystem, no daemon. The interesting invariants are
 *   - node below the engines floor is the ONLY hard block,
 *   - a dead provider (probe-model → ok:false) is a WARN, never a fail,
 *   - no hub configured is `skip`, not a problem,
 *   - the exit code is 1 exactly when a check FAILED.
 */
import test from "node:test";
import assert from "node:assert/strict";
import {
  runDoctor,
  formatReport,
  exitCode,
  doctorCli,
  parseStartDirs,
  readEnvFile,
  splitModel,
  DOCTOR_HEALTH_IDS,
  type DoctorIo,
  type HttpResponse,
} from "../src/doctor.js";

// ------------------------------------------------------------------- harness

type Reply = { status?: number; body?: unknown } | Error;
type Route = Reply | ((init: { method?: string; body?: string } | undefined) => Reply);

interface HarnessOptions {
  env?: Record<string, string | undefined>;
  nodeVersion?: string;
  /** Virtual files: path → contents (exists AND readable). */
  files?: Record<string, string>;
  /** Virtual dirs: path → state. Absent paths do not exist. */
  dirs?: Record<string, "writable" | "missing" | "denied">;
  /** "METHOD url" (or bare url) → reply. */
  routes?: Record<string, Route>;
  requiredNode?: string;
}

const HOME = "/home/tester";
const BASE = "http://127.0.0.1:4780";
const ENV_FILE = `${HOME}/.dpi/backend.env`;
const TOKEN = "dpi_0123456789abcdefghijklmnopqrstuvwxyz012345";

/** A device that is fully healthy — tests override one piece at a time. */
function healthyRoutes(): Record<string, Route> {
  return {
    [`GET ${BASE}/healthz`]: { body: { ok: true } },
    [`GET ${BASE}/v1/device`]: {
      body: { defaultModel: "faux/echo", models: [{ provider: "faux", id: "echo" }] },
    },
    [`POST ${BASE}/v1/device/probe-model`]: { body: { ok: true, detail: "ok" } },
    "GET https://hub.example/healthz": { body: { ok: true } },
  };
}

function harness(o: HarnessOptions = {}) {
  const files = o.files ?? { [ENV_FILE]: `DPI_TOKEN=${TOKEN}\n` };
  const dirs = o.dirs ?? { "/work": "writable" as const };
  const routes = o.routes ?? healthyRoutes();
  const calls: { url: string; init?: { method?: string; headers?: Record<string, string>; body?: string } }[] = [];

  const fetchImpl: DoctorIo["fetchImpl"] = async (url, init) => {
    calls.push({ url, init });
    const key = `${init?.method ?? "GET"} ${url}`;
    const entry = routes[key] ?? routes[url];
    if (!entry) throw new Error(`no fake route for ${key}`);
    const reply = typeof entry === "function" ? entry(init) : entry;
    if (reply instanceof Error) throw reply;
    const status = reply.status ?? 200;
    const res: HttpResponse = {
      ok: status >= 200 && status < 300,
      status,
      json: async () => reply.body ?? {},
    };
    return res;
  };

  const io: Partial<DoctorIo> = {
    env: o.env ?? { DPI_START_DIRS: "/work" },
    nodeVersion: o.nodeVersion ?? "22.23.1",
    fetchImpl,
    exists: (p: string) => Object.hasOwn(files, p) || (p in dirs && dirs[p] !== "missing"),
    readFile: (p: string) => {
      if (!Object.hasOwn(files, p)) throw Object.assign(new Error(`ENOENT: ${p}`), { code: "ENOENT" });
      return files[p];
    },
    access: (p: string) => {
      const state = dirs[p];
      if (!state || state === "missing")
        throw Object.assign(new Error(`ENOENT: no such file or directory, access '${p}'`), { code: "ENOENT" });
      if (state === "denied")
        throw Object.assign(new Error(`EACCES: permission denied, access '${p}'`), { code: "EACCES" });
    },
    homedir: () => HOME,
    timeoutMs: 50,
    hubTimeoutMs: 50,
    probeTimeoutMs: 50,
    ...(o.requiredNode ? { requiredNode: o.requiredNode } : {}),
  };
  return { io, calls, files, dirs, routes };
}

const byId = (report: { checks: { id: string }[] }, id: string) =>
  report.checks.find((c) => c.id === id) as unknown as {
    status: string;
    detail: string;
    label: string;
  };

// -------------------------------------------------------------------- tests

test("doctor: a healthy device is all ok, exit 0", async () => {
  const h = harness({ env: { DPI_START_DIRS: "/work", DPI_HUB_URL: "https://hub.example" } });
  const report = await runDoctor(h.io);

  assert.deepEqual(
    report.checks.map((c) => `${c.id}:${c.status}`),
    ["node:ok", "healthz:ok", "start_dir:ok", "model_probe:ok", "hub:ok"],
  );
  assert.equal(report.ok, true);
  assert.equal(exitCode(report), 0);
  // The probe asks about the device's OWN default model, not a hardcoded one.
  const probe = h.calls.find((c) => c.url.endsWith("/v1/device/probe-model"));
  assert.deepEqual(JSON.parse(probe!.init!.body!), { provider: "faux", modelId: "echo" });
  assert.equal(probe!.init!.headers!.authorization, `Bearer ${TOKEN}`, "probe is token-authed");
});

test("doctor: node below the engines floor is the one hard FAIL", async () => {
  const h = harness({ nodeVersion: "22.4.0" });
  const report = await runDoctor(h.io);

  const node = byId(report, "node");
  assert.equal(node.status, "fail");
  assert.match(node.detail, /below engines node >=22\.19\.0/);
  assert.equal(report.ok, false, "a too-old Node fails the report");
  assert.equal(exitCode(report), 1);
  // Everything else still ran: doctor reports the whole picture, not just the first problem.
  assert.equal(byId(report, "healthz").status, "ok");
});

test("doctor: node exactly on the floor passes", async () => {
  const h = harness({ nodeVersion: "22.19.0" });
  assert.equal(byId(await runDoctor(h.io), "node").status, "ok");
});

test("doctor: an unwritable start dir FAILS and names the dir", async () => {
  const h = harness({ dirs: { "/work": "denied" } });
  const report = await runDoctor(h.io);

  const dir = byId(report, "start_dir");
  assert.equal(dir.status, "fail");
  assert.equal(dir.label, "start dir /work");
  assert.match(dir.detail, /not writable — EACCES/);
  assert.equal(report.ok, false);
  assert.equal(exitCode(report), 1);
});

test("doctor: a missing start dir FAILS with an actionable detail", async () => {
  const h = harness({ dirs: {} });
  const dir = byId(await runDoctor(h.io), "start_dir");
  assert.equal(dir.status, "fail");
  assert.match(dir.detail, /missing/);
});

test("doctor: every start dir gets its own row (config.ts parity: ':'-separated)", async () => {
  const h = harness({
    env: { DPI_START_DIRS: "/work:/readonly" },
    dirs: { "/work": "writable", "/readonly": "denied" },
  });
  const report = await runDoctor(h.io);
  const rows = report.checks.filter((c) => c.id.startsWith("start_dir"));
  assert.deepEqual(
    rows.map((c) => `${c.label}:${c.status}`),
    ["start dir /work:ok", "start dir /readonly:fail"],
  );
  assert.equal(report.ok, false);
});

test("doctor: a dead provider (probe-model ok:false) is a WARN, not a fail", async () => {
  const routes = healthyRoutes();
  routes[`POST ${BASE}/v1/device/probe-model`] = { body: { ok: false, detail: "model_error" } };
  const h = harness({ routes });
  const report = await runDoctor(h.io);

  const probe = byId(report, "model_probe");
  assert.equal(probe.status, "warn");
  assert.match(probe.detail, /model_error/);
  assert.equal(report.ok, true, "a dead provider must not fail doctor — the FE rotates past it");
  assert.equal(exitCode(report), 0);
});

test("doctor: a probe transport error is a WARN too", async () => {
  const routes = healthyRoutes();
  routes[`POST ${BASE}/v1/device/probe-model`] = Object.assign(new Error("fetch failed"), {
    cause: { code: "ECONNRESET" },
  });
  const probe = byId(await runDoctor(harness({ routes }).io), "model_probe");
  assert.equal(probe.status, "warn");
  assert.match(probe.detail, /ECONNRESET/);
});

test("doctor: no hub configured is skip, not a warning", async () => {
  const h = harness({ env: { DPI_START_DIRS: "/work" } });
  const report = await runDoctor(h.io);
  const hub = byId(report, "hub");
  assert.equal(hub.status, "skip");
  assert.match(hub.detail, /no hub configured/);
  assert.equal(report.ok, true);
  assert.equal(
    h.calls.some((c) => c.url.includes("hub.example")),
    false,
    "no hub request when there is no hub",
  );
});

test("doctor: the hub comes from pairing.json when DPI_HUB_URL is unset", async () => {
  const h = harness({
    env: { DPI_START_DIRS: "/work" },
    files: {
      [ENV_FILE]: `DPI_TOKEN=${TOKEN}\n`,
      [`${HOME}/.dpi/pairing.json`]: JSON.stringify({ hubOrigin: "https://hub.example" }),
    },
  });
  const report = await runDoctor(h.io);
  assert.equal(byId(report, "hub").status, "ok");
  assert.ok(h.calls.some((c) => c.url === "https://hub.example/healthz"));
});

test("doctor: an unreachable hub is a WARN (offline is a device state, not a crash)", async () => {
  const routes = healthyRoutes();
  routes["GET https://hub.example/healthz"] = Object.assign(new Error("fetch failed"), {
    cause: { code: "ENOTFOUND" },
  });
  const report = await runDoctor(harness({ env: { DPI_START_DIRS: "/work", DPI_HUB_URL: "https://hub.example" }, routes }).io);
  const hub = byId(report, "hub");
  assert.equal(hub.status, "warn");
  assert.match(hub.detail, /ENOTFOUND/);
  assert.equal(report.ok, true);
});

test("doctor: a dead device FAILS healthz and skips the probe", async () => {
  const routes = healthyRoutes();
  routes[`GET ${BASE}/healthz`] = Object.assign(new Error("fetch failed"), {
    cause: { code: "ECONNREFUSED" },
  });
  const h = harness({ routes });
  const report = await runDoctor(h.io);

  const health = byId(report, "healthz");
  assert.equal(health.status, "fail");
  assert.match(health.detail, /ECONNREFUSED/);
  assert.match(health.detail, /dpi device start/);
  assert.equal(byId(report, "model_probe").status, "skip", "no probe against a dead device");
  assert.equal(report.ok, false);
  assert.equal(
    h.calls.some((c) => c.url.endsWith("/v1/device")),
    false,
    "skip means skip: no /v1/device call either",
  );
});

test("doctor: a 500 from healthz FAILS", async () => {
  const routes = healthyRoutes();
  routes[`GET ${BASE}/healthz`] = { status: 500, body: {} };
  assert.equal(byId(await runDoctor(harness({ routes }).io), "healthz").status, "fail");
});

test("doctor: no token means the probe is skipped, not failed", async () => {
  const h = harness({ files: {} });
  const report = await runDoctor(h.io);
  const probe = byId(report, "model_probe");
  assert.equal(probe.status, "skip");
  assert.match(probe.detail, /no DPI_TOKEN/);
  assert.equal(report.ok, true);
});

test("doctor: the env file supplies the port and token (daemon parity)", async () => {
  const files = { [ENV_FILE]: `DPI_TOKEN=${TOKEN}\nDPI_PORT=4999\n` };
  const routes: Record<string, Route> = {
    [`GET http://127.0.0.1:4999/healthz`]: { body: { ok: true } },
    [`GET http://127.0.0.1:4999/v1/device`]: { body: { defaultModel: "faux/echo" } },
    [`POST http://127.0.0.1:4999/v1/device/probe-model`]: { body: { ok: true, detail: "ok" } },
  };
  const h = harness({ files, routes, env: { DPI_START_DIRS: "/work" } });
  const report = await runDoctor(h.io);
  assert.equal(byId(report, "healthz").status, "ok");
  assert.equal(byId(report, "model_probe").status, "ok");
});

test("doctor: a device bound to 0.0.0.0 is probed over loopback", async () => {
  const h = harness({ env: { DPI_START_DIRS: "/work", DPI_HOST: "0.0.0.0" } });
  await runDoctor(h.io);
  assert.ok(h.calls.every((c) => c.url.startsWith("http://127.0.0.1:4780/")), "never dials 0.0.0.0");
});

// ------------------------------------------------------------- exit codes

test("exitCode: 1 exactly when something FAILED (warnings exit 0)", () => {
  const check = (status: "ok" | "warn" | "fail" | "skip") => ({ id: status, label: status, status, detail: "" });
  assert.equal(exitCode({ checks: [check("ok"), check("warn"), check("skip")], ok: true }), 0);
  assert.equal(exitCode({ checks: [check("ok"), check("fail")], ok: false }), 1);
});

test("doctorCli: --json prints the report and returns the exit code", async () => {
  const out: string[] = [];
  const h = harness({
    routes: (() => {
      const r = healthyRoutes();
      r[`GET ${BASE}/healthz`] = Object.assign(new Error("fetch failed"), { cause: { code: "ECONNREFUSED" } });
      return r;
    })(),
  });
  const code = await doctorCli(["--json"], { ...h.io, print: (l) => out.push(l) });
  assert.equal(code, 1);
  const parsed = JSON.parse(out.join("\n"));
  assert.equal(parsed.ok, false);
  assert.equal(parsed.checks.find((c: { id: string }) => c.id === "healthz").status, "fail");
});

test("doctorCli: human output lists every check and the verdict", async () => {
  const out: string[] = [];
  const h = harness({ env: { DPI_START_DIRS: "/work", DPI_HUB_URL: "https://hub.example" } });
  const code = await doctorCli([], { ...h.io, print: (l) => out.push(l) });
  const text = out.join("\n");
  assert.equal(code, 0);
  assert.match(text, /^ok {4}node 22\.23\.1 — satisfies engines node >=22\.19\.0/m);
  assert.match(text, /^ok {4}healthz http:\/\/127\.0\.0\.1:4780\/healthz — device answered/m);
  assert.match(text, /doctor: OK — 5 checks, all good/);
});

test("doctorCli: --quiet shows only problems (and always the verdict)", async () => {
  const out: string[] = [];
  const routes = healthyRoutes();
  routes[`POST ${BASE}/v1/device/probe-model`] = { body: { ok: false, detail: "model_error" } };
  const code = await doctorCli(["--quiet"], { ...harness({ routes }).io, print: (l) => out.push(l) });
  const text = out.join("\n");
  assert.equal(code, 0);
  assert.equal(out.filter((l) => l.startsWith("ok")).length, 0, "quiet prints no ok rows");
  assert.match(text, /^warn {2}model probe faux\/echo — model_error/m);
  assert.match(text, /doctor: OK — 5 checks, 1 warning/);
});

test("doctorCli: a bad flag is refused with help, exit 1", async () => {
  const err: string[] = [];
  const code = await doctorCli(["--nope"], { print: () => {}, printErr: (l) => err.push(l) });
  assert.equal(code, 1);
  assert.match(err.join("\n"), /unknown flag '--nope'/);
});

// ----------------------------------------------------------- pure helpers

test("parseStartDirs: ':'-separated, ~-expanded, resolved (config.ts parity)", () => {
  assert.deepEqual(parseStartDirs("~/dpi-work", HOME), [`${HOME}/dpi-work`]);
  assert.deepEqual(parseStartDirs("/a:/b", HOME), ["/a", "/b"]);
  assert.deepEqual(parseStartDirs("/a:", HOME), ["/a"]);
  // A comma is NOT a separator for the device (config.ts splits on ":"), so doctor
  // must report the same single dir rather than invent a friendlier rule.
  assert.deepEqual(parseStartDirs("/a,/b", HOME), ["/a,/b"]);
});

test("readEnvFile: KEY=VALUE, quotes stripped, comments and blanks ignored", () => {
  const parsed = readEnvFile('# comment\nDPI_TOKEN="dpi_x"\nDPI_PORT=4999\n\nbroken line\n');
  assert.deepEqual(parsed, { DPI_TOKEN: "dpi_x", DPI_PORT: "4999" });
});

test("splitModel: OpenRouter ids keep their own slash", () => {
  assert.deepEqual(splitModel("faux/echo"), { provider: "faux", modelId: "echo" });
  assert.deepEqual(splitModel("openrouter/anthropic/claude-sonnet-5.5"), {
    provider: "openrouter",
    modelId: "anthropic/claude-sonnet-5.5",
  });
  assert.deepEqual(
    splitModel("minimax/MiniMax-M2.7", [{ provider: "minimax", id: "MiniMax-M2.7" }]),
    { provider: "minimax", modelId: "MiniMax-M2.7" },
  );
  assert.equal(splitModel("no-slash"), undefined);
  assert.equal(splitModel(""), undefined);
});

test("formatReport: a failing report names the count", () => {
  const lines = formatReport({
    checks: [
      { id: "node", label: "node 22.4.0", status: "fail", detail: "too old" },
      { id: "hub", label: "hub", status: "skip", detail: "none" },
    ],
    ok: false,
  });
  assert.match(lines.join("\n"), /^fail {2}node 22\.4\.0 — too old/m);
  assert.match(lines.join("\n"), /doctor: 1 check failed/);
});

test("DOCTOR_HEALTH_IDS: the checklist's five checks, stable for consumers", () => {
  assert.deepEqual(DOCTOR_HEALTH_IDS, ["node", "healthz", "start_dir", "model_probe", "hub"]);
});
