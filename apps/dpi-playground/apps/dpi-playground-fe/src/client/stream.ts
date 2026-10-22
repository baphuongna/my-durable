// One browser connection to the hub: EventSource('/api/stream'). The first frame names the
// stream; named slots (device, session, agent) map to subscription keys that a debounced
// PUT /api/stream/:id sends. Every (re)connect opens fresh upstreams, so each model restarts
// from its server snapshot.
import type { Frame, MuxFrame, NetworkDevice } from "@sdk/api";

export type Slot = "device" | "session" | "agent";
export type StreamState = "connecting" | "live" | "offline";

const MAX_BACKOFF_MS = 30_000;

/** Delay before retry number `failures` (0-based) of a rejected PUT; a numeric Retry-After (seconds) wins. */
export function retryDelay(failures: number, retryAfter?: string | null) {
  if (retryAfter && /^\d+$/.test(retryAfter.trim()))
    return Math.min(MAX_BACKOFF_MS, Math.max(1000, Number(retryAfter) * 1000));
  return Math.min(MAX_BACKOFF_MS, 1000 * 2 ** Math.min(failures, 10));
}

/** Delay before reconnect number `attempt` (0-based) after the browser gave up on the EventSource. */
export function reconnectDelay(attempt: number) {
  return Math.min(MAX_BACKOFF_MS, 2000 * 2 ** Math.min(attempt, 10));
}

export class HubStream {
  state: StreamState = "connecting";
  private source?: EventSource;
  private streamId = "";
  private slots = new Map<Slot, string>();
  private fresh = new Set<string>();
  private applied: string[] = [];
  private routes = new Map<Slot, Set<(frame: Frame) => void>>();
  private networkFns = new Set<(devices: NetworkDevice[]) => void>();
  private stateFns = new Set<(state: StreamState) => void>();
  private timer?: ReturnType<typeof setTimeout>;
  private reconnectTimer?: ReturnType<typeof setTimeout>;
  private reconnects = 0;
  private failures = 0;
  private flushing = Promise.resolve();

  start() {
    clearTimeout(this.reconnectTimer);
    this.source?.close();
    this.streamId = "";
    this.source = new EventSource("/api/stream");
    this.source.onmessage = (e) => this.receive(JSON.parse(e.data) as MuxFrame);
    // EventSource reconnects on its own; the next hello re-sends the subscriptions.
    this.source.onerror = () => {
      this.streamId = "";
      this.setState(this.source?.readyState === EventSource.CLOSED ? "offline" : "connecting");
      if (this.source?.readyState === EventSource.CLOSED) {
        clearTimeout(this.reconnectTimer);
        this.reconnectTimer = setTimeout(() => this.start(), reconnectDelay(this.reconnects++));
      }
    };
  }

  stop() {
    clearTimeout(this.timer);
    clearTimeout(this.reconnectTimer);
    this.source?.close();
    // An in-flight PUT that settles later sees a different stream and does not retry.
    this.streamId = "";
  }

  /** Point a slot at a subscription key (or clear it). A changed key always gets a fresh snapshot. */
  set(slot: Slot, key?: string) {
    if (this.slots.get(slot) === key) return;
    if (key) {
      this.slots.set(slot, key);
      this.fresh.add(key);
    } else this.slots.delete(slot);
    this.schedule();
  }

  /** Retry a failed slot without discarding the other scopes or their cached models. */
  reopen(slot: Slot) {
    const key = this.slots.get(slot);
    if (!key) return;
    this.fresh.add(key);
    this.schedule(0);
  }

  route(slot: Slot, fn: (frame: Frame) => void) {
    const set = this.routes.get(slot) ?? new Set();
    set.add(fn);
    this.routes.set(slot, set);
    return () => void set.delete(fn);
  }

  onNetwork(fn: (devices: NetworkDevice[]) => void) {
    this.networkFns.add(fn);
    return () => void this.networkFns.delete(fn);
  }

  onState(fn: (state: StreamState) => void) {
    this.stateFns.add(fn);
    return () => void this.stateFns.delete(fn);
  }

  private setState(state: StreamState) {
    if (state === this.state) return;
    this.state = state;
    for (const fn of this.stateFns) fn(state);
  }

  private receive(m: MuxFrame) {
    const frame = m.frame;
    if (frame.type === "stream") {
      if (m.sub !== "hello") return;
      this.streamId = frame.streamId;
      this.applied = [];
      this.reconnects = 0;
      this.failures = 0;
      this.setState("live");
      this.schedule(0);
      return;
    }
    if (frame.type === "network") {
      if (m.sub !== "network") return;
      for (const fn of this.networkFns) fn(frame.devices);
      return;
    }
    if (m.sub === "hello" || m.sub === "network") return;
    for (const [slot, key] of this.slots)
      if (key === m.sub) for (const fn of this.routes.get(slot) ?? []) fn(frame);
  }

  private schedule(ms = 30) {
    clearTimeout(this.timer);
    this.timer = setTimeout(() => {
      this.flushing = this.flushing.then(() => this.flush());
    }, ms);
  }

  private async flush() {
    const streamId = this.streamId;
    if (!streamId) return;
    const subs = [...new Set(this.slots.values())];
    // A key re-selected while its upstream is still open would get no new snapshot: drop it once.
    const reopen = subs.filter((k) => this.fresh.has(k) && this.applied.includes(k));
    this.fresh.clear();
    if (
      reopen.length &&
      !(await this.put(
        streamId,
        subs.filter((k) => !reopen.includes(k)),
      ))
    ) {
      for (const k of reopen) this.fresh.add(k);
      return;
    }
    if (subs.join("\n") !== this.applied.join("\n") || reopen.length)
      await this.put(streamId, subs);
  }

  private async put(streamId: string, subs: string[]) {
    let retryAfter: string | null = null;
    try {
      const r = await fetch(`/api/stream/${streamId}`, {
        method: "PUT",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ subs }),
      });
      // The reply belongs to a stream that has since been replaced or stopped.
      if (streamId !== this.streamId) return false;
      if (r.ok) {
        this.applied = subs;
        this.failures = 0;
        return true;
      }
      if (r.status === 404) {
        this.start();
        return false;
      }
      console.warn("subscription rejected", r.status, await r.text());
      retryAfter = r.headers.get("retry-after");
    } catch {
      if (streamId !== this.streamId) return false;
    }
    this.schedule(retryDelay(this.failures++, retryAfter));
    return false;
  }
}
