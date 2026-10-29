// One loop per registry device: probe /v1/device, classify, then follow /v1/events for trees.
// Status machine: checking → online | offline | unauthorized | mismatch | incompatible, retrying
// with backoff (offline: 1s → 30s; states only a human can fix: 30s or an explicit check()).
import { DpiError } from "../../../../dpi-sdk/src/errors.js";
import { transportFor, type DeviceTransport } from "./transport.js";
import type {
  DeviceInfo,
  DeviceStatus,
  DeviceTree,
  NetworkDevice,
  TunnelDiagnostics,
} from "../../../../dpi-sdk/src/api.js";
import { toPublic, type NetworkRegistry } from "../../../../dpi-sdk/src/node/registry.js";
import { Backoff } from "../../../../dpi-sdk/src/protocol/backoff.js";
import { MONITOR_BACKOFF_S } from "../../../../dpi-sdk/src/protocol/limits.js";

export interface LiveState {
  status: DeviceStatus;
  error?: string;
  info?: DeviceInfo;
  tree?: DeviceTree;
  lastSeenAt?: number;
}

const sleep = (ms: number, signal: AbortSignal) =>
  new Promise<void>((resolve) => {
    if (signal.aborted) return resolve();
    // R18 (run-4 h5): remove the abort listener on the timer path too — a
    // completed sleep used to leave one listener on the long-lived signal,
    // and a flapping device retained closures without bound.
    const onAbort = () => (clearTimeout(timer), resolve());
    const timer = setTimeout(() => (signal.removeEventListener("abort", onAbort), resolve()), ms);
    signal.addEventListener("abort", onAbort, { once: true });
  });

export interface TunnelTransportSource {
  dispatcherFor(row: { id: string; transport: string }): DeviceTransport;
  /** True when the device currently has an authenticated tunnel connection. */
  hasLiveConnection(deviceId: string): boolean;
  diagnostics?(deviceId: string): TunnelDiagnostics;
}

export class DeviceMonitor {
  private live = new Map<string, LiveState>();
  private loops = new Map<string, AbortController>();
  private wakers = new Map<string, () => void>();
  private listeners = new Set<() => void>();
  private persistedAt = new Map<string, number>();
  private emitTimer?: ReturnType<typeof setTimeout>;

  private tunnel?: TunnelTransportSource;

  constructor(private readonly registry: NetworkRegistry) {}

  start() {
    for (const device of this.registry.list()) this.watch(device.id);
  }

  stop() {
    for (const ctl of this.loops.values()) ctl.abort();
    this.loops.clear();
  }

  watch(id: string) {
    this.loops.get(id)?.abort();
    const ctl = new AbortController();
    this.loops.set(id, ctl);
    this.live.set(id, { ...this.live.get(id), status: "checking", error: undefined });
    this.emit();
    void this.loop(id, ctl.signal);
  }

  forget(id: string) {
    this.loops.get(id)?.abort();
    this.loops.delete(id);
    this.live.delete(id);
    this.emit();
  }

  /** Re-probe now (after a token edit or a manual refresh). */
  check(id: string) {
    this.watch(id);
  }

  state(id: string): LiveState | undefined {
    return this.live.get(id);
  }

  network(): NetworkDevice[] {
    const pairings = this.registry.publicPairings();
    return this.registry.list().map((row) =>
      toPublic(row, this.live.get(row.id), {
        pairing: pairings.get(row.id),
        ...(row.transport === "tunnel"
          ? {
              tunnel: this.tunnel?.diagnostics?.(row.id) ?? {
                state: this.tunnel?.hasLiveConnection(row.id) ? "connected" : "disconnected",
                readerCount: 0,
              },
            }
          : {}),
      }),
    );
  }

  /** Wire the tunnel dispatcher source (main.ts, after construction). */
  setTunnelSource(source: TunnelTransportSource): void {
    this.tunnel = source;
    for (const device of this.registry.list())
      if (device.transport === "tunnel") this.watch(device.id);
  }

