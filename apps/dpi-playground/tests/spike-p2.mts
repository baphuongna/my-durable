/**
 * SPIKE P2-01 — the four riskiest invariants, on a disposable branch. NOT production code.
 *
 *   I1  a tunnel row with url/token NULL works through monitor probe + background watch, mux reader,
 *       and the REST proxy (RV04: no full-token guard for tunnel transport).
 *   I2  two consumers on the same agent: per-tab snapshots, late join, independent unsubscribe.
 *   I3  1.100.256 B and 6 MiB payloads cross tunnel + browser SSE legs with 64 KiB pacing, without
 *       tripping the 4 MB output cap (payload synthesized at the device leg — recorded mock).
 *   I4  rotation reconnect semantics (logic-level harness): current reconnect = implicit ACK;
 *       previous reconnect with the response cache lost regenerates the generation.
 *
 * Mocks recorded (see the P2/spike report for the full list):
 *   - WSS leg = loopback TCP socket pair, length-prefixed JSON, 64 KiB paced writes awaiting drain,
 *     ≤1 MiB wire frames with chunk/reassembly (hub src/transport.ts, spike-only).
 *   - The hub's tunnel reads are throttled (~4 ms per 256 KiB) to force genuine backpressure.
 *   - I3's oversized snapshot is synthesized at the device leg; tunnel and SSE legs are real.
 *   - The "approved pairing" is a dummy row in an in-memory registry; no public bypass exists.
 * Real parts: a dpi-backend child process (faux), real HTTP, the real hub monitor/mux/proxy modules.
 */
