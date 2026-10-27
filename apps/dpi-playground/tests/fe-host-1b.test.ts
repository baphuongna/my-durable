import { test } from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";

const R = (p: string) => readFile(new URL(p, import.meta.url), "utf8");

test("host-checklist Wave 1b: vitals, search and export reach every layer", async () => {
  // Device surface: the routes exist, and the literal search route is declared
  // before the `:s` param route or it would be swallowed by it.
  const routes = await R("../../dpi-backend/src/routes.ts");
  assert.match(routes, /r\.get\("\/device\/vitals"/, "vitals route missing");
  const searchAt = routes.indexOf('r.get("/sessions/search"');
  const paramAt = routes.indexOf('r.get("/sessions/:s"');
  assert.ok(searchAt > 0, "session search route missing");
  assert.ok(paramAt > 0 && searchAt < paramAt, "/sessions/search must precede /sessions/:s");
  // R8: the export handler grew a streaming body, so the route is declared multiline.
  assert.match(routes, /r\.get\(\s*"\/sessions\/:s\/export"/, "export route missing");

  // Tunnel allowlist: all three are remote-callable (they are safe reads).
  const allow = await R("../../dpi-sdk/src/protocol/rest-routes.ts");
  assert.match(allow, /\["GET", "\/device\/vitals"\]/, "vitals not tunnelled");
  assert.match(allow, /\["GET", "\/sessions\/search"\]/, "search not tunnelled");
  assert.match(allow, /\["GET", "\/sessions\/:s\/export"\]/, "export not tunnelled");

  // SDK client: the FE cannot call a route the client does not expose.
  const client = await R("../../dpi-sdk/src/client.ts");
  assert.match(client, /vitals\(\)/, "client vitals missing");
  assert.match(client, /searchSessions\(query: string\)/, "client search missing");
  assert.match(client, /exportSession\(sessionId: string, options: RequestOptions/, "client export missing");

  // FE: the host card, the search box, and the bundle button.
  const host = await R("../apps/dpi-playground-fe/src/components/HostPanel.vue");
  assert.match(host, /vitals\.uptime/, "uptime row missing");
  assert.match(host, /vitals\.loadavg/, "load row missing");
  assert.match(host, /vitals\.disk\.known/, "disk meter missing");
  assert.match(host, /watch\(deviceId, load, \{ immediate: true \}\)/, "vitals must load on first paint");
  const sidebar = await R("../apps/dpi-playground-fe/src/components/NetworkSidebar.vue");
  assert.match(sidebar, /searchSessions\(q\)/, "device-side search unused");
  assert.match(sidebar, /localRows/, "instant local filter missing");
  assert.match(sidebar, /extraHits/, "device-only hits section missing");
  const insp = await R("../apps/dpi-playground-fe/src/components/Inspector.vue");
  assert.match(insp, /downloadBundle/, "bundle download missing");
  const bundle = await R("../apps/dpi-playground-fe/src/client/export-bundle.ts");
  assert.match(
    bundle,
    /deviceClient\(d\)\.exportSession\(s\)/,
    "bundle download must call the device",
  );
  assert.match(insp, /id: "host"/, "host tab missing");
});
