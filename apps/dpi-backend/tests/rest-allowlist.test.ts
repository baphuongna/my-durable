/**
 * Gate A GA-07 — the REST allowlist the tunnel enforces matches the API this device really serves, and the
 * connector keeps every spelling of a local-only or streaming route away from it.
 *
 * Express matched routes case-insensitively, so `POST /v1/Pairing/start` once came through the tunnel and
 * reached the device's pairing control point. Since round 4 the device router is case-sensitive, so a
 * case-spelled route is refused at BOTH layers: the tunnel allowlist first, and locally by express itself.
 */
import test from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import express from "express";
import { v1 } from "../src/routes.js";
import { bearerAuth } from "../src/auth.js";
import { errorMiddleware } from "../src/errors.js";
import type { Store } from "../src/store.js";
import type { DevicePairing } from "../src/pairing.js";
import { REST_ROUTE_ALLOWLIST } from "../../dpi-sdk/src/protocol/rest-routes.js";
import { validateRestRequest } from "../../dpi-sdk/src/protocol/tunnel.js";
import { until, rig, type Hub } from "./connector-rig.js";

/** Routes the device serves that must NOT travel as tunneled REST: its local control point and its three SSE streams. */
const NOT_TUNNELED = new Set([
  // Model health probe: local control plane, spawns throwaway sessions.
  "POST /device/probe-model",
  "GET /tunnel",
  "GET /pairing",
  "POST /pairing/start",
  "POST /pairing/cancel",
  "GET /events",
  "GET /sessions/:s/events",
  "GET /sessions/:s/agents/:a/events",
]);

interface Calls {
  list: string[];
}

function deviceApp(calls: Calls) {
  const store = { deviceInfo: () => ({ name: "stub-device", apiVersion: 1 }) } as unknown as Store;
  const pairing = {
    status: () => ({ state: "idle" }),
    start: async (input: { hub?: string }) => void calls.list.push(`pairing.start hub=${input.hub}`),
    cancel: () => (calls.list.push("pairing.cancel"), { state: "idle" }),
  } as unknown as DevicePairing;
  const connector = { status: () => (calls.list.push("connector.status"), { state: "connected" }) };
  const app = express();
  app.use("/v1", bearerAuth("local-token"), express.json(), v1(store, pairing, connector));
  app.use((_req, res) => res.status(404).json({ error: { code: "not_found", message: "Route not found" } }));
  app.use(errorMiddleware);
  return { app, router: v1(store, pairing, connector) };
}

/** Every (method, path) the real Express router has registered. */
function servedRoutes(): { method: string; route: string }[] {
  const { router } = deviceApp({ list: [] });
  const stack = (router as unknown as { stack: { route?: { path: string; methods: Record<string, boolean> } }[] }).stack;
  const routes: { method: string; route: string }[] = [];
  for (const layer of stack) {
    if (!layer.route) continue;
    for (const method of Object.keys(layer.route.methods)) routes.push({ method: method.toUpperCase(), route: layer.route.path });
  }
  return routes;
}

const concrete = (route: string) => `/v1${route.replace(/:\w+/g, "x1")}`;

test("GA-07: every route the device serves is either on the tunnel allowlist or deliberately kept off it", () => {
  const served = servedRoutes();
  assert.ok(served.length >= 40, `the router was read (${served.length} routes)`);
  const listed = new Set(REST_ROUTE_ALLOWLIST.map((r) => `${r.method} ${r.route}`));
  for (const { method, route } of served) {
    const key = `${method} ${route}`;
    const verdict = validateRestRequest({ method, path: concrete(route) });
    if (NOT_TUNNELED.has(key)) {
      assert.equal(listed.has(key), false, `${key} is local/stream-only but sits on the allowlist`);
      assert.equal(verdict.ok, false, `${key} must be refused on the tunnel`);
    } else {
      assert.equal(listed.has(key), true, `${key} is served but not classified: add it to rest-routes.ts or to NOT_TUNNELED`);
      assert.equal(verdict.ok, true, `${key} must pass the tunnel validator`);
    }
  }
});

test("GA-07: the allowlist names no route the device does not serve, and the not-tunneled set has no typos", () => {
  const served = new Set(servedRoutes().map((r) => `${r.method} ${r.route}`));
  for (const entry of REST_ROUTE_ALLOWLIST) assert.ok(served.has(`${entry.method} ${entry.route}`), `stale allowlist entry ${entry.method} ${entry.route}`);
  for (const key of NOT_TUNNELED) assert.ok(served.has(key), `unknown route in NOT_TUNNELED: ${key}`);
});

