import { test } from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";

const R = (p: string) => readFile(new URL(p, import.meta.url), "utf8");

test("usage panel (fe-host-2): the device rollup reaches the UI it is drawn from", async () => {
  // Device surface — the panel is only as good as the route behind it.
  const routes = await R("../../dpi-backend/src/routes.ts");
  assert.match(routes, /r\.get\("\/device\/usage"/, "device usage route missing");
  const allow = await R("../../dpi-sdk/src/protocol/rest-routes.ts");
  assert.match(allow, /\["GET", "\/device\/usage"\]/, "device usage not tunnelled");

  // SDK: the FE cannot call what the client does not expose, and the panel is
  // typed against DeviceUsageReport — pin both so the panel cannot drift.
  const client = await R("../../dpi-sdk/src/client.ts");
  assert.match(client, /deviceUsage\(\)/, "client deviceUsage missing");
  assert.match(client, /DeviceUsageReport/, "deviceUsage must be typed as DeviceUsageReport");
  const api = await R("../../dpi-sdk/src/api.ts");
  assert.match(api, /export interface DeviceUsageReport/, "DeviceUsageReport missing from the SDK api");
  for (const field of ["totals", "models", "sessions", "projects"]) {
    assert.ok(api.includes(`${field}`), `DeviceUsageReport.${field} missing`);
  }
  const hub = await R("../apps/dpi-playground-fe/src/client/hub.ts");
  assert.match(hub, /export const deviceClient/, "deviceClient missing from the hub client");
  assert.match(hub, /export const message/, "message() error helper missing from the hub client");
});

test("usage panel (fe-host-2): loads lazily, refreshes on demand, never polls", async () => {
  const panel = await R("../apps/dpi-playground-fe/src/components/UsagePanel.vue");

  // The load call goes through the device client for the selected device.
  assert.match(panel, /deviceUsage\(\)/, "panel must call deviceUsage()");
  assert.match(panel, /deviceClient\(id\)\.deviceUsage\(\)/, "usage must come from the selected device");
  assert.match(panel, /selected\.value\?\.deviceId/, "panel must read the selected device");

  // First paint + device switch, exactly like HostPanel.
  assert.match(panel, /watch\(deviceId, load, \{ immediate: true \}\)/, "usage must load on first paint");

  // Refresh button: labelled, disabled while busy, and it notifies.
  assert.match(panel, /aria-label="Refresh usage"/, "refresh button needs its aria-label");
  assert.match(panel, /notify\("Usage refreshed\."\)/, "refresh must notify");

  // Lazy by design — a timer would make this a polling panel.
  assert.ok(!/setInterval|setTimeout\(.*load/.test(panel), "the usage panel must never poll");

  // Error + empty states use the app's own classes.
  assert.match(panel, /class="message-error"/, "errors must use message-error");
  assert.match(panel, /No usage recorded yet\./, "empty state copy missing");
  assert.match(panel, /class="hint"/, "hints must use the hint class");
});

test("usage panel (fe-host-2): three blocks, share meter, a11y labels", async () => {
  const panel = await R("../apps/dpi-playground-fe/src/components/UsagePanel.vue");

  // The three blocks the dashboard promises.
  assert.match(panel, />TOTALS</, "totals heading missing");
  assert.match(panel, />BY MODEL</, "by-model heading missing");
  assert.match(panel, />BY PROJECT</, "by-project heading missing");
  assert.match(panel, />BY SESSION</, "by-session heading missing");

  // Totals formatting matches the TopBar usage chip.
  assert.match(panel, /toFixed\(4\)/, "cost must render as $0.0123");
  assert.match(panel, /toLocaleString\("en-US"\)/, "tokens must carry thousands separators");

  // The by-model table: model key, tokens, cost, and a share meter with the
  // accessibility contract the design system requires.
  assert.match(panel, /aria-label="Usage by model"/, "model table needs an aria-label");
  assert.match(panel, /role="meter"/, "share bar must be a meter");
  assert.match(panel, /aria-valuenow|:aria-valuenow/, "meter needs aria-valuenow");
  assert.match(panel, /aria-valuemin="0"/, "meter needs aria-valuemin");
  assert.match(panel, /aria-valuemax="100"/, "meter needs aria-valuemax");

  // Session rows carry the project sub-label and the cwd in a title.
  assert.match(panel, /:title="s\.cwd"/, "session cwd must be in a title attribute");
  assert.match(panel, /s\.project \?\? s\.cwd/, "session rows must show their project");

  // Design system: panel-heading + lucide icon + accent bars, scoped styles.
  assert.match(panel, /class="panel-heading"/, "panels must use .panel-heading");
  assert.match(panel, /<Activity :size="16" \/>USAGE/, "heading needs the Activity icon + USAGE label");
  assert.match(panel, /from "lucide-vue-next"/, "icons must come from lucide-vue-next");
  assert.match(panel, /var\(--accent\)/, "bars must use var(--accent)");
  assert.match(panel, /var\(--warn, #e5a50a\)/, "high shares must use the warn colour");
  assert.match(panel, /var\(--line\)/, "borders must use var(--line)");
  assert.match(panel, /border-radius: 0\.625rem/, "cards rounded (10px-designed, now rem so it scales with the ui)");
  assert.match(panel, /font-variant-numeric: tabular-nums/, "numbers must be tabular");
  assert.match(panel, /<style scoped>/, "styles must be scoped");

  // Wiring the tab belongs to the leader: the panel stays self-contained, it
  // pulls in no other component (so no two workers edit the same file).
  for (const dep of panel.matchAll(/from "(\.\.?\/[^"]+)"/g)) {
    assert.match(dep[1], /^\.\.?\/client\//, `UsagePanel must not import ${dep[1]} — tab wiring is out of scope`);
  }
});