  onChange(fn: () => void) {
    this.listeners.add(fn);
    return () => void this.listeners.delete(fn);
  }

  /** Pairing/transport metadata changed independently of the device health loop. */
  refresh() {
    this.emit();
  }

  /** Resolve once the device is online (or the signal aborts). */
  async whenOnline(id: string, signal: AbortSignal) {
    while (!signal.aborted && this.live.get(id)?.status !== "online") {
      await new Promise<void>((resolve) => {
        const off = this.onChange(() => {
          if (this.live.get(id)?.status === "online") done();
        });
        const timer = setTimeout(() => done(), 5000);
        const done = () => {
          off();
          clearTimeout(timer);
          signal.removeEventListener("abort", done);
          resolve();
        };
        signal.addEventListener("abort", done, { once: true });
      });
    }
  }

  /** Resolve when the device leaves `checking` (bounded). */
  async settled(id: string, timeoutMs = 8000) {
    const end = Date.now() + timeoutMs;
    while (Date.now() < end && this.live.get(id)?.status === "checking")
      await new Promise((r) => setTimeout(r, 100));
    return this.network().find((d) => d.id === id);
  }

  private emit() {
    if (this.emitTimer) return;
    this.emitTimer = setTimeout(() => {
      this.emitTimer = undefined;
      for (const fn of this.listeners) fn();
    }, 50);
  }

  private update(id: string, patch: Partial<LiveState>) {
    if (!this.loops.has(id)) return;
    const previous = this.live.get(id);
    const next: LiveState = { ...previous, ...patch } as LiveState;
    this.live.set(id, next);
    const statusChanged = previous?.status !== next.status || previous?.error !== next.error;
    const now = Date.now();
    if (statusChanged || now - (this.persistedAt.get(id) ?? 0) > 10_000) {
      this.persistedAt.set(id, now);
      try {
        this.registry.recordStatus(id, {
          status: next.status,
          error: next.error ?? null,
          ...(next.lastSeenAt ? { seenAt: next.lastSeenAt } : {}),
          ...(next.info ? { info: next.info } : {}),
          ...(next.tree ? { tree: next.tree } : {}),
        });
      } catch {}
    }
    this.emit();
  }