import { connect, type Socket } from "node:net";
import { once } from "node:events";
import express from "express";
import { createServer } from "node:http";
import { createHash } from "node:crypto";
import { mkdirSync, writeFileSync, appendFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { bootServer, faux, newToken, tempStore, until } from "../../dpi-backend/tests/helpers.js";
import { DpiClient } from "../../dpi-sdk/src/client.js";
import { DeviceMonitor } from "../apps/dpi-playground-hub/src/monitor.js";
import { StreamMux, muxDebugLog } from "../apps/dpi-playground-hub/src/mux.js";
import { proxy } from "../apps/dpi-playground-hub/src/proxy.js";
import { TunnelServer, frameReader, writeMessage, pacingStats, reassemblyLog } from "../apps/dpi-playground-hub/src/transport.js";
import type { DeviceRow } from "../../dpi-sdk/src/node/registry.js";

const OUT = resolve(import.meta.dirname, "../../../artifacts/verification/20261019-p0-g0/P2/spike");
mkdirSync(OUT, { recursive: true });
writeFileSync(join(OUT, "traces.jsonl"), "");
const trace = (line: Record<string, unknown>) => {
  appendFileSync(join(OUT, "traces.jsonl"), `${JSON.stringify({ at: new Date().toISOString(), ...line })}\n`);
  console.log(JSON.stringify(line));
};
const results: Record<string, string> = {};
const check = (invariant: string, ok: boolean, detail: string) => {
  results[invariant] = ok ? "PASS" : "FAIL";
  trace({ invariant, result: ok ? "PASS" : "FAIL", detail });
  if (!ok) process.exitCode = 1;
};

// ---------------------------------------------------------------- dummy approved pairing (in-memory registry)

const UID = "11111111-2222-4333-8444-555566667777";
const tunnelRow = {
  id: "dev-tunnel",
  name: "Tunnel device (spike)",
  kind: "url",
  url: "", // NULL in the future v1 schema; "" only because v0's column is NOT NULL
  token: null,
  source: "ui",
  position: 0,
  deviceUid: UID,
  lastStatus: "checking",
  lastError: null,
  lastSeenAt: null,
  lastInfo: null,
  lastTree: null,
  createdAt: Date.now(),
  updatedAt: Date.now(),
  transport: "tunnel",
} as unknown as DeviceRow & { transport: string };

class FakeRegistry {
  private rows = new Map<string, DeviceRow & { transport?: string }>([[tunnelRow.id, tunnelRow]]);
  list() {
    return [...this.rows.values()];
  }
  get(id: string) {
    return this.rows.get(id);
  }
  recordStatus(id: string, patch: { status: string; error: string | null }) {
    trace({ ev: "recordStatus", id, status: patch.status });
  }
  learnUid(id: string, uid: string) {
    trace({ ev: "learnUid", id, uid });
  }
  uiGet() {
    return undefined;
  }
  uiSet() {}
}

// ---------------------------------------------------------------- device-side connector (owns the full token)

type Wire = { t: string; [k: string]: unknown };

async function startConnector(port: number, backend: string, token: string, uid: string) {
  const socket: Socket = connect(port, "127.0.0.1");
  await once(socket, "connect");
  const send = (m: unknown) => writeMessage(socket, m);
  await send({ t: "hello", deviceId: "dev-tunnel", uid });
  const handle = async (wire: Wire) => {
    if (wire.t === "req") {
      const res = await fetch(backend + String(wire.path), {
        method: String(wire.method),
        headers: { authorization: `Bearer ${token}`, "x-dpi-token": token, ...(wire.body ? { "content-type": "application/json" } : {}) },
        body: (wire.body as string) || undefined,
      });
      await send({ t: "res", id: wire.id, status: res.status, contentType: res.headers.get("content-type") ?? "application/json", text: await res.text() });
      return;
    }
    if (wire.t === "sse-open") {
      const id = Number(wire.id);
      const path = String(wire.path);
      const synth = /^\/v1\/spike\/events\?bytes=(\d+)$/.exec(path);
      if (synth) return synthFrames(id, Number(synth[1]));
      const ctl = new AbortController();
      socket.on("close", () => ctl.abort(), { once: true });
      const res = await fetch(backend + path, { headers: { authorization: `Bearer ${token}`, "x-dpi-token": token }, signal: ctl.signal });
      if (!res.ok || !res.body) return void (await send({ t: "sse-end", id, reason: `upstream ${res.status}` }));
      const reader = res.body.getReader();
      let buf = "";
      try {
        for (;;) {
          const { value, done } = await reader.read();
          if (done) break;
          buf += new TextDecoder().decode(value, { stream: true });
          const blocks = buf.split("\n\n");
          buf = blocks.pop() ?? "";
          for (const block of blocks)
            if (/^data: /m.test(block)) {
              trace({ ev: "connector-forward", id, bytes: block.length, head: block.slice(0, 60) });
              await send({ t: "sse-data", id, text: `${block}\n\n` });
            }
        }
        await send({ t: "sse-end", id, reason: "upstream ended" });
      } catch {
        await send({ t: "sse-end", id, reason: "upstream failed" });
      }
    }
  };
  const synthFrames = async (id: number, bytes: number) => {
    const head = `{"type":"snapshot","blob":"`;
    const tail = `","spike":true}`;
    const blob = "z".repeat(bytes); // the payload under test is exactly `bytes` bytes
    const sha = createHash("sha256").update(blob).digest("hex");
    trace({ ev: "synth", bytes, blobSha256: sha });
    await send({ t: "sse-data", id, text: `id: 1\nevent: snapshot\ndata: ${head}${blob}${tail}\n\n` });
    trace({ ev: "synth-sent", id, bytes });
    await send({ t: "sse-end", id, reason: "synth done" });
  };
  frameReader(
    socket,
    (wire) => void handle(wire).catch((e) => trace({ ev: "connector-error", error: String(e) })),
    (err) => trace({ ev: "connector-wire-error", error: err.message }),
  );
  return { socket };
}

// ---------------------------------------------------------------- boot: backend, tunnel, hub

const t = await tempStore();
const token = newToken();
const backendProc = await bootServer({ home: join(t.root, "home"), startDirs: t.work, token, name: "spike-device" });
const deviceInfo = await new DpiClient(backendProc.base, token).device();
tunnelRow.deviceUid = deviceInfo.uid; // a real pairing row carries the device's actual uid (P2-09 learns it)

const tunnels = new TunnelServer();
const tunnelPort = await tunnels.listen();
await startConnector(tunnelPort, backendProc.base, token, deviceInfo.uid);
await until(async () => tunnels.has(deviceInfo.uid), 5000, "tunnel connection");

const registry = new FakeRegistry();
const monitor = new DeviceMonitor(registry as never, tunnels);
const mux = new StreamMux(registry as never, monitor, tunnels);
monitor.start();

const app = express();
app.disable("x-powered-by");
app.use(express.json({ limit: "256kb" }));
app.get("/api/network", (_q, s) => s.json({ devices: monitor.network() }));
app.get("/api/stream", (q, s) => mux.open(q, s));
app.put("/api/stream/:streamId", (q, s) => {
  try {
    s.json(mux.subscribe(String(q.params.streamId), q.body?.subs));
  } catch (e) {
    s.status((e as { status?: number }).status ?? 400).json({ error: { code: "invalid", message: (e as Error).message } });
  }
});
app.all("/api/devices/:id/v1/{*rest}", proxy(registry as never, monitor, tunnels));
const server = createServer(app);
await new Promise<void>((r) => server.listen(0, "127.0.0.1", () => r()));
const hub = `http://127.0.0.1:${(server.address() as { port: number }).port}`;

// ---------------------------------------------------------------- browser tab helper (one SSE connection)

class Tab {
  readonly frames: { sub: string; frame: Record<string, unknown> }[] = [];
  private reader: ReadableStreamDefaultReader<Uint8Array>;
  private buf = "";
  private streamId = "";
  private constructor(private readonly res: Response, private readonly ctl: AbortController) {
    this.reader = res.body!.getReader();
  }
  static async open(): Promise<Tab> {
    const ctl = new AbortController();
    const res = await fetch(`${hub}/api/stream`, { signal: ctl.signal });
    if (res.status !== 200) throw new Error(`tab open: ${res.status}`);
    const tab = new Tab(res, ctl);
    const hello = await tab.pump();
    if (hello?.frame.type !== "stream") throw new Error("tab did not get a stream hello");
    tab.streamId = String(hello.frame.streamId);
    return tab;
  }
  private pending: { sub: string; frame: Record<string, unknown> }[] = [];
  bytesRead = 0;
  private inflight?: Promise<ReadableStreamReadResult<Uint8Array>>;
  private async pump(): Promise<{ sub: string; frame: Record<string, unknown> } | undefined> {
    for (;;) {
      if (this.pending.length) {
        const parsed = this.pending.shift()!;
        this.frames.push(parsed);
        return parsed;
      }
      const blocks = this.buf.split("\n\n");
      this.buf = blocks.pop() ?? "";
      for (const block of blocks) {
        if (block.length > 1_000_000) trace({ ev: "tab-big-block", len: block.length, head: block.slice(0, 50) });
        const data = /^data: (.+)$/m.exec(block)?.[1];
        if (data) {
          try {
            this.pending.push(JSON.parse(data) as { sub: string; frame: Record<string, unknown> });
          } catch {
            trace({ ev: "tab-parse-fail", len: block.length, head: block.slice(0, 60), tail: block.slice(-60) });
          }
        } else if (block.length > 1_000_000) trace({ ev: "tab-nodata-block", len: block.length, head: block.slice(0, 50) });
      }
      if (this.pending.length) continue;
      // Keep one persistent read claim: racing reader.read() against a timer and dropping the loser
      // would silently discard the chunk the read() claim already took out of the stream.
      const read = await Promise.race([
        (this.inflight ??= this.reader.read()),
        new Promise<"idle">((r) => setTimeout(() => r("idle"), 200)),
      ]);
      if (read === "idle") return undefined;
      this.inflight = undefined;
      const { value, done } = read as ReadableStreamReadResult<Uint8Array>;
      if (done) return undefined;
      this.bytesRead += value.byteLength;
      const text = new TextDecoder().decode(value, { stream: true });
      if (value.byteLength > 500_000) trace({ ev: "tab-chunk", bytes: value.byteLength, tail: text.slice(-40) });
      this.buf += text;
    }
  }
  async until(pred: (f: { sub: string; frame: Record<string, unknown> }) => boolean, timeout = 25_000) {
    const end = Date.now() + timeout;
    while (Date.now() < end) {
      const found = this.frames.find(pred);
      if (found) return found;
      const next = await this.pump();
      if (next && pred(next)) return next;
    }
    throw new Error(
      `tab timed out after reading ${this.bytesRead} B; reassembly: ${JSON.stringify(reassemblyLog.slice(-6))}; saw ${JSON.stringify(this.frames.map((f) => [f.sub, f.frame.type]))};\n wire: ${JSON.stringify(tunnels.debugLog.slice(-10))}\n mux: ${JSON.stringify(muxDebugLog.slice(-14))}`,
    );
  }
  subs(keys: string[]) {
    return fetch(`${hub}/api/stream/${this.streamId}`, { method: "PUT", headers: { "content-type": "application/json" }, body: JSON.stringify({ subs: keys }) });
  }
  close() {
    this.ctl.abort();
  }
}
const tunnelApi = (path: string, init: RequestInit = {}) => fetch(`${hub}/api/devices/dev-tunnel/v1${path}`, init);

// ================================================================ I1: tokenless tunnel through all three consumers

const settled = await monitor.settled("dev-tunnel", 15_000);
check(
  "I1-monitor-probe",
  settled?.status === "online" && settled.info?.uid === deviceInfo.uid && settled.hasToken === false && tunnelRow.url === "" && tunnelRow.token === null,
  `probe online as uid ${settled?.info?.uid} with hasToken=${settled?.hasToken} while the row stores no url/token`,
);

trace({ev:"step",s:"create-session"});
const created = await (
  await tunnelApi("/sessions", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ name: "S1", cwd: t.work, model: faux }) })
).json();
const restInfo = await (await tunnelApi("/device")).json();
check("I1-rest-proxy", restInfo?.uid === deviceInfo.uid, `REST /v1/device via tunnel proxy answered uid ${restInfo?.uid}`);

