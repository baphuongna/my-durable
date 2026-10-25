/**
 * Wave 2 SHOULD: notification sinks end to end, and the rate-limit hint that
 * `dpi doctor` prints instead of a bare "model_error".
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";

const R = (p: string) => readFile(new URL(p, import.meta.url), "utf8");

test("notify sinks: module → store → routes → tunnel → CLI → panel", async () => {
  const module = await R("../../dpi-backend/src/notify-sinks.ts");
  assert.match(module, /class NotifySinks/, "no registry");
  assert.match(module, /allowPrivateHosts/, "SSRF opt-in flag missing");
  assert.match(module, /cooldown/i, "burst cooldown missing");
  const store = await R("../../dpi-backend/src/store.ts");
  assert.match(store, /NotifySinks\.open/, "the sinks are not opened with the store");
  assert.match(store, /notifyEvent/, "no fan-out helper");
  assert.match(store, /kind: "session.failed"/, "a failed session must notify");
  assert.match(store, /kind: "schedule\.failed"/, "a failed schedule must notify");
  assert.match(store, /kind: "schedule\.ok"/, "a successful schedule must notify");
  const routes = await R("../../dpi-backend/src/routes.ts");
  for (const route of ['r.get("/notify/sinks"', 'r.post("/notify/sinks"', 'r.patch("/notify/sinks/:id"', 'r.delete("/notify/sinks/:id"', 'r.post("/notify/test"'])
    assert.ok(routes.includes(route), `${route} missing`);
  const allow = await R("../../dpi-sdk/src/protocol/rest-routes.ts");
  assert.match(allow, /\["POST", "\/notify\/test"\]/, "test is not tunnelled");
  const client = await R("../../dpi-sdk/src/client.ts");
  for (const m of ["notifySinks(", "createNotifySink(", "testNotifySinks("]) assert.ok(client.includes(m), `${m} missing`);
  const cli = await R("../../dpi-backend/src/notify-cli.ts");
  assert.match(cli, /export async function notifyCli/, "no CLI");
  const bin = await R("../../../bin/dpi.mjs");
  assert.match(bin, /command === "notify"/, "dpi notify is not wired");
  const panel = await R("../apps/dpi-playground-fe/src/components/NotifyPanel.vue");
  assert.match(panel, /notifySinks\(\)/, "the panel does not read the device");
  assert.match(panel, /testNotifySinks\(\)/, "no test button");
  assert.match(panel, /watch\(deviceId, load, \{ immediate: true \}\)/, "must load on first paint");
  assert.ok(!/setInterval/.test(panel), "the panel must not poll");
  const insp = await R("../apps/dpi-playground-fe/src/components/Inspector.vue");
  assert.match(insp, /<NotifyPanel v-if="ui\.tab === 'notify'" \/>/, "the panel is not rendered");
});

test("rate limits are named, not just 'model_error'", async () => {
  const store = await R("../../dpi-backend/src/store.ts");
  assert.match(store, /export function classifyProviderError/, "no classifier");
  assert.match(store, /rate_limited/, "rate limits are not classified");
  assert.match(store, /retryAfterMs/, "the retry hint is dropped");
  assert.match(store, /lastProviderError/, "the provider's own words are not read");
  const api = await R("../../dpi-sdk/src/api.ts");
  assert.match(api, /export interface ModelProbe/, "ModelProbe missing");
  assert.match(api, /"rate_limited" \| "auth" \| "missing" \| "error"/, "probe status union drifted");
  const doctor = await R("../../dpi-backend/src/doctor.ts");
  assert.match(doctor, /rate limited/, "doctor does not explain a rate limit");
  assert.match(doctor, /provider key rejected/, "doctor does not explain an auth failure");
});