  private async loop(id: string, signal: AbortSignal) {
    const backoff = new Backoff(MONITOR_BACKOFF_S);
    while (!signal.aborted) {
      const device = this.registry.get(id);
      if (!device) return;
      let wait = backoff.ms;
      if (device.transport === "tunnel" && this.tunnel) {
        // Park offline (never unauthorized) while no tunnel connection is
        // live, but wake within 5s of one appearing — the 30s backoff cap
        // below belongs to probe failures, not to connection arrival.
        if (!this.tunnel.hasLiveConnection(id)) {
          this.update(id, {
            status: "offline",
            error: "paired over tunnel; no tunnel connection is live",
          });
          let appeared = false;
          for (let i = 0; i < 6 && !signal.aborted; i++) {
            await sleep(5_000, signal);
            if (this.tunnel.hasLiveConnection(id)) {
              appeared = true;
              break;
            }
          }
          if (!appeared && !this.tunnel.hasLiveConnection(id)) continue;
        }
      } else if (device.transport === "tunnel") {
        // No dispatcher wired (unit contexts only): honest offline, never LAN.
        this.update(id, {
          status: "offline",
          error: "paired over tunnel; no tunnel connection is live",
        });
        await sleep(30_000, signal);
        continue;
      }
      if (device.transport !== "tunnel" && (!device.url || !device.token)) {
        this.update(id, {
          status: "unauthorized",
          error: `No token for ${id}. Run: just net register ${id}`,
        });
        await sleep(30_000, signal);
        continue;
      }
      if (this.live.get(id)?.status !== "online") this.update(id, { status: "checking" });
      const transport = transportFor(device, this.tunnel);
      if (!transport || (device.transport === "lan" && !transport.available)) {
        this.update(id, {
          status: "unauthorized",
          error: `No token for ${id}. Run: just net register ${id}`,
        });
        await sleep(30_000, signal);
        continue;
      }
      try {
        // R17 (run-3 h8): abort the losing probe — a timed-out fetch keeps
        // buffering (up to REST_TIMEOUT_MS) while the backoff loop starts the
        // next one, multiplying an unbounded read. The per-probe controller
        // also stops reading the moment the race is lost.
        const probeCtl = new AbortController();
        const onOuterAbort = () => probeCtl.abort();
        signal?.addEventListener("abort", onOuterAbort, { once: true });
        const probe = await Promise.race([
          transport.request({ method: "GET", path: "/v1/device" }, probeCtl.signal),
          sleep(6_000, signal).then(() => null),
        ]).finally(() => {
          signal?.removeEventListener("abort", onOuterAbort);
          probeCtl.abort();
        });
        if (probe === null) throw new DpiError("offline", `Probe timeout for ${device.url}`);
        if (probe.status === 401)
          throw new DpiError("unauthorized", "Device rejected the token", 401);
        if (probe.status !== 200)
          throw new DpiError("offline", `/v1/device answered ${probe.status}`, probe.status);
        let parsed: { apiVersion?: number; uid?: string; name?: string } | undefined;
        try {
          parsed = typeof probe.body === "string" ? JSON.parse(probe.body) : (probe.body as never);
        } catch {
          throw new DpiError("invalid", `/v1/device returned a non-JSON body`);
        }
        const info = {
          ...parsed,
          apiVersion: parsed?.apiVersion ?? 0,
          uid: parsed?.uid ?? "",
          name: parsed?.name ?? "",
        } as DeviceInfo;
        if (info.apiVersion !== 1) {
          this.update(id, {
            status: "incompatible",
            error: `${device.url} speaks API v${info.apiVersion}; this hub speaks v1`,
          });
          await sleep(30_000, signal);
          continue;
        }
        if (device.deviceUid && device.deviceUid !== info.uid) {
          this.update(id, {
            status: "mismatch",
            error: `${device.url} now answers as "${info.name}" (uid ${info.uid.slice(0, 8)}), not the device first seen there (uid ${device.deviceUid.slice(0, 8)})`,
          });
          await sleep(30_000, signal);
          continue;
        }
        const learned = this.registry.learnUid(id, info.uid);
        if (!learned.ok) {
          this.update(id, {
            status: learned.conflict ? "mismatch" : "offline",
            error: learned.conflict
              ? `uid ${info.uid.slice(0, 8)}… already belongs to device "${learned.conflict}" (identity conflict — resolve manually)`
              : `device answered with a non-canonical uid`,
          });
          await sleep(30_000, signal);
          continue;
        }
        this.update(id, { status: "online", error: undefined, info, lastSeenAt: Date.now() });
        backoff.reset();
        for await (const frame of transport.watch(
          { path: "/v1/events", consumerId: `monitor:${id}` },
          signal,
        )) {
          if (frame.type === "tree")
            this.update(id, {
              status: "online",
              error: undefined,
              tree: frame.tree,
              lastSeenAt: Date.now(),
            });
        }
        if (signal.aborted) return;
        // The stream was live until now: that is the last time the device was seen.
        this.update(id, {
          status: "offline",
          error: "Event stream ended (device restarting?)",
          lastSeenAt: Date.now(),
        });
        wait = 500;
      } catch (e) {
        if (signal.aborted) return;
        const err =
          e instanceof DpiError ? e : new DpiError("offline", String((e as Error)?.message ?? e));
        if (err.code === "unauthorized") {
          this.update(id, { status: "unauthorized", error: "Token rejected by the device" });
          wait = 30_000;
        } else {
          // A stream that was live until it failed: the device was seen just now.
          const wasOnline = this.live.get(id)?.status === "online";
          this.update(id, {
            status: "offline",
            error: err.message,
            ...(wasOnline ? { lastSeenAt: Date.now() } : {}),
          });
        }
      }
      await sleep(wait, signal);
      backoff.advance();
    }
  }
}