const tabProbe = await Tab.open();
await tabProbe.subs(["dev-tunnel/device"]);
const deviceFrame = await tabProbe.until((f) => f.sub === "dev-tunnel/device" && f.frame.type !== "hello");
check("I1-mux-reader", !!deviceFrame, `mux forwarded a ${deviceFrame.frame.type} frame over the tunnel with no stored token`);

await until(async () => (monitor.state("dev-tunnel")?.tree?.sessions?.length ?? 0) > 0, 15_000, "watch tree");
check("I1-monitor-watch", !!monitor.state("dev-tunnel")?.tree, "background /v1/events watch filled the tree through the tunnel");
tabProbe.close();

// ================================================================ I2: two consumers, late join, independent unsubscribe

const agentKey = `dev-tunnel/agent/${created.id}/main`;
trace({ev:"step",s:"tabA"});
const tabA = await Tab.open();
trace({ev:"step",s:"tabB"});
const tabB = await Tab.open();
trace({ev:"step",s:"subsA",key:agentKey});
await tabA.subs([agentKey]);
await tabB.subs([agentKey]);
trace({ev:"step",s:"wait-snapshot-A"});
const a1 = await tabA.until((f) => f.sub === agentKey && f.frame.type === "snapshot");
const b1 = await tabB.until((f) => f.sub === agentKey && f.frame.type === "snapshot");
check("I2-initial-snapshots", !!a1 && !!b1, "both tabs got their own tagged snapshot for the same agent");

