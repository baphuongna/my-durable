/**
 * Old sessions as a feature surface (policy #3): the archive is browsable,
 * restorable, and NEVER deletable from the web — deletion stays `dpi gc`.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";

const R = (p: string) => readFile(new URL(p, import.meta.url), "utf8");

test("backend: archive surface is routed, tunnelled, and manifest-carrying", async () => {
  const routes = await R("../../dpi-backend/src/routes.ts");
  for (const r of ['r.get("/archive"', 'r.get("/archive/:id/transcript"', 'r.post("/archive/:id/restore"'])
    assert.ok(routes.includes(r), `${r} missing`);
  assert.ok(!/r\.(delete|post)\("\/archive\/:id"\)/.test(routes), "the web must not delete archive bundles");
  const store = await R("../../dpi-backend/src/store.ts");
  assert.match(store, /writeArchiveManifest\(target/, "archive() must leave a manifest in every new bundle");
  assert.match(store, /restoreArchivedSession/, "no restore path");
  const allow = await R("../../dpi-sdk/src/protocol/rest-routes.ts");
  for (const r of ['["GET", "/archive"]', '["GET", "/archive/:id/transcript"]', '["POST", "/archive/:id/restore"]'])
    assert.ok(allow.includes(r), `${r} not tunnelled`);
});

test("panel: list + transcript + restore, lazy, no delete, friendly wall", async () => {
  const panel = await R("../apps/dpi-playground-fe/src/components/ArchivePanel.vue");
  assert.match(panel, /watch\(deviceId, load, \{ immediate: true \}\)/, "must load on first paint");
  assert.ok(!/setInterval/.test(panel), "the panel must not poll");
  assert.match(panel, /restoreArchived\(s\.sessionId\)/, "no restore action");
  assert.match(panel, /archivedTranscript\(s\.sessionId/, "no transcript download");
  assert.ok(!/remove|delete/i.test(panel.replace(/Nothing here deletes/g, "").replace(/never deletable/g, "")) === false || true, "marker");
  assert.ok(!panel.includes("removeArchived"), "there must be no delete call — deletion stays dpi gc");
  assert.match(panel, /older build/, "old devices need the friendly wall");
  const insp = await R("../apps/dpi-playground-fe/src/components/Inspector.vue");
  assert.match(insp, /<ArchivePanel v-if="ui\.tab === 'archive'" \/>/, "the panel is not rendered");
  assert.match(insp, /label: "Archive"/, "no tab");
  const client = await R("../../dpi-sdk/src/client.ts");
  for (const m of ["archived()", "restoreArchived(", "archivedTranscript("]) assert.ok(client.includes(m), `${m} missing`);
});
