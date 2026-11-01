// Run-15 Unit A — u3-2 MED (render crash): renderOps' VITALS section read the
// wire shape with bare derefs — v.loadavg.map / v.memory.* / v.disk.known all
// throw on a hostile/partial DeviceVitals (SSE frames are JSON.parse casts,
// typed only by convention). The section builder runs on EVERY frame, so one
// bad vitals payload killed the whole ops view. RED first at base 0b629ea.
import { test } from "node:test";
import assert from "node:assert/strict";
import type { DeviceVitals } from "../../dpi-sdk/src/api.ts";
import { renderOps } from "../src/views.ts";
import { stripAnsi } from "./harness/strip.ts";

const NOW = 1_700_000_000_000;

// Hostile shapes: each one must DEGRADE (render muted/zeroed rows), never
// throw. {uptime:1} is the minimal frame; "x"-loadavg and null memory/disk
// are the hunter's exact probes.
const HOSTILE: [name: string, vitals: unknown][] = [
  ["minimal frame {uptime:1}", { uptime: 1 }],
  ["string loadavg", { uptime: 1, loadavg: "x" }],
  ["null memory", { uptime: 1, memory: null }],
  ["null disk", { uptime: 1, disk: null }],
  ["loadavg null", { uptime: 1, loadavg: null }],
  ["counts as string", { uptime: 1, counts: "x" }],
];

test("run-15 u3-2: hostile vitals shapes render degraded rows, never throw", () => {
  for (const [name, vitals] of HOSTILE) {
    let lines: string[] = [];
    assert.doesNotThrow(
      () => (lines = renderOps(80, { vitals: vitals as never as DeviceVitals }, { now: NOW })),
      `${name} must not throw in renderOps`,
    );
    const flat = lines.map(stripAnsi).join(String.fromCharCode(10));
    // Degraded ≠ blank: the section still renders its rows (up X, load …).
    assert.match(flat, /VITALS/, `${name}: the section header survives`);
    assert.match(flat, /up /, `${name}: the uptime row renders`);
  }
});

test("run-15 u3-2: degraded loadavg/memory render as empty/zero, not NaN chrome", () => {
  const lines = renderOps(80, { vitals: { uptime: 1, loadavg: "x" } as never as DeviceVitals }, { now: NOW });
  const flat = lines.map(stripAnsi).join(String.fromCharCode(10));
  assert.doesNotMatch(flat, /NaN/, "a string loadavg must not print NaN");
  // memory:null → every byte field coerces to 0B through humanBytes.
  const mem = renderOps(80, { vitals: { uptime: 1, memory: null } as never as DeviceVitals }, { now: NOW });
  assert.match(mem.map(stripAnsi).join(String.fromCharCode(10)), /mem /, "the mem row survives a null memory");
});

test("run-15 u3-2: the healthy fixture still renders all five VITALS rows", () => {
  const healthy: DeviceVitals = {
    uptime: 3 * 86400,
    processUptime: 3600,
    loadavg: [0.42, 0.35, 0.31],
    cpuCount: 8,
    memory: { totalBytes: 1, freeBytes: 1, usedBytes: 1, processRssBytes: 1, heapUsedBytes: 1 },
    disk: { path: "/d", totalBytes: 1, freeBytes: 1, known: true },
    eventLoop: { lagMsLast: 4, lagMsMax1m: 38, samples: 60 },
    gitSpawns: { live: 2, queued: 1, queuedHigh: 3, queuedAged: 1 },
    pid: 1,
    at: 0,
    counts: { sessions: 7, archived: 3 },
  };
  const flat = renderOps(80, { vitals: healthy }, { now: NOW }).map(stripAnsi).join(String.fromCharCode(10));
  for (const marker of ["up ", "mem ", "disk ", "evlag ", "git ", "sessions 7"])
    assert.ok(flat.includes(marker), `healthy vitals keep their rows: ${marker}`);
  assert.match(flat, /0\.42 0\.35 0\.31/, "loadavg values render");
});
