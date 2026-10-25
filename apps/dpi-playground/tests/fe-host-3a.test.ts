/**
 * Wave 3 first slice: diagnostic bundle (redacted), keep-awake inhibitor, and
 * the two rows that close by DESIGN (ssh-interactivity via the tunnel,
 * bulk-resume via pi-durable's running→pending resume) — each claim pinned to
 * the file that carries it.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";

const R = (p: string) => readFile(new URL(p, import.meta.url), "utf8");

test("diagnostics: redaction → module → CLI → bin, sections fail independently", async () => {
  const module = await R("../../dpi-backend/src/diagnostics.ts");
  assert.match(module, /export function redact\(/, "no redactor");
  for (const pattern of ["dpi_", "Bearer", "sk-"])
    assert.ok(module.includes(pattern), `the redactor does not know ${pattern}`);
  assert.match(module, /failed|error/, "sections must record failures, not abort the bundle");
  assert.match(module, /zipSync/, "the bundle must be a zip");
  const cli = await R("../../dpi-backend/src/diagnostics-cli.ts");
  assert.match(cli, /export async function diagnosticsCli/, "no CLI");
  assert.match(cli, /\.zip/, "no bundle path");
  const bin = await R("../../../bin/dpi.mjs");
  assert.match(bin, /command === "diagnostics"/, "dpi diagnostics is not wired");
  const tests = await R("../../dpi-backend/tests/diagnostics.test.ts");
  assert.match(tests, /no raw|does not include|dpi_•/, "no test proves tokens are stripped");
});

test("keep-awake: inhibitor module → store wiring → deviceInfo → HostPanel", async () => {
  const module = await R("../../dpi-backend/src/awake.ts");
  assert.match(module, /--what=idle/, "must inhibit idle (the mode a user may hold)");
  assert.match(module, /Access denied/, "the sleep:block refusal must be documented in code");
  assert.match(module, /disabled/, "a failing spawn must disable, not spin");
  assert.match(module, /caffeinate/, "darwin path missing");
  const store = await R("../../dpi-backend/src/store.ts");
  assert.match(store, /new KeepAwake\(\)/, "the store does not own an inhibitor");
  assert.match(store, /scheduleAwakeSync/, "no debounce on notify");
  assert.match(store, /this\.awake\.sync\(busy\)/, "the busy count never reaches the inhibitor");
  assert.match(store, /unref/, "the debounce timer must not hold the process");
  assert.match(store, /keepAwake: this\.awake\.mode/, "deviceInfo does not report the mode");
  const api = await R("../../dpi-sdk/src/api.ts");
  assert.match(api, /keepAwake\?: "inhibit" \| "caffeinate" \| "none"/, "the type drifted");
  const host = await R("../apps/dpi-playground-fe/src/components/HostPanel.vue");
  assert.match(host, /keepAwake/, "HostPanel does not surface the capability");
  assert.ok(!/setInterval/.test(host), "the panel must not poll");
  const tests = await R("../../dpi-backend/tests/awake.test.ts");
  assert.match(tests, /never double-spawns/, "no idempotence test");
  assert.match(tests, /no-op/, "unsupported platforms must be tested");
});

test("bulk-resume closes by durability: running→pending→auto-dispatch, no click", async () => {
  const store = await R("../../dpi-backend/src/store.ts");
  assert.match(store, /harness\.resume\(\)/, "boot does not resume interrupted sessions");
  // The pi-durable contract the claim rests on (read from the installed lib):
  const scheduler = await R(
    "../../dpi-backend/node_modules/@earendil-works/pi-durable/dist/harness/scheduler.d.ts",
  );
  assert.match(scheduler, /surviving `running` tasks back to `pending`/, "running tasks are not requeued");
});

test("ssh-interactivity closes by design: the tunnel IS the remote channel", async () => {
  const allow = await R("../../dpi-sdk/src/protocol/rest-routes.ts");
  assert.match(allow, /Everything else under \/v1 is refused/, "the tunnel is not allowlisted");
  for (const route of ['"/fs/dirs"', '"/git"', '"/sessions"'])
    assert.ok(allow.includes(route), `remote ${route} is not already served over the tunnel`);
  const config = await R("../../dpi-sdk/src/node/config.ts");
  assert.match(config, /kind === "ssh"/, "ssh as a bring-up transport kind must still exist");
  const drivers = await R("../../dpi-sdk/src/node/drivers.ts");
  assert.match(drivers, /sshDriver/, "no ssh driver for `just net up`");
});
