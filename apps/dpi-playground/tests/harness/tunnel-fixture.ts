/**
 * Shared hub-tunnel fixture for the Gate A regression tests: a real HTTP server
 * wired like main.ts (upgrade → TunnelServer), a dispatcher, schema-faithful
 * device rows, and helpers to drive upgrades from chosen client IPs.
 *
 * Client IPs: direct test connections come from loopback, which the hub treats
 * as the trusted proxy, so `x-forwarded-for` selects the "real" client the same
 * way Caddy does in production.
 */
import { createServer } from "node:http";
import { Duplex } from "node:stream";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createHash, randomUUID } from "node:crypto";
import { WebSocket } from "ws";
import { NetworkRegistry } from "../../../dpi-sdk/src/node/registry.js";
import { Audit, type AuditOptions } from "../../apps/dpi-playground-hub/src/audit.js";
import { TunnelServer } from "../../apps/dpi-playground-hub/src/tunnel.js";
import { TunnelDispatcher } from "../../apps/dpi-playground-hub/src/tunnel-transport.js";

export const HUB_ID = "0a1b2c3d-4e5f-6a7b-8c9d-0e1f2a3b4cff";
export const FINGERPRINT = `sha256:${"9".repeat(64)}`;
const sha = (s: string) => createHash("sha256").update(s, "utf8").digest("hex");
export const mintToken = () => "dpt_" + Buffer.from(randomUUID() + randomUUID()).toString("base64url").slice(0, 43);

export interface DeviceRow {
  id: string;
  uid: string;
  epoch: string;
  credentialId: string;
  token: string;
}

export class ResponseSocket extends Duplex {
  parts: string[] = [];
  _read() {}
  _write(chunk: Buffer, _encoding: string, callback: () => void) {
    this.parts.push(chunk.toString());
    callback();
  }
}

export interface FixtureOptions {
  policy?: ConstructorParameters<typeof TunnelServer>[4];
  audit?: AuditOptions;
  dispatcher?: ConstructorParameters<typeof TunnelDispatcher>[1];
  hooks?: ConstructorParameters<typeof TunnelServer>[5];
}

