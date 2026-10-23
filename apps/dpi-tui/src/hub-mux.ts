/**
 * Node client for the hub's /api/stream mux — the same transport the web FE
 * rides. One SSE connection; subscription keys (<device>/agent/<s>/<a> etc.)
 * open one authenticated upstream per key on the HUB, so every subscribe
 * restarts from the device's snapshot, exactly like a direct device stream.
 *
 * This is what lets the TUI ATTACH to tunnel devices: REST flows through the
 * hub proxy (DpiClient baseUrl = <hub>/api/devices/<id>), events flow here.
 */
import { readSse } from "../../dpi-sdk/src/sse.js";
import { Backoff, type BackoffPolicy } from "../../dpi-sdk/src/protocol/backoff.js";
import type { Frame, MuxFrame } from "../../dpi-sdk/src/api.ts";

export type MuxState = "connecting" | "live" | "offline";

const RECONNECT: BackoffPolicy = { initS: 1, capS: 30 };

interface Subscriber {
  push: (frame: Frame) => void;
}

export class HubMux {
  private streamId = "";
  private wanted = new Set<string>();
  private listeners = new Map<string, Set<Subscriber>>();
  private source?: AbortController;
  private state: MuxState = "connecting";

  constructor(
    private readonly hub: { url: string; token: string },
    private readonly onState?: (state: MuxState) => void,
  ) {}

  get live() {
    return this.state === "live";
  }

  private setState(state: MuxState) {
    if (state === this.state) return;
    this.state = state;
    this.onState?.(state);
  }

  private auth(): Record<string, string> {
    return { authorization: `Bearer ${this.hub.token}` };
  }

  private started(): Promise<void> {
    if (this.source) return Promise.resolve();
    void this.run();
    return Promise.resolve();
  }

  private async run() {
    const ctl = (this.source = new AbortController());
    const backoff = new Backoff(RECONNECT);
    while (!ctl.signal.aborted) {
      this.setState("connecting");
      try {
        const res = await fetch(new URL("api/stream", this.hub.url), {
          headers: { ...this.auth(), accept: "text/event-stream" },
          signal: ctl.signal,
        });
        if (!res.ok || !res.body) throw Error(`hub stream ${res.status}`);
        for await (const message of readSse(res.body)) {
          const mux = JSON.parse(message.data) as MuxFrame;
          if (mux.sub === "hello" && mux.frame.type === "stream") {
            this.streamId = mux.frame.streamId;
            this.setState("live");
            backoff.reset();
            // Reconnects reopen fresh upstreams: resubscribe everything.
            await this.put([...this.wanted]);
            continue;
          }
          if (mux.sub === "hello" || mux.sub === "network") continue;
          if (mux.frame.type === "stream" || mux.frame.type === "network") continue;
          for (const sub of this.listeners.get(mux.sub) ?? []) sub.push(mux.frame);
        }
        if (ctl.signal.aborted) return;
        this.setState("offline");
      } catch {
        if (ctl.signal.aborted) return;
        this.setState("offline");
      }
      await new Promise((resolve) => setTimeout(resolve, backoff.ms));
      backoff.advance();
    }
  }

  private async put(subs: string[]) {
    const streamId = this.streamId;
    // An EMPTY list is meaningful: it closes every upstream the hub holds for
    // this stream (that is how leaving a session frees the device reader).
    if (!streamId) return;
    try {
      await fetch(new URL(`api/stream/${streamId}`, this.hub.url), {
        method: "PUT",
        headers: { ...this.auth(), "content-type": "application/json" },
        body: JSON.stringify({ subs }),
        signal: AbortSignal.timeout(10_000),
      });
    } catch {
      // The SSE loop reconnects and resubscribes; a lost PUT is not fatal.
    }
  }

  /**
   * Frames for one subscription key. Subscribing on the hub opens a fresh
   * upstream whose first frame is the device hello — the same contract as a
   * direct device stream, so `follow()` works unchanged.
   */
  async *events(key: string, signal: AbortSignal): AsyncGenerator<Frame> {
    await this.started();
    const queue: Frame[] = [];
    let wake: () => void = () => {};
    const sub: Subscriber = {
      push: (frame) => {
        queue.push(frame);
        wake();
      },
    };
    const set = this.listeners.get(key) ?? new Set();
    set.add(sub);
    this.listeners.set(key, set);
    const known = this.wanted.has(key);
    this.wanted.add(key);
    if (!known) void this.put([...this.wanted]);
    // Cleanup runs on abort AND on consumer return, and is idempotent: a
    // consumer that simply stops reading (no next() call) must still release
    // the hub upstream, or the device keeps a reader forever.
    let released = false;
    const release = () => {
      if (released) return;
      released = true;
      signal.removeEventListener("abort", onAbort);
      set.delete(sub);
      if (set.size) return;
      this.listeners.delete(key);
      this.wanted.delete(key);
      void this.put([...this.wanted]);
    };
    function onAbort() {
      release();
      wake();
    }
    signal.addEventListener("abort", onAbort, { once: true });
    try {
      while (!signal.aborted) {
        while (queue.length && !signal.aborted) yield queue.shift()!;
        if (signal.aborted) break;
        await new Promise<void>((resolve) => {
          wake = resolve;
        });
      }
    } finally {
      release();
    }
  }

  stop() {
    this.source?.abort();
    this.source = undefined;
    this.streamId = "";
    this.listeners.clear();
    this.wanted.clear();
    this.setState("offline");
  }
}