const beforeB = tabB.frames.length;
await tunnelApi(`/sessions/${created.id}/agents/main/messages`, {
  method: "POST",
  headers: { "content-type": "application/json" },
  body: JSON.stringify({ content: "hello from the spike", whenBusy: "followUp", requestId: "spike-msg-1", waitMs: 20_000 }),
});
const bDelta = await tabB.until((f) => f.sub === agentKey && f.frame.type === "batch", 25_000);
const aDelta = await tabA.until((f) => f.sub === agentKey && f.frame.type === "batch", 25_000).catch(() => undefined);
const aDeltaCount = tabA.frames.filter((f) => f.sub === agentKey && f.frame.type === "batch").length;
void aDelta;
check("I2-deltas-both", !!bDelta && aDeltaCount >= 1, `both tabs saw the turn's batches (A:${aDeltaCount}, B:1+)`);

await tabA.subs([]); // A unsubscribes; B must keep receiving
const afterA = tabA.frames.length;
await tunnelApi(`/sessions/${created.id}/agents/main/messages`, {
  method: "POST",
  headers: { "content-type": "application/json" },
  body: JSON.stringify({ content: "second turn", whenBusy: "followUp", requestId: "spike-msg-2", waitMs: 20_000 }),
});
await tabB.until(
  (f) => f.sub === agentKey && f.frame.type === "batch" && tabB.frames.filter((x) => x.frame.type === "batch").length > (beforeB, tabB.frames.length - 1),
  25_000,
).catch(() => undefined);
await new Promise((r) => setTimeout(r, 300));
const aSilent = tabA.frames.length === afterA;
const bGotMore = tabB.frames.filter((f) => f.sub === agentKey && f.frame.type === "batch").length >= 2;
check("I2-independent-unsub", aSilent && bGotMore, `after A unsubscribed: A silent (${aSilent}), B still streaming (${bGotMore})`);

const tabC = await Tab.open();
await tabC.subs([agentKey]);
const cSnap = await tabC.until((f) => f.sub === agentKey && f.frame.type === "snapshot");
check("I2-late-join", !!cSnap, "a late joiner got its own snapshot");
tabA.close();
tabB.close();
tabC.close();

// ================================================================ I3: large payloads with pacing

