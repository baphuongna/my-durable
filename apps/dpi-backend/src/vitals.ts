/**
 * Device vitals: the one screen that answers "is this box healthy?" without
 * opening a terminal. Mirrors the shape herdr prints for a device (`uptime`,
 * `since`) and piggery's `top`, and reuses the statfs disk guard pattern from
 * the hub's audit volume check (`audit.ts` `volumeFreeBytes`).
 *
 * Everything here is cheap and synchronous — no polling on our side, the UIs
 * ask when they are looked at.
 */
import { statfsSync } from "node:fs";
import { cpus, loadavg, uptime as osUptime, freemem, totalmem } from "node:os";
import { monitorEventLoopDelay } from "node:perf_hooks";

// --- Event-loop lag (R7 perf lane) -----------------------------------------
//
// The R6 soak caught the device event loop stalling up to 1.44 s while the
// paired hub stayed ≤9 ms on the same machine — load-average says "healthy",
// RTT spikes say "blocked". host loadavg cannot see that (it is host-wide),
// so vitals carries its own lag numbers. `monitorEventLoopDelay` is a native
// histogram (one C++ sampler, no JS churn), measurably lighter than a JS
// setInterval-drift probe and immune to the very stalls it measures.

/** One window of lag samples (a 1 s "window" is the worst delay in that second). */
const LAG_WINDOW = 60;
const LAG_SAMPLE_MS = 1_000;
/** Histogram resolution in ms; 20 (the Node default) is plenty — we hunt ≥500 ms stalls. */
const LAG_RESOLUTION_MS = 20;

let lagHistogram: ReturnType<typeof monitorEventLoopDelay> | null = null;
let lagRing: number[] = [];

export interface EventLoopLagVitals {
  /** Worst event-loop delay in the most recent 1 s window, ms (0 before the first window completes). */
  lagMsLast: number;
  /** Worst delay across the last 60 windows (a rolling minute), ms. */
  lagMsMax1m: number;
  /** Windows sampled so far — grows to 60 as the process ages; <60 right after boot. */
  samples: number;
}

/**
 * Start (once; idempotent) the event-loop lag monitor. Called at daemon boot
 * (`main.ts`) so the minute-window has history from the start, and lazily from
 * `deviceVitals()` so any context that only reads vitals still gets numbers.
 */
export function startEventLoopMonitor(): void {
  if (lagHistogram) return;
  lagHistogram = monitorEventLoopDelay({ resolution: LAG_RESOLUTION_MS });
  lagHistogram.enable();
  const tick = setInterval(() => {
    const h = lagHistogram;
    if (!h) return;
    // Node's histogram records NANOseconds even though `resolution` is in ms
    // (verified by tests/vitals-lag.test.ts's ms-not-ns bound — 160 ms block
    // read as 168_689_663 before the /1e6).
    lagRing.push(h.max / 1e6); // worst delay since the previous tick, in ms
    h.reset();
    if (lagRing.length > LAG_WINDOW) lagRing.shift();
  }, LAG_SAMPLE_MS);
  tick.unref?.(); // never hold the process open just to keep counting
}

/** The rolling lag window. Starts the monitor on first use. */
export function eventLoopLag(): EventLoopLagVitals {
  startEventLoopMonitor();
  let max = 0;
  let last = 0;
  for (const v of lagRing) {
    if (v > max) max = v;
    last = v;
  }
  return { lagMsLast: Math.round(last), lagMsMax1m: Math.round(max), samples: lagRing.length };
}

/** Stop and forget the monitor (tests; daemon teardown). */
export function stopEventLoopMonitor(): void {
  lagHistogram?.disable();
  lagHistogram = null;
  lagRing = [];
}

export interface DiskVitals {
  path: string;
  totalBytes: number;
  freeBytes: number;
  /** False when the platform/filesystem cannot answer (Windows without statfs). */
  known: boolean;
}

export interface DeviceVitals {
  /** Seconds the host has been up. */
  uptime: number;
  /** Seconds the device process has been running (the daemon's own age). */
  processUptime: number;
  /** 1/5/15-minute load averages; zeros on Windows, which has no equivalent. */
  loadavg: [number, number, number];
  cpuCount: number;
  memory: { totalBytes: number; freeBytes: number; usedBytes: number; processRssBytes: number; heapUsedBytes: number };
  disk: DiskVitals;
  /** Event-loop lag — the number `loadavg` cannot express: how long ready JS waited to run. */
  eventLoop: EventLoopLagVitals;
  pid: number;
  at: number;
}

/** Free/total bytes for the volume holding `path`; `known: false` instead of throwing. */
export function diskVitals(path: string): DiskVitals {
  try {
    const stats = statfsSync(path);
    const total = stats.blocks * stats.bsize;
    const free = stats.bavail * stats.bsize;
    // Some filesystems report 0 blocks (synthetic mounts) — treat as unknown
    // rather than claiming the disk is full.
    if (!Number.isFinite(total) || total <= 0) return { path, totalBytes: 0, freeBytes: 0, known: false };
    return { path, totalBytes: total, freeBytes: free, known: true };
  } catch {
    return { path, totalBytes: 0, freeBytes: 0, known: false };
  }
}

export function deviceVitals(diskPath: string, startedAt: number, now = Date.now()): DeviceVitals {
  const load = loadavg();
  const total = totalmem();
  const free = freemem();
  const memory = process.memoryUsage();
  return {
    uptime: Math.round(osUptime()),
    processUptime: Math.max(0, Math.round((now - startedAt) / 1000)),
    loadavg: [load[0] ?? 0, load[1] ?? 0, load[2] ?? 0],
    cpuCount: cpus().length,
    memory: {
      totalBytes: total,
      freeBytes: free,
      usedBytes: Math.max(0, total - free),
      processRssBytes: memory.rss,
      heapUsedBytes: memory.heapUsed,
    },
    disk: diskVitals(diskPath),
    eventLoop: eventLoopLag(),
    pid: process.pid,
    at: now,
  };
}

/** "3d 4h", "12m", "45s" — the compact form both the CLI and the web card show. */
export function humanDuration(seconds: number): string {
  const s = Math.max(0, Math.floor(seconds));
  if (s < 60) return `${s}s`;
  const m = Math.floor(s / 60);
  if (m < 60) return `${m}m`;
  const h = Math.floor(m / 60);
  if (h < 24) return `${h}h ${m % 60}m`;
  return `${Math.floor(h / 24)}d ${h % 24}h`;
}

export function humanBytes(bytes: number): string {
  if (!Number.isFinite(bytes) || bytes <= 0) return "0 B";
  const units = ["B", "KiB", "MiB", "GiB", "TiB"];
  let value = bytes;
  let unit = 0;
  while (value >= 1024 && unit < units.length - 1) {
    value /= 1024;
    unit += 1;
  }
  return `${value >= 100 || unit === 0 ? Math.round(value) : value.toFixed(1)} ${units[unit]}`;
}
