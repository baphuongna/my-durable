import { test } from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";

const R = (p: string) => readFile(new URL(p, import.meta.url), "utf8");

test("host-checklist Wave 1a: every FE-only feature is in the bundle sources", async () => {
  const store = await R("../apps/dpi-playground-fe/src/client/store.ts");
  assert.match(store, /notifications\.unshift/, "notification history missing");
  assert.match(store, /markNotificationsRead/, "mark-read missing");
  const top = await R("../apps/dpi-playground-fe/src/components/TopBar.vue");
  assert.match(top, /notif-panel/, "bell panel missing");
  assert.match(top, /usage-chip/, "session usage chip missing");
  const nsd = await R("../apps/dpi-playground-fe/src/components/NewSessionDialog.vue");
  assert.match(nsd, /dpi-recent-cwds/, "recent cwds missing");
  assert.match(nsd, /rememberCwd/, "recents not recorded on create");
  const comp = await R("../apps/dpi-playground-fe/src/components/Composer.vue");
  assert.match(comp, /dpi-prompt-library/, "prompt library missing");
  assert.match(comp, /saveCurrent/, "save-snippet missing");
  assert.match(comp, /dropSnippet/, "delete-snippet missing");
  const sidebar = await R("../apps/dpi-playground-fe/src/components/NetworkSidebar.vue");
  assert.match(sidebar, /bulkMode/, "bulk select mode missing");
  assert.match(sidebar, /bulkRun/, "bulk archive/abort missing");
  const row = await R("../apps/dpi-playground-fe/src/components/TreeRow.vue");
  assert.match(row, /bulk-check/, "row checkbox missing");
  const insp = await R("../apps/dpi-playground-fe/src/components/Inspector.vue");
  assert.match(insp, /downloadTranscript/, "transcript download missing");
  assert.match(insp, /usage-total/, "usage total row missing");
});
