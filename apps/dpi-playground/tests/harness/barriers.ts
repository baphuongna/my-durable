/**
 * Deterministic barriers for crash-window tests. The test process runs a
 * BarrierHub on a loopback socket; instrumented child code calls
 * `childGate(name)` at exact points (DB commit, file rename, ACK send,
 * response delivery) and parks until the test releases. Repeatable crash
 * windows instead of sleep-and-hope races.
 *
 * Plus freeze/thaw (SIGSTOP/SIGCONT) for whole-process pause where no gate
 * is wired yet. No production HTTP query/header/env bypass is involved —
 * gates are test-harness-only, injected via constructor/CLI in child scripts.
 */
import { createServer, type Socket } from "node:net";
import { once } from "node:events";

export interface BarrierHubHandle {
  port: number;
  /** Resolve when a child reaches the named gate (throws on timeout). */
  waitFor: (name: string, timeoutMs?: number) => Promise<void>;
  /** Let every child parked at the named gate proceed. */
  release: (name: string) => void;
  reached: (name: string) => boolean;
  parked: (name: string) => number;
  stop: () => Promise<void>;
}

export async function startBarrierHub(): Promise<BarrierHubHandle> {
  const server = createServer();
  const reachedAt = new Map<string, number>();
  const parkedSockets = new Map<string, Set<Socket>>();
  const testWaiters = new Map<string, (() => void)[]>();

  server.on("connection", (socket: Socket) => {
    socket.setEncoding("utf8");
    let buffer = "";
    socket.on("data", (chunk: string) => {
      buffer += chunk;
      let idx: number;
      while ((idx = buffer.indexOf("\n")) >= 0) {
        const line = buffer.slice(0, idx).trim();
        buffer = buffer.slice(idx + 1);
        if (line.startsWith("wait ")) {
          const name = line.slice(5);
          if (!reachedAt.has(name)) reachedAt.set(name, Date.now());
          const set = parkedSockets.get(name) ?? new Set();
          set.add(socket);
          parkedSockets.set(name, set);
          socket.write(`held ${name}\n`);
          for (const w of testWaiters.get(name) ?? []) w();
          testWaiters.set(name, []);
        }
      }
    });
    socket.on("close", () => {
      for (const set of parkedSockets.values()) set.delete(socket);
    });
  });
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  const port = (server.address() as { port: number }).port;

  const waitFor = (name: string, timeoutMs = 10_000) =>
    new Promise<void>((resolve, reject) => {
      if (reachedAt.has(name)) return resolve();
      const timer = setTimeout(() => reject(new Error(`barrier timeout: ${name}`)), timeoutMs);
      const done = () => {
        clearTimeout(timer);
        resolve();
      };
      const list = testWaiters.get(name) ?? [];
      list.push(done);
      testWaiters.set(name, list);
    });

  const release = (name: string) => {
    for (const socket of parkedSockets.get(name) ?? []) {
      socket.write(`go ${name}\n`);
      socket.end();
    }
    parkedSockets.set(name, new Set());
  };

  const stop = async () => {
    for (const set of parkedSockets.values()) for (const s of set) s.destroy();
    server.close();
    await once(server, "close").catch(() => {});
  };

  return {
    port,
    waitFor,
    release,
    reached: (n) => reachedAt.has(n),
    parked: (n) => parkedSockets.get(n)?.size ?? 0,
    stop,
  };
}

/** Child-side gate: parks the calling child until the test releases `name`. */
export async function childGate(port: number, name: string): Promise<void> {
  const { connect } = await import("node:net");
  return new Promise((resolve, reject) => {
    const socket = connect(port, "127.0.0.1");
    socket.setEncoding("utf8");
    let settled = false;
    const finish = () => {
      if (settled) return;
      settled = true;
      socket.destroy();
      resolve();
    };
    socket.on("connect", () => socket.write(`wait ${name}\n`));
    socket.on("data", (chunk: string) => {
      if (chunk.includes(`go ${name}`)) finish();
    });
    socket.on("close", finish); // hub-side release may just close
    socket.on("error", (e) => {
      if (!settled) {
        settled = true;
        reject(e);
      }
    });
  });
}

/** Whole-process pause for approximating crash windows without gates. */
export function freeze(pid: number): void {
  process.kill(pid, "SIGSTOP");
}
export function thaw(pid: number): void {
  process.kill(pid, "SIGCONT");
}