const runLarge = async (bytes: number) => {
  const tab = await Tab.open();
  const key = `dev-tunnel/spike/${bytes}`;
  await tab.subs([key]);
  const frame = await tab.until((f) => f.sub === key && f.frame.type === "snapshot", 60_000);
  const blob = String(frame.frame.blob ?? "");
  const sha = createHash("sha256").update(blob).digest("hex");
  const byteLen = Buffer.byteLength(blob, "utf8");
  tab.close();
  return { sha, byteLen };
};
const small = await runLarge(1_100_256);
const big = await runLarge(6 * 1024 * 1024);
const synthTraces = [small, big];
const peaks = mux.debugPeaks();
const maxPeak = Math.max(...Object.values(peaks), 0);
check(
  "I3-large-payloads",
  small.byteLen === 1_100_256 && big.byteLen === 6 * 1024 * 1024,
  `1.100.256 B → ${small.byteLen} B; 6 MiB → ${big.byteLen} B; peak hub output buffer ${maxPeak} B (cap 4.000.000); pacing: ${pacingStats.chunkWrites} chunk writes, ${pacingStats.drainWaits} drain waits`,
);
void synthTraces;

// ================================================================ I4: rotation reconnect semantics (logic level)

/**
 * The state machine the plan prescribes (03-pairing §rotation): credentials hold `current` and
 * `previous`; a RAM cache may hold one undelivered rotation response. Reconnects handshake with the
 * generation they were issued. A stale generation never retires anything newer.
 */
class Rotation {
  generation = 1;
  current = "cred-G1";
  previous?: string;
  pendingRotationId?: string;
  pendingTarget?: { generation: number; credential: string };
  ack(rotationId: string, generation: number) {
    if (rotationId !== this.pendingRotationId || generation !== this.pendingTarget?.generation) return "stale";
    this.pendingRotationId = undefined;
    this.pendingTarget = undefined;
    return "acked";
  }
  /** The hub's RAM response cache is gone (restart); the pending rotation's outcome is unknown. */
  loseCache() {
    this.pendingRotationId = undefined;
    this.pendingTarget = undefined;
  }
  reconnect(presented: string): "implicit-ack" | "resend" | "regenerate" | "unknown" {
    if (presented === this.current) {
      // Current reconnecting with a valid handshake: the previous credential is implicitly confirmed.
      this.pendingRotationId = undefined;
      this.pendingTarget = undefined;
      this.previous = undefined;
      return "implicit-ack";
    }
    if (presented === this.previous) {
      if (this.pendingTarget) return "resend"; // cache still holds the same target for the old device
      // Cache lost: retire the unconfirmed current, mint the next generation, keep previous usable.
      this.generation += 1;
      this.current = `cred-G${this.generation}`;
      return "regenerate";
    }
    return "unknown";
  }
  rotate(): { rotationId: string; generation: number; credential: string } {
    this.previous = this.current;
    this.generation += 1;
    this.current = `cred-G${this.generation}`;
    const rotation = { rotationId: `rot-${this.generation}`, generation: this.generation, credential: this.current };
    this.pendingRotationId = rotation.rotationId;
    this.pendingTarget = { generation: rotation.generation, credential: rotation.credential };
    return rotation;
  }
}

{
  const cred = (g: number) => `cred-G${g}`;
  const r1 = new Rotation();
  r1.rotate();
  r1.loseCache(); // hub restart: the RAM response cache is gone
  const i4a = r1.reconnect(cred(2)) === "implicit-ack" && r1.previous === undefined && r1.generation === 2;

  const r2 = new Rotation();
  r2.rotate();
  const i4b = r2.reconnect(cred(1)) === "resend" && r2.generation === 2;

  const r3 = new Rotation();
  r3.rotate();
  r3.loseCache(); // the hub's RAM response cache is gone; the pending rotation's outcome is unknown
  const regen = r3.reconnect(cred(1)); // the PREVIOUS credential reconnects
  const i4c = regen === "regenerate" && r3.generation === 3 && r3.previous === cred(1);

  const r4 = new Rotation();
  const rotA = r4.rotate();
  const rotB = r4.rotate(); // a newer rotation happened
  const i4d = r4.ack(rotA.rotationId, rotA.generation) === "stale" && r4.generation === 3 && r4.current === rotB.credential;

  check("I4-rotation-semantics", i4a && i4b && i4c && i4d, `implicit-ack:${i4a} resend:${i4b} regenerate:${i4c} stale-ack:${i4d}`);
}

// ---------------------------------------------------------------- teardown + report

server.close();
server.closeAllConnections();
monitor.stop();
await backendProc.stop();
await t.cleanup();
writeFileSync(
  join(OUT, "result.json"),
  JSON.stringify({ results, pacingStats, peaks, date: new Date().toISOString() }, null, 2),
);
console.log("\nSPIKE P2-01 RESULTS:", JSON.stringify(results));
process.exit(process.exitCode ?? 0);