export async function tunnelFixture(options: FixtureOptions = {}) {
  const dir = await mkdtemp(join(tmpdir(), "dpi-gate-a-"));
  const registry = new NetworkRegistry(join(dir, "net.sqlite"));
  registry.clearTunnelState();
  const audit = new Audit(registry, options.audit ?? {});
  const tunnel = new TunnelServer(registry, audit, HUB_ID, {}, options.policy, options.hooks);
  const dispatcher = new TunnelDispatcher(tunnel, { audit, ...options.dispatcher });
  const addDevice = (id: string): DeviceRow => {
    const uid = randomUUID();
    const epoch = randomUUID();
    const token = mintToken();
    const credentialId = randomUUID();
    const t0 = Date.now();
    registry.db
      .prepare(
        `INSERT INTO devices(id,name,kind,url,token,source,position,device_uid,last_status,created_at,updated_at,transport)
         VALUES(?, 'T Dev', 'url', NULL, NULL, 'ui', 0, ?, 'checking', ?, ?, 'tunnel')`,
      )
      .run(id, uid, t0, t0);
    registry.db
      .prepare(
        `INSERT INTO pairings(device_id,pairing_epoch,public_key,key_fingerprint,status,credential_generation,paired_at,created_at,updated_at)
         VALUES(?,?,?,?,'paired',1,?,?,?)`,
      )
      .run(id, epoch, "pub", FINGERPRINT, t0, t0, t0);
    registry.db
      .prepare(
        `INSERT INTO tunnel_credentials(credential_id,device_id,pairing_epoch,generation,token_hash,status,created_at,confirmed_at)
         VALUES(?,?,?,?,?,'current',?,?)`,
      )
      .run(credentialId, id, epoch, 1, sha(token), t0, t0);
    return { id, uid, epoch, credentialId, token };
  };
  const server = createServer((_req, res) => res.writeHead(404).end());
  server.on("upgrade", (req, socket, head) => tunnel.handleUpgrade(req, socket, head));
  await new Promise<void>((done) => server.listen(0, "127.0.0.1", done));
  const port = (server.address() as { port: number }).port;
  const headersFor = (token: string | null, ip?: string): Record<string, string> => ({
    ...(token ? { authorization: `Bearer ${token}` } : {}),
    ...(ip ? { "x-forwarded-for": ip } : {}),
  });
  const handshakeFor = (d: DeviceRow) => ({
    type: "pair-handshake", v: 1, deviceUid: d.uid, deviceId: d.id, pairingEpoch: d.epoch,
    credentialId: d.credentialId, generation: 1, apiVersion: 1, tunnelProto: 1, keyFingerprint: FINGERPRINT,
  });

  /** Open the socket (101) without sending the application handshake. */
  const open = (d: DeviceRow, ip?: string): Promise<WebSocket> =>
    new Promise((resolve, reject) => {
      const ws = new WebSocket(`ws://127.0.0.1:${port}/api/tunnel`, { headers: headersFor(d.token, ip) });
      ws.once("open", () => resolve(ws));
      ws.once("error", reject);
      ws.once("unexpected-response", (_q, r) => {
        r.resume();
        reject(Object.assign(new Error(`upgrade ${r.statusCode}`), { statusCode: r.statusCode }));
      });
    });

  /** Open + handshake; resolves once hello arrived. */
  const connect = async (d: DeviceRow, ip?: string): Promise<WebSocket> => {
    const ws = await open(d, ip);
    const hello = new Promise<void>((resolve, reject) => {
      const on = (buf: Buffer) => {
        if (JSON.parse(buf.toString()).type === "hello") {
          ws.off("message", on);
          resolve();
        }
      };
      ws.on("message", on);
      ws.once("close", (code) => reject(Object.assign(new Error(`closed before hello (${code})`), { code })));
    });
    ws.send(JSON.stringify(handshakeFor(d)));
    await hello;
    return ws;
  };

  /** Real-network upgrade that is expected to be rejected; resolves with status + JSON body. */
  const rejected = (token: string | null, ip?: string): Promise<{ status: number; body: any }> =>
    new Promise((resolve, reject) => {
      const ws = new WebSocket(`ws://127.0.0.1:${port}/api/tunnel`, { headers: headersFor(token, ip) });
      ws.once("unexpected-response", (_q, res) => {
        const chunks: Buffer[] = [];
        res.on("data", (c: Buffer) => chunks.push(c));
        res.on("end", () => {
          let body: any = null;
          try {
            body = JSON.parse(Buffer.concat(chunks).toString("utf8"));
          } catch {
            /* non-JSON body */
          }
          resolve({ status: res.statusCode ?? 0, body });
          ws.terminate();
        });
      });
      ws.once("open", () => {
        ws.terminate();
        reject(new Error("unexpected 101"));
      });
      ws.once("error", reject);
    });

  /**
   * Synchronous in-process upgrade attempt (no network) from `ip`. Exceptions
   * from handleUpgrade propagate to the caller on purpose.
   */
  const attempt = (ip: string, token: string | null = mintToken(), extraHeaders: Record<string, string> = {}) => {
    const socket = new ResponseSocket();
    const req = {
      method: "GET",
      url: "/api/tunnel",
      headers: { ...(token ? { authorization: `Bearer ${token}` } : {}), ...extraHeaders },
      socket: { remoteAddress: ip },
    };
    tunnel.handleUpgrade(req as never, socket, Buffer.alloc(0));
    const status = Number(socket.parts[0]?.match(/^HTTP\/1\.1 (\d+)/)?.[1]);
    let body: any = null;
    try {
      body = JSON.parse(socket.parts[1] ?? "");
    } catch {
      /* no body */
    }
    return { status, body, socket };
  };

  const eventCount = (...actions: string[]): number =>
    (registry.db
      .prepare(`SELECT COUNT(*) c FROM events WHERE action IN (${actions.map(() => "?").join(",")})`)
      .get(...actions) as { c: number }).c;

  const cleanup = async () => {
    dispatcher.close();
    tunnel.close();
    server.closeAllConnections();
    await new Promise<void>((done) => server.close(() => done()));
    registry.close();
    await rm(dir, { recursive: true, force: true });
  };
  return { dir, registry, audit, tunnel, dispatcher, addDevice, open, connect, rejected, attempt, eventCount, cleanup, port };
}

export type TunnelFixture = Awaited<ReturnType<typeof tunnelFixture>>;
