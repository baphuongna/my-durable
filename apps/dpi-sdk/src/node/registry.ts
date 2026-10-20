// The client-side device registry: ~/.dpi/network.sqlite. Shared by the playground hub,
// dpi-tui and scripts/net.ts on this machine. Holds tokens (mode 0600), live status and UI state.
import { DatabaseSync } from "node:sqlite";
import { mkdirSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { migrateRegistryFile } from "./registry-migration.js";
import type { DeviceInfo, DeviceKind, DeviceStatus, DeviceTree, NetworkDevice, PublicPairingMetadata, TunnelDiagnostics } from "../api.js";

export const dpiHome = () => process.env.DPI_HOME ?? join(homedir(), ".dpi");
export const DEVICE_ID = /^[a-z0-9][a-z0-9-]{0,31}$/;
export const DEVICE_KINDS: readonly DeviceKind[] = ["local", "ssh", "exe-dev", "url"];

export interface DeviceRow {
  id: string;
  name: string;
  kind: DeviceKind;
  transport: "lan" | "tunnel";
  /** null when transport="tunnel". */
  url: string | null;
  token: string | null;
  source: "config" | "ui";
  position: number;
  deviceUid: string | null;
  lastStatus: DeviceStatus;
  lastError: string | null;
  lastSeenAt: number | null;
  lastInfo: DeviceInfo | null;
  lastTree: DeviceTree | null;
  createdAt: number;
  updatedAt: number;
}

export interface DeviceInput {
  id: string;
  name?: string;
  kind?: DeviceKind;
  url: string;
  token?: string | null;
  source?: "config" | "ui";
  position?: number;
}

type RawRow = {
  id: string;
  name: string;
  kind: DeviceKind;
  transport: "lan" | "tunnel";
  url: string | null;
  token: string | null;
  source: "config" | "ui";
  position: number;
  device_uid: string | null;
  last_status: DeviceStatus;
  last_error: string | null;
  last_seen_at: number | null;
  last_info_json: string | null;
  last_tree_json: string | null;
  created_at: number;
  updated_at: number;
};

const parse = <T>(json: string | null): T | null => {
  if (!json) return null;
  try {
    return JSON.parse(json) as T;
  } catch {
    return null;
  }
};

export function normalizeUrl(url: string) {
  let parsed: URL;
  try {
    parsed = new URL(url.trim());
  } catch {
    throw Error(`Invalid URL: ${url}`);
  }
  if (!["http:", "https:"].includes(parsed.protocol)) throw Error("URL must use http or https");
  if (parsed.search || parsed.hash) throw Error("URL must not include a query or fragment");
  return parsed.toString().replace(/\/+$/, "");
}

export function validateToken(token: string) {
  if (token.length < 32) throw Error("Token must be at least 32 characters");
  if (/\s/.test(token)) throw Error("Token must not contain whitespace");
  return token;
}

export class NetworkRegistry {
  readonly db: DatabaseSync;
  readonly path: string;

  constructor(path = join(dpiHome(), "network.sqlite")) {
    this.path = path;
    mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
    // Bring the file to schema v1 first (WAL-safe backup + one-transaction
    // migration). Any failure throws — the hub/TUI must not boot on it.
    migrateRegistryFile(path);
    this.db = new DatabaseSync(path);
    this.db.exec("PRAGMA journal_mode=WAL; PRAGMA busy_timeout=3000; PRAGMA foreign_keys=ON;");
  }

  private row(raw: RawRow | undefined): DeviceRow | undefined {
    if (!raw) return undefined;
    return {
      id: raw.id,
      name: raw.name,
      kind: raw.kind,
      transport: raw.transport,
      url: raw.url,
      token: raw.token,
      source: raw.source,
      position: raw.position,
      deviceUid: raw.device_uid,
      lastStatus: raw.last_status,
      lastError: raw.last_error,
      lastSeenAt: raw.last_seen_at,
      lastInfo: parse<DeviceInfo>(raw.last_info_json),
      lastTree: parse<DeviceTree>(raw.last_tree_json),
      createdAt: raw.created_at,
      updatedAt: raw.updated_at,
    };
  }

  list(): DeviceRow[] {
    return (this.db.prepare("SELECT * FROM devices ORDER BY position, id").all() as RawRow[]).map(
      (raw) => this.row(raw)!,
    );
  }

  get(id: string): DeviceRow | undefined {
    return this.row(this.db.prepare("SELECT * FROM devices WHERE id=?").get(id) as RawRow | undefined);
  }

  /**
   * Insert or update a device. `token: undefined` keeps the stored token; `null` clears it.
   * Writer policy: a row already on transport="tunnel" keeps its identity — the
   * generic register/seed path may only sync display metadata (name/position);
   * it must not restore URL/token, flip transport, or delete the pairing.
   */
  upsert(input: DeviceInput): DeviceRow {
    if (!DEVICE_ID.test(input.id)) throw Error(`Device id must match ${DEVICE_ID} (got "${input.id}")`);
    const kind = input.kind ?? "url";
    if (!DEVICE_KINDS.includes(kind)) throw Error(`Unknown device kind: ${kind}`);
    const url = normalizeUrl(input.url);
    if (input.token) validateToken(input.token);
    const now = Date.now();
    const current = this.get(input.id);
    if (current && current.source === "config" && input.source === "ui")
      throw Error(`${input.id} comes from dpi-network.yaml; edit it there`);
    if (current?.transport === "tunnel") {
      // Allowed display-metadata sync only; endpoint/token inputs are ignored.
      this.db
        .prepare("UPDATE devices SET name=?, position=?, updated_at=? WHERE id=?")
        .run(input.name?.trim() || current.name, input.position ?? current.position, now, input.id);
      return this.get(input.id)!;
    }
    const position = input.position ?? current?.position ?? this.list().length;
    const token = input.token === undefined ? (current?.token ?? null) : input.token;
    const urlChanged = current && current.url !== url;
    this.db
      .prepare(
        `INSERT INTO devices(id,name,kind,url,token,source,position,created_at,updated_at)
         VALUES(?,?,?,?,?,?,?,?,?)
         ON CONFLICT(id) DO UPDATE SET name=excluded.name, kind=excluded.kind, url=excluded.url,
           token=excluded.token, source=excluded.source, position=excluded.position, updated_at=excluded.updated_at`,
      )
      .run(
        input.id,
        input.name?.trim() || input.id,
        kind,
        url,
        token,
        input.source ?? current?.source ?? "ui",
        position,
        current?.createdAt ?? now,
        now,
      );
    // A new URL may point at a different machine: forget the learned identity and caches.
    if (urlChanged)
      this.db
        .prepare(
          "UPDATE devices SET device_uid=NULL, last_tree_json=NULL, last_info_json=NULL, last_status='checking' WHERE id=?",
        )
        .run(input.id);
    return this.get(input.id)!;
  }

  setToken(id: string, token: string | null) {
    if (token) validateToken(token);
    const row = this.get(id);
    if (!row) throw Error(`Unknown device: ${id}`);
    if (row.transport === "tunnel")
      throw Error(`${id} is paired over the tunnel; full LAN tokens are not stored for tunnel devices`);
    const result = this.db
      .prepare("UPDATE devices SET token=?, updated_at=? WHERE id=?")
      .run(token, Date.now(), id);
    if (!result.changes) throw Error(`Unknown device: ${id}`);
  }

  /**
   * Remove a device. Rows with pairing or credential history are never
   * hard-deleted — the tombstones must survive (07 §5.2). Revoke instead.
   */
  remove(id: string) {
    const hasHistory =
      this.db.prepare("SELECT 1 FROM pairings WHERE device_id=?").get(id) ||
      this.db.prepare("SELECT 1 FROM tunnel_credentials WHERE device_id=?").get(id);
    if (hasHistory)
      throw Error(`${id} has pairing/credential history; revoke it instead of deleting (tombstones are retained)`);
    return this.db.prepare("DELETE FROM devices WHERE id=?").run(id).changes > 0;
  }

  /** Drop config LAN devices that are no longer in the YAML. Tunnel rows keep their identity. */
  pruneConfig(keep: readonly string[]) {
    for (const row of this.list())
      if (row.source === "config" && row.transport === "lan" && !keep.includes(row.id)) {
        try {
          this.remove(row.id);
        } catch {
          /* history rows stay; config drift is reported by the seed layer */
        }
      }
  }

  /** Switch a LAN row to tunnel identity inside the caller's issuance transaction. */
  setTransportTunnel(id: string): DeviceRow {
    const result = this.db
      .prepare("UPDATE devices SET transport='tunnel', url=NULL, token=NULL, updated_at=? WHERE id=? AND transport='lan'")
      .run(Date.now(), id);
    if (!result.changes) {
      const row = this.get(id);
      if (!row) throw Error(`Unknown device: ${id}`);
      throw Error(`${id} is already on transport="${row.transport}"`);
    }
    return this.get(id)!;
  }

  /** Explicit switch back to LAN: caller must have revoked tunnel credentials first. */
  setTransportLan(id: string, url: string, token: string | null): DeviceRow {
    const row = this.get(id);
    if (!row) throw Error(`Unknown device: ${id}`);
    if (row.transport !== "tunnel") throw Error(`${id} is not a tunnel device`);
    const normalized = normalizeUrl(url);
    if (token) validateToken(token);
    const stillActive = this.db
      .prepare("SELECT 1 FROM tunnel_credentials WHERE device_id=? AND status IN ('current','previous')")
      .get(id);
    if (stillActive) throw Error(`${id} still has active tunnel credentials; revoke them first`);
    this.db
      .prepare("UPDATE devices SET transport='lan', url=?, token=?, updated_at=? WHERE id=?")
      .run(normalized, token, Date.now(), id);
    return this.get(id)!;
  }

  /**
   * Learn the daemon UID for a LAN row. Enforces a unique mapping: if the UID
   * already belongs to another row, report the conflict instead of stealing it.
   */
  learnUid(id: string, uid: string): { ok: true } | { ok: false; conflict: string | null } {
    if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/.test(uid))
      return { ok: false, conflict: null };
    const owner = this.db
      .prepare("SELECT id FROM devices WHERE device_uid=? AND id<>?")
      .get(uid, id) as { id: string } | undefined;
    if (owner) return { ok: false, conflict: owner.id };
    this.db.prepare("UPDATE devices SET device_uid=? WHERE id=? AND device_uid IS NULL").run(uid, id);
    return { ok: true };
  }

  forgetUid(id: string) {
    this.db.prepare("UPDATE devices SET device_uid=NULL WHERE id=?").run(id);
  }

  recordStatus(
    id: string,
    patch: {
      status: DeviceStatus;
      error?: string | null;
      seenAt?: number;
      info?: DeviceInfo;
      tree?: DeviceTree;
    },
  ) {
    const sets = ["last_status=?", "last_error=?"];
    const values: (string | number | null)[] = [patch.status, patch.error ?? null];
    if (patch.seenAt !== undefined) sets.push("last_seen_at=?"), values.push(patch.seenAt);
    if (patch.info) sets.push("last_info_json=?"), values.push(JSON.stringify(patch.info));
    if (patch.tree) sets.push("last_tree_json=?"), values.push(JSON.stringify(patch.tree));
    this.db.prepare(`UPDATE devices SET ${sets.join(",")} WHERE id=?`).run(...values, id);
  }

  uiGet<T>(key: string): T | undefined {
    const row = this.db.prepare("SELECT value FROM ui_state WHERE key=?").get(key) as
      | { value: string }
      | undefined;
    return row ? (parse<T>(row.value) ?? undefined) : undefined;
  }

  uiSet(key: string, value: unknown) {
    const json = JSON.stringify(value);
    if (json.length > 100_000) throw Error("UI state value too large");
    this.db
      .prepare(
        "INSERT INTO ui_state(key,value,updated_at) VALUES(?,?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value, updated_at=excluded.updated_at",
      )
      .run(key, json, Date.now());
  }

  /** Hub boot: live tunnel state is RAM-only; never resurrect consumers from DB. */
  clearTunnelState() {
    this.db.prepare("DELETE FROM tunnel_state").run();
  }

  /**
   * Remove a device's tunnel-state diagnostics row, but ONLY if it still
   * belongs to `connectionId`. A stale socket's close handler must never
   * delete the row of the connection that superseded it (04 §4 swap rule).
   */
  clearTunnelStateFor(deviceId: string, connectionId: string) {
    this.db
      .prepare("DELETE FROM tunnel_state WHERE device_id=? AND connection_id=?")
      .run(deviceId, connectionId);
  }

  /** Throttled diagnostics snapshot (caller throttles; source of truth is RAM). */
  recordTunnelState(deviceId: string, patch: { connectionId: string; connectedAt?: number; lastSeenAt?: number; readerCount?: number }) {
    this.db
      .prepare(
        `INSERT INTO tunnel_state(device_id, connection_id, connected_at, last_seen_at, reader_count)
         VALUES(?,?,?,?,?)
         ON CONFLICT(device_id) DO UPDATE SET connection_id=excluded.connection_id,
           last_seen_at=excluded.last_seen_at, reader_count=excluded.reader_count`,
      )
      .run(
        deviceId,
        patch.connectionId,
        patch.connectedAt ?? Date.now(),
        patch.lastSeenAt ?? Date.now(),
        patch.readerCount ?? 0,
      );
  }

  close() {
    this.db.close();
  }
}

/** The browser-safe view of a row: never includes the token. */
export function toPublic(
  row: DeviceRow,
  live?: { status: DeviceStatus; error?: string; info?: DeviceInfo; tree?: DeviceTree; lastSeenAt?: number },
  meta?: { pairing?: PublicPairingMetadata; tunnel?: TunnelDiagnostics },
): NetworkDevice {
  return {
    id: row.id,
    name: row.name,
    kind: row.kind,
    transport: row.transport,
    url: row.transport === "tunnel" ? null : row.url,
    source: row.source,
    hasToken: row.transport === "lan" && !!row.token,
    deviceUid: row.deviceUid,
    ...(meta?.pairing ? { pairing: meta.pairing } : {}),
    ...(meta?.tunnel ? { tunnel: meta.tunnel } : {}),
    status: live?.status ?? row.lastStatus,
    error: (live ? live.error : row.lastError) ?? undefined,
    lastSeenAt: live?.lastSeenAt ?? row.lastSeenAt ?? undefined,
    info: live?.info ?? row.lastInfo ?? undefined,
    tree: live?.tree ?? row.lastTree ?? undefined,
  };
}
