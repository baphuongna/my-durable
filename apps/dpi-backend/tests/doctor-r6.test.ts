/**
 * `dpi doctor` R6 cli findings 6 + 7, unit-level with injected fakes.
 *
 *   6. A corrupt/unreadable pairing.json used to be swallowed by the hub
 *      check's catch and reported as "no hub configured" — masking a broken
 *      pairing file as an empty config. It must WARN with
 *      "pairing.json is corrupt/unreadable" instead.
 *   7. The model probe warned "no usable defaultModel" on faux devices because
 *      splitModel only matched "provider/id" forms, never a bare catalog id.
 *      A bare id that exists in models[] must resolve like a provider-qualified
 *      one, so a healthy faux device stays ok.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { runDoctor, splitModel, type DoctorIo, type HttpResponse } from "../src/doctor.js";

type Reply = { status?: number; body?: unknown };
type Route = Reply | ((init: { method?: string; body?: string } | undefined) => Reply);

const HOME = "/home/tester";
const BASE = "http://127.0.0.1:4780";

function harness(o: {
  files?: Record<string, string>;
  routes?: Record<string, Route>;
  readError?: Error;
} = {}) {
  // "~/dpi-work" (the default start dir) exists so start-dir checks stay green;
  // a virtual file is enough — exists() gates, access() is stubbed writable.
  // The default env file carries a token so the model probe is not skipped.
  const files: Record<string, string> = {
    "/home/tester/dpi-work": "",
    [`${HOME}/backend.env`]: "DPI_TOKEN=dpi_0123456789abcdefghijklmnopqrstuvwxyz012345\n",
    ...(o.files ?? {}),
  };
  const routes = o.routes ?? {
    [`GET ${BASE}/healthz`]: { body: { ok: true } },
    [`GET ${BASE}/v1/device`]: {
      body: { defaultModel: "echo", models: [{ provider: "faux", id: "echo" }] },
    },
    [`POST ${BASE}/v1/device/probe-model`]: { body: { ok: true, detail: "answered" } },
  };
  const io: DoctorIo = {
    env: { DPI_HOME: HOME },
    nodeVersion: "22.23.1",
    fetchImpl: async (url, init) => {
      const key = `${init?.method ?? "GET"} ${url}`;
      const route = routes[key] ?? routes[`GET ${url}`];
      if (!route) throw new Error(`no route for ${key}`);
      const reply = typeof route === "function" ? route(init) : route;
      return {
        ok: (reply.status ?? 200) < 400,
        status: reply.status ?? 200,
        json: async () => reply.body ?? {},
      } satisfies HttpResponse;
    },
    access: () => undefined,
    exists: (path) => path in files,
    readFile: (path) => {
      if (o.readError) throw o.readError;
      if (!(path in files)) throw Object.assign(new Error(`ENOENT: '${path}'`), { code: "ENOENT" });
      return files[path]!;
    },
    homedir: () => HOME,
    timeoutMs: 1_000,
    hubTimeoutMs: 1_000,
    probeTimeoutMs: 1_000,
    requiredNode: ">=22.19.0",
  };
  return { io };
}

// ------------------------------------------------------- finding 6: corrupt pairing.json

test("corrupt pairing.json: hub check WARNS 'corrupt/unreadable', not 'no hub configured'", async () => {
  const { io } = harness({ files: { [`${HOME}/pairing.json`]: "{ not json" } });
  const report = await runDoctor(io);
  const hub = report.checks.find((c) => c.id === "hub");
  assert.ok(hub);
  assert.equal(hub.status, "warn", "a corrupt file is a warning, never silent skip");
  assert.match(hub.detail, /^pairing\.json is corrupt\/unreadable — fix or delete/);
  assert.doesNotMatch(hub.detail, /no hub configured/);
  assert.equal(report.ok, true, "warnings do not fail the report");
});

test("unreadable pairing.json (EACCES) is reported the same way", async () => {
  const { io } = harness({
    files: { [`${HOME}/pairing.json`]: "{}" },
    readError: Object.assign(new Error("EACCES: permission denied"), { code: "EACCES" }),
  });
  const report = await runDoctor(io);
  const hub = report.checks.find((c) => c.id === "hub");
  assert.ok(hub);
  assert.equal(hub.status, "warn");
  assert.match(hub.detail, /pairing\.json is corrupt\/unreadable/);
});

test("a HEALTHY pairing.json still resolves the hub origin (regression guard)", async () => {
  const { io } = harness({
    files: { [`${HOME}/pairing.json`]: JSON.stringify({ hubOrigin: "https://hub.example/" }) },
    routes: {
      [`GET ${BASE}/healthz`]: { body: { ok: true } },
      [`GET ${BASE}/v1/device`]: { body: { defaultModel: "x/y", models: [{ provider: "x", id: "y" }] } },
      [`POST ${BASE}/v1/device/probe-model`]: { body: { ok: true } },
      "GET https://hub.example/healthz": { body: { ok: true } },
    },
  });
  const report = await runDoctor(io);
  const hub = report.checks.find((c) => c.id === "hub");
  assert.ok(hub);
  assert.equal(hub.status, "ok", "origin from pairing.json, trailing slash trimmed");
  assert.match(hub.detail, /hub\.example/);
});

test("no pairing.json at all still means skip, not warn", async () => {
  const { io } = harness({ files: {} });
  const report = await runDoctor(io);
  const hub = report.checks.find((c) => c.id === "hub");
  assert.ok(hub);
  assert.equal(hub.status, "skip");
  assert.match(hub.detail, /no hub configured/);
});

// ------------------------------------------------------- finding 7: bare model ids

test("splitModel: a bare id present in the catalog resolves (faux devices)", () => {
  const catalog = [{ provider: "faux", id: "echo" }, { provider: "faux", id: "vision" }];
  assert.deepEqual(splitModel("echo", catalog), { provider: "faux", modelId: "echo" });
  // the qualified form still wins first; a bare id with NO catalog cannot resolve
  assert.deepEqual(splitModel("faux/echo", catalog), { provider: "faux", modelId: "echo" });
  assert.equal(splitModel("missing", catalog), undefined);
  assert.equal(splitModel("noslash", undefined), undefined);
  assert.deepEqual(splitModel("faux/echo", undefined), { provider: "faux", modelId: "echo" });
});

test("model probe: faux device with a BARE defaultModel reports ok, not warn", async () => {
  const { io } = harness();
  const report = await runDoctor(io);
  const probe = report.checks.find((c) => c.id === "model_probe");
  assert.ok(probe);
  assert.equal(probe.status, "ok", "faux defaultModel 'echo' resolves against the catalog");
  assert.match(probe.label, /model probe echo/);
});
