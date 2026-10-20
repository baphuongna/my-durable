/**
 * Test actors with FAKE credentials only (random per boot): admin, two
 * devices, an attacker (wrong token / untrusting TLS client), browser tabs
 * (SSE consumers). No live provider is ever contacted (DPI_PROVIDER=faux).
 */
import { randomBytes, randomUUID } from "node:crypto";
import type { Agent as HttpsAgent } from "node:https";

export interface DeviceActor {
  name: string;
  deviceUid: string;
  deviceId: string;
  deviceToken: string; // dpi_ full LAN token (fake)
  tunnelToken: string; // dpt_ tunnel token (fake)
  keyFingerprint: string;
}

const b43 = () => randomBytes(32).toString("base64url");

export function makeDevice(name: string): DeviceActor {
  return {
    name,
    deviceUid: randomUUID(),
    deviceId: `dev-${name.toLowerCase().replace(/[^a-z0-9]/g, "")}`.slice(0, 32),
    deviceToken: `dpi_${b43()}`,
    tunnelToken: `dpt_${b43()}`,
    keyFingerprint: `sha256:${randomBytes(32).toString("hex")}`,
  };
}

export function makeActors() {
  return {
    admin: { token: `dph_${b43()}` }, // hub admin credential (fake; auth lands in P2-21)
    deviceA: makeDevice("deviceA"),
    deviceB: makeDevice("deviceB"),
    attacker: {
      // wrong credentials, never valid
      tunnelToken: `dpt_${b43()}`,
      deviceToken: `dpi_${b43()}`,
      pairingCode: "ATTACK22", // RFC4648-shaped but never issued
      untrustingAgent: null as HttpsAgent | null, // filled by the caller: default CA pool
    },
    browserTabs: [] as string[],
  };
}

/** Open an SSE "browser tab" against the hub and capture its streamId. */
export async function openTab(
  url: string,
  opts: { agent?: HttpsAgent; headers?: Record<string, string>; signal: AbortSignal },
): Promise<{ streamId: string; next: () => Promise<{ event: string; data: string }>; close: () => void }> {
  const https = await import("node:https");
  const parsed = new URL(url);
  const req = (parsed.protocol === "https:" ? https : await import("node:http")).get(
    {
      protocol: parsed.protocol,
      hostname: parsed.hostname,
      port: parsed.port,
      path: `${parsed.pathname}${parsed.search}`,
      headers: { accept: "text/event-stream", ...(opts.headers ?? {}) },
      ...(opts.agent ? { agent: opts.agent } : {}),
      signal: opts.signal,
    },
    (res) => {
      if (res.statusCode !== 200) throw new Error(`tab open failed: ${res.statusCode}`);
      wire(res);
    },
  );
  req.on("error", () => {/* aborted */});
  let streamId = "";
  const pending: { event: string; data: string }[] = [];
  let waiter: (() => void) | null = null;
  let onChunk = (chunk: Buffer) => {
    void chunk;
  };
  const wire = (res: import("node:http").IncomingMessage) => {
    res.setEncoding("utf8");
    let buffer = "";
    onChunk = (chunk: Buffer) => {
      buffer += chunk.toString("utf8");
      let idx: number;
      while ((idx = buffer.indexOf("\n\n")) >= 0) {
        const raw = buffer.slice(0, idx);
        buffer = buffer.slice(idx + 2);
        let event = "message";
        const dataLines: string[] = [];
        for (const line of raw.split("\n")) {
          if (line.startsWith("event:")) event = line.slice(6).trim();
          else if (line.startsWith("data:")) dataLines.push(line.slice(5).trim());
          else if (line.startsWith("id:")) streamId = line.slice(3).trim();
        }
        if (dataLines.length) {
          pending.push({ event, data: dataLines.join("\n") });
          waiter?.();
        }
      }
    };
    res.on("data", onChunk);
  };
  // Response arrives async; requests via .get callback wire the stream above.
  return {
    get streamId() {
      return streamId;
    },
    next: () =>
      new Promise((resolve) => {
        const check = () => {
          const item = pending.shift();
          if (item) resolve(item);
          else waiter = check;
        };
        check();
      }),
    close: () => {
      req.destroy();
    },
  };
}