/** The spellings the Gate A probe used, plus the folds the URL parser and Express would apply. */
const BYPASS_ATTEMPTS: { method: string; path: string; body?: unknown }[] = [
  { method: "POST", path: "/v1/Pairing/start", body: { code: "12345678", hub: "https://case-variant.invalid" } },
  { method: "POST", path: "/v1/PAIRING/cancel" },
  { method: "GET", path: "/v1/Pairing" },
  { method: "GET", path: "/v1/Tunnel" },
  { method: "GET", path: "/v1/TUNNEL" },
  { method: "GET", path: "/v1/Events" },
  { method: "GET", path: "/v1/Sessions/x1/Events" },
  { method: "GET", path: "/v1/sessions/x1/events" },
  { method: "GET", path: "/v1/sessions/x1/agents/y1/events" },
  { method: "POST", path: "/v1/./pairing/start", body: { code: "12345678", hub: "https://dot.invalid" } },
  { method: "POST", path: "/v1/%2e/pairing/start", body: { code: "12345678", hub: "https://dot.invalid" } },
  { method: "POST", path: "/v1/pa\tiring/start", body: { code: "12345678", hub: "https://tab.invalid" } },
  { method: "POST", path: "/v1/pairing/start\n", body: { code: "12345678", hub: "https://newline.invalid" } },
  { method: "POST", path: "/v1/pairing/start#x", body: { code: "12345678", hub: "https://fragment.invalid" } },
  { method: "POST", path: "/v1/pairing;x=1/start", body: { code: "12345678", hub: "https://param.invalid" } },
  { method: "POST", path: "/v1//pairing/start", body: { code: "12345678", hub: "https://slashes.invalid" } },
  { method: "GET", path: "/v1/events#frag" },
  { method: "GET", path: "/v1/ev\tents" },
  { method: "GET", path: "/v1/tunnel/" },
  { method: "POST", path: "/v1/%50airing/start", body: { code: "12345678", hub: "https://encoded.invalid" } },
];

async function ask(hub: Hub, method: string, path: string, body?: unknown) {
  const reqId = randomUUID();
  assert.ok(hub.send({ type: "rest-request", reqId, method, path, ...(body === undefined ? {} : { body }) }), `sent ${method} ${JSON.stringify(path)}`);
  await until(() => hub.frames.some((f) => f.type === "rest-response" && f.reqId === reqId), 5000, `a reply to ${method} ${JSON.stringify(path)}`);
  return hub.frames.find((f) => f.type === "rest-response" && f.reqId === reqId);
}

test("GA-07: through the connector, no spelling of a local-only or streaming route reaches the device API", async () => {
  const calls: Calls = { list: [] };
  const { app } = deviceApp(calls);
  const reached: string[] = [];
  const r = await rig((req, res) => {
    reached.push(`${req.method} ${req.url}`);
    app(req, res);
  });
  try {
    // Premise: the case variant cannot reach the pairing control point even on
    // a direct local call — the device router is case-sensitive now, so the
    // tunnel allowlist is no longer the only layer standing in the way.
    const direct = await fetch(`${r.api.baseUrl}/v1/Pairing/start`, {
      method: "POST",
      headers: { authorization: "Bearer local-token", "content-type": "application/json" },
      body: JSON.stringify({ code: "12345678", hub: "https://direct.invalid" }),
    });
    assert.equal(direct.status, 404);
    assert.deepEqual(calls.list, [], "Express matches case-sensitively: the variant never hit the pairing control point");
    calls.list.length = 0;
    reached.length = 0;

    // Control: an allowlisted request makes the whole trip.
    const device = await ask(r.hub, "GET", "/v1/device");
    assert.equal(device.status, 200);
    assert.equal(JSON.parse(device.body).name, "stub-device");
    assert.deepEqual(reached, ["GET /v1/device"]);
    reached.length = 0;

    for (const attempt of BYPASS_ATTEMPTS) {
      const reply = await ask(r.hub, attempt.method, attempt.path, attempt.body);
      assert.equal(reply.status, 404, `${attempt.method} ${JSON.stringify(attempt.path)} is refused`);
      assert.equal(reply.body.error.code, "invalid");
    }
    assert.deepEqual(reached, [], "nothing was requested from the device API");
    assert.deepEqual(calls.list, [], "the pairing control point and connector status were never touched");
  } finally {
    await r.cleanup();
  }
});
