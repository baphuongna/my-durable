// FE regression: device identity surfaces show the device NAME, never the raw
// hex id or the machine hostname. Two devices on one host (common: hub machine
// plus a test device) must stay distinguishable in every label.
//   - NewSessionDialog dropdown: `d.name` (+ hostname only when it differs)
//   - NewSessionDialog working-dir label: the selected device's name
//   - AgentView lineage chip + Inspector server chip / app-state copy: name
// Caught live against the deployed hub: both dropdown options read
// "bom-Inspiron-7559" for two different devices (label used info.hostname).
import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

const fe = (p: string) => readFileSync(new URL(`../apps/dpi-playground-fe/src/${p}`, import.meta.url), "utf8");

test("device dropdown labels by name — hostname only as a differing suffix", () => {
  const src = fe("components/NewSessionDialog.vue");
  assert.match(src, /\{\{\s*d\.name\s*\}\}/, "option label starts with the device name");
  assert.doesNotMatch(src, /d\.id\s*·\s*d\.info\?\.hostname/, "no `id · hostname` label (the live bug)");
  assert.match(src, /Working directory on \{\{\s*devices\.find/, "working-dir label resolves the name");
});

test("agent lineage and inspector chips show the device name", () => {
  const lineage = fe("components/AgentView.vue");
  assert.match(lineage, /device\?\.name\s*\?\?\s*device\?\.id/, "lineage device chip uses name first");
  const inspector = fe("components/Inspector.vue");
  assert.match(inspector, /device\?\.name\s*\?\?\s*device\?\.id/, "inspector server chip uses name first");
  assert.match(
    inspector.replace(/\s+/g, " "),
    /fork on \{\{\s*device\?\.name\s*\?\?\s*device\?\.id\s*\}\}/,
    "app-state description names the device",
  );
});
