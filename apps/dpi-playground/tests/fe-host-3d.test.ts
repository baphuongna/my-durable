/**
 * Gates #1 + #2 wiring contract: crash handlers live in the daemon entry,
 * doctor surfaces reports, the pi-auth surface is write-only end to end.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";

const R = (p: string) => readFile(new URL(p, import.meta.url), "utf8");

test("gate #1: crash handlers installed before anything can fail", async () => {
  const main = await R("../../dpi-backend/src/main.ts");
  assert.match(main, /installCrashHandlers\(\{/, "handlers not installed");
  const before = main.indexOf("installCrashHandlers({");
  const cfgAt = main.indexOf("await loadConfig()");
  assert.ok(before >= 0 && cfgAt > before, "handlers must run BEFORE loadConfig");
  assert.match(main, /crashStore = store/, "the state getter never sees the store");
  const crash = await R("../../dpi-backend/src/crash.ts");
  assert.match(crash, /## not included/, "report must state what it excludes");
  assert.match(crash, /No environment values, tokens, credentials/, "the privacy line is explicit");
  const doctor = await R("../../dpi-backend/src/doctor.ts");
  assert.match(doctor, /crashReportCheck/, "doctor does not list crash reports");
});

test("gate #2: the surface is write-only and tunnelled", async () => {
  const routes = await R("../../dpi-backend/src/routes.ts");
  const block = routes.slice(routes.indexOf("-- pi provider keys"), routes.indexOf('r.delete("/device/pi-auth/:provider"') + 200);
  assert.ok(block.includes('r.put("/device/pi-auth/:provider"'), "no write route");
  assert.match(block, /WRITE-ONLY/, "the write-only rule is not stated at the route");
  const view = routes.slice(routes.indexOf('r.get("/device/pi-auth"'), 300);
  assert.ok(!/body\.key[^)]*res\.json\(body/.test(view), "the key must never be echoed");
  const allow = await R("../../dpi-sdk/src/protocol/rest-routes.ts");
  for (const route of ['["GET", "/device/pi-auth"]', '["PUT", "/device/pi-auth/:provider"]', '["DELETE", "/device/pi-auth/:provider"]'])
    assert.ok(allow.includes(route), `${route} not tunnelled`);
  const client = await R("../../dpi-sdk/src/client.ts");
  assert.match(client, /setPiApiKey\(providerId: string, key: string\)/, "no client write method");
  const res = client.slice(client.indexOf("setPiApiKey"));
  assert.match(res.slice(0, 300), /\{ key \}/, "the key travels in the body only");
});

test("gate #2: the panel never renders a value; the input is a password field", async () => {
  const panel = await R("../apps/dpi-playground-fe/src/components/EnvPanel.vue");
  assert.match(panel, /PI KEYS/, "no pi-keys section");
  assert.match(panel, /type="password"/, "the key input must be masked while typing");
  assert.match(panel, /autocomplete="off"/, "browsers must not remember the key");
  assert.match(panel, /keyDraft\.value = \{ providerId: "", key: "" \};/, "the key must be cleared after a save");
  assert.ok(!/\{\{\s*k\.key\s*\}\}/.test(panel), "no raw key interpolation");
  assert.match(panel, /loadKeys/, "no loader");
  assert.ok(!/setInterval/.test(panel), "the panel must not poll");
});
