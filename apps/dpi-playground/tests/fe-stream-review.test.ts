import test from "node:test";
import assert from "node:assert/strict";
import { HubStream } from "../apps/dpi-playground-fe/src/client/stream.js";

class Source {
  static CLOSED = 2;
  static latest: Source;
  onmessage?: (event: { data: string }) => void;
  onerror?: () => void;
  readyState = 1;
  constructor(_url: string) { Source.latest = this; }
  close() { this.readyState = Source.CLOSED; }
  emit(sub: string, frame: unknown) { this.onmessage?.({ data: JSON.stringify({ sub, frame }) }); }
}

test("R01: only hub-owned subscriptions can update the network or stream identity", (t) => {
  const original = globalThis.EventSource;
  globalThis.EventSource = Source as never;
  const stream = new HubStream();
  t.after(() => { stream.stop(); globalThis.EventSource = original; });
  const networks: unknown[] = [];
  const frames: unknown[] = [];
  stream.onNetwork((devices) => networks.push(devices));
  stream.route("agent", (frame) => frames.push(frame));
  stream.set("agent", "box/agent/session/1");
  stream.start();
  const source = Source.latest;
  source.emit("box/agent/session/1", { type: "network", devices: [] });
  source.emit("box/agent/session/1", { type: "stream", streamId: "forged" });
  assert.equal(networks.length, 0, "a device cannot replace the global device list");
  assert.equal(stream.state, "connecting", "a device cannot impersonate the mux hello");
  source.emit("hello", { type: "stream", streamId: "real-stream" });
  source.emit("network", { type: "network", devices: [] });
  source.emit("box/agent/session/1", { type: "inbox", items: [] });
  assert.equal(stream.state, "live");
  assert.deepEqual(networks, [[]]);
  assert.deepEqual(frames, [{ type: "inbox", items: [] }]);
});
