/**
 * Wave 2 SHOULD (last three rows): env-var management UI, backup/restore CLI,
 * per-project default model — module → store → routes → tunnel → CLI → panel.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";

const R = (p: string) => readFile(new URL(p, import.meta.url), "utf8");

test("env UI: module → store → routes → tunnel → client → panel", async () => {
  const module = await R("../../dpi-backend/src/env-vars.ts");
  assert.match(module, /class EnvFileEditor/, "no editor");
  assert.match(module, /READONLY_KEYS/, "managed keys are not fenced off");
  assert.match(module, /maskValue/, "secrets are not masked");
  assert.match(module, /source: "file" \| "process"/, "process vars must be distinguishable");
  const store = await R("../../dpi-backend/src/store.ts");
  assert.match(store, /envView\(\)/, "store does not expose the env view");
  assert.match(store, /setEnvVar/, "no set");
  assert.match(store, /removeEnvVar/, "no remove");
  assert.match(store, /envFile: options\.envFile|options\.envFile \?\?/, "the env file is not wired from config");
  const routes = await R("../../dpi-backend/src/routes.ts");
  for (const route of ['r.get("/device/env"', 'r.post("/device/env"', 'r.delete("/device/env/:key"'])
    assert.ok(routes.includes(route), `${route} missing`);
  const allow = await R("../../dpi-sdk/src/protocol/rest-routes.ts");
  for (const route of ['["GET", "/device/env"]', '["POST", "/device/env"]', '["DELETE", "/device/env/:key"]'])
    assert.ok(allow.includes(route), `${route} not tunnelled`);
  const client = await R("../../dpi-sdk/src/client.ts");
  for (const m of ["envView()", "setEnvVar(", "removeEnvVar("]) assert.ok(client.includes(m), `${m} missing`);
  const panel = await R("../apps/dpi-playground-fe/src/components/EnvPanel.vue");
  assert.match(panel, /envView\(\)/, "the panel does not read the env file");
  assert.match(panel, /restartRequired/, "no restart hint");
  assert.match(panel, /managed/, "managed keys must be visibly read-only");
  assert.match(panel, /watch\(deviceId, load, \{ immediate: true \}\)/, "must load on first paint");
  assert.ok(!/setInterval/.test(panel), "the panel must not poll");
  const insp = await R("../apps/dpi-playground-fe/src/components/Inspector.vue");
  assert.match(insp, /<EnvPanel v-if="ui\.tab === 'env'" \/>/, "the panel is not rendered");
});

test("env values that look like secrets never travel", async () => {
  const module = await R("../../dpi-backend/src/env-vars.ts");
  assert.match(module, /SECRET_KEY/, "no secret-name matcher");
  assert.match(module, /TOKEN\|SECRET\|PASSWORD/, "the matcher does not cover the usual names");
  // DPI_NOTIFY_ALLOW_PRIVATE=1 is a FLAG, not a secret — bare PRIVATE must not match.
  assert.ok(!/TOKEN\|SECRET\|PASSWORD\|PASSWD\|API_KEY\|_KEY\$\|PRIVATE\|/.test(module), "bare PRIVATE leaked back in");
});

test("backup/restore: module → tests → CLI → bin", async () => {
  const module = await R("../../dpi-backend/src/backup.ts");
  assert.match(module, /export class BackupError/, "no typed error");
  assert.match(module, /device_running/, "a running daemon must be a typed refusal");
  assert.match(module, /restoreBackup/, "no restore");
  assert.match(module, /\.bak-/, "the old home must be kept");
  const cli = await R("../../dpi-backend/src/backup-cli.ts");
  assert.match(cli, /export async function backupCli/, "no CLI");
  assert.match(cli, /--yes/, "restore must be plan-first");
  const bin = await R("../../../bin/dpi.mjs");
  assert.match(bin, /command === "backup"/, "dpi backup is not wired");
  assert.match(bin, /backupCli\(\{ argv: commandRest \}\)/, "the CLI is not called with the subcommand");
});

test("per-project default model: registry → store → patch route → FE", async () => {
  const projects = await R("../../dpi-backend/src/projects.ts");
  assert.match(projects, /model\?: \{ provider: string; modelId: string \}/, "no model on the record");
  assert.match(projects, /model needs a provider and a modelId/, "no validation");
  const store = await R("../../dpi-backend/src/store.ts");
  assert.match(store, /projectForPath/, "no longest-root lookup");
  assert.match(store, /explicit \?\? projectDefault/, "an explicit model must win, then the project's");
  const routes = await R("../../dpi-backend/src/routes.ts");
  assert.match(routes, /model must be \{ provider, modelId \} or ""/, "the patch route does not validate model");
  const bar = await R("../apps/dpi-playground-fe/src/components/ProjectBar.vue");
  assert.match(bar, /defaultModel\(item\)/, "no default-model editor");
  assert.match(bar, /updateProject\(project\.id, \{ model/, "the editor does not PATCH the project");
  assert.match(bar, /is not in this device's catalog/, "the editor must validate against the catalog");
  const dialog = await R("../apps/dpi-playground-fe/src/components/NewSessionDialog.vue");
  assert.match(dialog, /projectModels/, "the new-session dialog ignores project defaults");
  assert.match(dialog, /sort\(\(a, b\) => b\.length - a\.length\)/, "longest registered root must win");
  assert.match(dialog, /draft\.value\.model = `\$\{model\.provider\}\/\$\{model\.modelId\}`/, "the picker is not prefilled");
  assert.ok(!/setInterval/.test(dialog), "the dialog must not poll projects");
});
