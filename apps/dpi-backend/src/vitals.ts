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
