/**
 * Routine credential rotation, ACK and cache-loss recovery — P2-19
 * (spec 03 §8.2, 04 §4).
 *
 * Lifecycle:
 *   start   tx: current→previous, insert current G+1, persist
 *           pairings.rotation_id/rotation_target_credential_id/rotation_started_at,
 *           audit token.rotate_started; plaintext cached in RAM (bounded+TTL)
 *           ONLY for resend — never persisted.
 *   deliver control:token-rotate {token, epoch, rotationId, credentialId, generation}
 *           over the live tunnel.
 *   ack     explicit control:token-rotate-ack with an EXACT
 *           (rotationId, credentialId, generation, epoch) match → tx:
 *           previous→retired, clear rotation fields, audit rotate_completed,
 *           cache drop.
 *   implicit a reconnect whose handshake matches the TARGET credential +
 *           generation completes the rotation exactly like an ack.
 *   resend  a reconnect on the PREVIOUS credential with the cache intact
 *           resends the same rotation; with the cache lost/expired the
 *           UNCONFIRMED current is retired and the next generation is minted
 *           (previous stays previous — the device's live credential).
 *
 * Stale/duplicate acks never retire or overwrite a newer generation. Timer
 * eviction NEVER retires anything in the DB — only the RAM cache forgets.
 */
import { randomUUID, createHash } from "node:crypto";
import type { NetworkRegistry } from "../../../../dpi-sdk/src/node/registry.js";
import type { TunnelFrame } from "../../../../dpi-sdk/src/protocol/tunnel.js";
import { ROTATION_INTERVAL_DAYS } from "../../../../dpi-sdk/src/protocol/limits.js";
import { Audit } from "./audit.js";
import type { TunnelServer } from "./tunnel.js";

export interface RotationHooks {
  now?(): number;
  /** Cache TTL override (test policy); production 120 s. */
  cacheTtlMs?: number;
  /** RAM cache capacity (bounded). */
  cacheCapacity?: number;
}

interface CacheEntry {
  token: string;
  credentialId: string;
  generation: number;
  epoch: string;
  expiresAt: number;
}

export class RotationService {
  private readonly cache = new Map<string, CacheEntry>();
  private readonly now: () => number;

  constructor(
    private readonly registry: NetworkRegistry,
    private readonly audit: Audit,
    private readonly server: TunnelServer,
    private readonly hooks: RotationHooks = {},
  ) {
    this.now = hooks.now ?? Date.now;
    // Reconnect-driven recovery + implicit ack + due-rotation start.
    server.addOpenListener((conn) => this.onHandshake(conn));
    server.addDeviceFrameListener((conn, frame) => {
      if (frame.type === "control" && (frame as { action: string }).action === "token-rotate-ack")
        this.onAck(conn, frame as unknown as Parameters<RotationService["onAck"]>[1]);
    });
  }

  /** Bounded + TTL'd RAM cache; eviction forgets, it never touches the DB. */
  private cachePut(rotationId: string, entry: Omit<CacheEntry, "expiresAt">): void {
    const cap = this.hooks.cacheCapacity ?? 256;
    while (this.cache.size >= cap) {
      const oldest = this.cache.keys().next().value;
      if (oldest === undefined) break;
      this.cache.delete(oldest);
    }
    this.cache.set(rotationId, { ...entry, expiresAt: this.now() + (this.hooks.cacheTtlMs ?? 120_000) });
  }

  private cacheGet(rotationId: string): CacheEntry | undefined {
    const e = this.cache.get(rotationId);
    if (!e) return undefined;
    if (this.now() > e.expiresAt) {
      this.cache.delete(rotationId); // forget only — never retire on a timer
      return undefined;
    }
    return e;
  }

  cacheSize(): number {
    return this.cache.size;
  }

  /** Secret-free sentinel scan helper (tests): no plaintext outside RAM. */
  plaintextCacheHas(rotationId: string): boolean {
    return this.cache.has(rotationId);
  }

  // -- start ----------------------------------------------------------------

  /**
   * Rotate a device's tunnel credential. Offline devices only record
   * rotation_requested_at — no plaintext is minted until a connection is live
   * (the start happens on its next handshake).
   */
  startRotation(deviceId: string, actor: string): { ok: true; mode: "online" | "requested" } | { ok: false; error: string } {
    const device = this.registry.get(deviceId);
    if (!device) return { ok: false, error: `No device ${deviceId}` };
    if (device.transport !== "tunnel") return { ok: false, error: `${deviceId} is not a tunnel device` };
    if (!this.server.hasConnection(deviceId)) {
      this.audit.withTransaction(() => {
        this.registry.db
          .prepare("UPDATE pairings SET rotation_requested_at=? WHERE device_id=? AND status='paired'")
          .run(this.now(), deviceId);
        this.audit.append({
          actor,
          action: "token.rotate_started",
          outcome: "ok",
          detail: { deviceId, mode: "requested_offline" },
        });
      });
      return { ok: true, mode: "requested" };
    }
    return this.rotateOnline(deviceId, actor);
  }

  /** Mint G+1, swap current→previous, remember the rotation, deliver. */
  private rotateOnline(deviceId: string, actor: string): { ok: true; mode: "online" } | { ok: false; error: string } {
    const pairing = this.registry.db
      .prepare("SELECT pairing_epoch, credential_generation, rotation_id FROM pairings WHERE device_id=? AND status='paired'")
      .get(deviceId) as { pairing_epoch: string; credential_generation: number; rotation_id: string | null } | undefined;
    if (!pairing) return { ok: false, error: `${deviceId} has no active pairing` };
    if (pairing.rotation_id) return { ok: false, error: `${deviceId} already has a rotation in flight` };
    const generation = pairing.credential_generation + 1;
    const credentialId = randomUUID();
    const rotationId = randomUUID();
    const token = "dpt_" + Buffer.from(randomUUID() + randomUUID()).toString("base64url").slice(0, 43);
    const hash = createHash("sha256").update(token, "utf8").digest("hex");
    const now = this.now();
    this.audit.withTransaction(() => {
      this.registry.db
        .prepare("UPDATE tunnel_credentials SET status='previous', retired_at=NULL WHERE device_id=? AND status='current'")
        .run(deviceId);
      this.registry.db
        .prepare(
          `INSERT INTO tunnel_credentials(credential_id,device_id,pairing_epoch,generation,token_hash,status,created_at)
           VALUES(?,?,?,?,?,'current',?)`,
        )
        .run(credentialId, deviceId, pairing.pairing_epoch, generation, hash, now);
      this.registry.db
        .prepare(
          "UPDATE pairings SET rotation_id=?, rotation_target_credential_id=?, rotation_started_at=?, credential_generation=?, rotation_requested_at=NULL, updated_at=? WHERE device_id=?",
        )
        .run(rotationId, credentialId, now, generation, now, deviceId);
      this.audit.append({
        actor,
        action: "token.rotate_started",
        outcome: "ok",
        detail: { deviceId, rotationId, credentialId, generation },
      });
    });
    this.cachePut(rotationId, { token, credentialId, generation, epoch: pairing.pairing_epoch });
    this.deliver(deviceId, rotationId, credentialId, generation, pairing.pairing_epoch, token);
    return { ok: true, mode: "online" };
  }

  private deliver(deviceId: string, rotationId: string, credentialId: string, generation: number, epoch: string, token: string): boolean {
    return this.server.send(deviceId, {
      type: "control",
      action: "token-rotate",
      tunnelToken: token,
      pairingEpoch: epoch,
      rotationId,
      credentialId,
      generation,
    });
  }

  // -- handshake-driven recovery ---------------------------------------------

  /** Called after every valid identity handshake. */
  private onHandshake(conn: { deviceId: string; credentialId: string; generation: number }): void {
    const pairing = this.registry.db
      .prepare(
        "SELECT pairing_epoch, status, credential_generation, rotation_id, rotation_target_credential_id, rotation_started_at, rotation_requested_at, paired_at FROM pairings WHERE device_id=? AND status='paired'",
      )
      .get(conn.deviceId) as
      | {
          pairing_epoch: string;
          credential_generation: number;
          rotation_id: string | null;
          rotation_target_credential_id: string | null;
          rotation_started_at: number | null;
          rotation_requested_at: number | null;
          paired_at: number;
        }
      | undefined;
    if (!pairing) return;

    // F08: a re-pair must end any rotation intent left over from the OLD
    // epoch. If the recorded target credential is not from the live pairing,
    // the intent is stale: clear it (a UNIQUE crash lurks in its recovery —
    // recoverFromCacheLoss would mint a second 'current') and start clean.
    if (pairing.rotation_id && pairing.rotation_target_credential_id) {
      const target = this.registry.db
        .prepare("SELECT pairing_epoch FROM tunnel_credentials WHERE credential_id=?")
        .get(pairing.rotation_target_credential_id) as { pairing_epoch: string } | undefined;
      if (!target || target.pairing_epoch !== pairing.pairing_epoch) {
        this.registry.db
          .prepare(
            "UPDATE pairings SET rotation_id=NULL, rotation_target_credential_id=NULL, rotation_started_at=NULL, updated_at=? WHERE device_id=?",
          )
          .run(this.now(), conn.deviceId);
        this.audit.append({
          actor: "hub",
          action: "rotation.stale_cleared",
          outcome: "ok",
          detail: { deviceId: conn.deviceId, reason: "rotation target predates the current pairing epoch" },
        });
        pairing.rotation_id = null;
        pairing.rotation_target_credential_id = null;
        pairing.rotation_started_at = null;
      }
    }

    // Explicit rotation due (admin request recorded while offline, or the
    // routine 90-day interval): start it now that a connection is live.
    const due =
      pairing.rotation_requested_at !== null ||
      this.now() - pairing.paired_at >= ROTATION_INTERVAL_DAYS * 86_400_000;
    if (!pairing.rotation_id && due) {
      void this.startRotation(conn.deviceId, "hub");
      return;
    }
    if (!pairing.rotation_id || !pairing.rotation_target_credential_id) return;

    // IMPLICIT ACK: the device came back speaking the TARGET credential.
    if (conn.credentialId === pairing.rotation_target_credential_id && conn.generation === pairing.credential_generation) {
      this.completeRotation(conn.deviceId, pairing.rotation_id, pairing.rotation_target_credential_id, "implicit_ack");
      return;
    }

    // Device still on the PREVIOUS credential: resend the cached token, or
    // recover from cache loss by retiring the unconfirmed current and minting
    // the next generation (previous stays previous — the device lives on it).
    const cached = pairing.rotation_id ? this.cacheGet(pairing.rotation_id) : undefined;
    if (cached) {
      this.deliver(conn.deviceId, pairing.rotation_id, cached.credentialId, cached.generation, cached.epoch, cached.token);
      return;
    }
    if (conn.credentialId !== pairing.rotation_target_credential_id) {
      this.recoverFromCacheLoss(conn.deviceId, pairing.rotation_id, pairing.rotation_target_credential_id);
    }
  }

  /**
   * Cache lost/expired: retire the UNCONFIRMED current (it never reached the
   * device), keep the previous (the credential the device still holds) and
   * mint the next generation as the new target.
   */
  private recoverFromCacheLoss(deviceId: string, oldRotationId: string | null, unconfirmedCredentialId: string | null): void {
    if (!oldRotationId || !unconfirmedCredentialId) return;
    const pairing = this.registry.db
      .prepare("SELECT pairing_epoch, credential_generation FROM pairings WHERE device_id=? AND status='paired'")
      .get(deviceId) as { pairing_epoch: string; credential_generation: number } | undefined;
    if (!pairing) return;
    // Previous = generation G (device holds it); new target = G+2.
    const generation = pairing.credential_generation + 1;
    const credentialId = randomUUID();
    const rotationId = randomUUID();
    const token = "dpt_" + Buffer.from(randomUUID() + randomUUID()).toString("base64url").slice(0, 43);
    const hash = createHash("sha256").update(token, "utf8").digest("hex");
    const now = this.now();
    this.audit.withTransaction(() => {
      // The unconfirmed current becomes retired (never reached the device).
      this.registry.db
        .prepare("UPDATE tunnel_credentials SET status='retired', retired_at=? WHERE credential_id=? AND status='current'")
        .run(now, unconfirmedCredentialId);
      this.registry.db
        .prepare(
          `INSERT INTO tunnel_credentials(credential_id,device_id,pairing_epoch,generation,token_hash,status,created_at)
           VALUES(?,?,?,?,?,'current',?)`,
        )
        .run(credentialId, deviceId, pairing.pairing_epoch, generation, hash, now);
      this.registry.db
        .prepare(
          "UPDATE pairings SET rotation_id=?, rotation_target_credential_id=?, rotation_started_at=?, credential_generation=?, updated_at=? WHERE device_id=?",
        )
        .run(rotationId, credentialId, now, generation, now, deviceId);
      this.audit.append({
        actor: "hub",
        action: "token.rotate_regenerated",
        outcome: "ok",
        detail: { deviceId, oldRotationId: oldRotationId, rotationId, credentialId, generation, reason: "cache_loss" },
      });
    });
    this.cachePut(rotationId, { token, credentialId, generation, epoch: pairing.pairing_epoch });
    this.deliver(deviceId, rotationId, credentialId, generation, pairing.pairing_epoch, token);
  }

  // -- ack ---------------------------------------------------------------------

  private onAck(
    conn: { deviceId: string; connectionId: string },
    ack: Extract<TunnelFrame, { type: "control" }> & { action: "token-rotate-ack"; rotationId: string; credentialId: string; generation: number; pairingEpoch: string },
  ): void {
    const pairing = this.registry.db
      .prepare(
        "SELECT pairing_epoch, credential_generation, rotation_id, rotation_target_credential_id FROM pairings WHERE device_id=? AND status='paired'",
      )
      .get(conn.deviceId) as
      | { pairing_epoch: string; credential_generation: number; rotation_id: string | null; rotation_target_credential_id: string | null }
      | undefined;
    if (!pairing || !pairing.rotation_id) return; // stale/duplicate ack: ignore
    // EXACT match required; anything else is ignored — never retire/overwrite.
    if (
      ack.pairingEpoch !== pairing.pairing_epoch ||
      ack.rotationId !== pairing.rotation_id ||
      ack.credentialId !== pairing.rotation_target_credential_id ||
      ack.generation !== pairing.credential_generation
    ) {
      return;
    }
    this.completeRotation(conn.deviceId, ack.rotationId, ack.credentialId, "ack");
  }

  /** One completion tx: retire previous, clear rotation, audit, drop cache. */
  private completeRotation(deviceId: string, rotationId: string, targetCredentialId: string, via: "ack" | "implicit_ack"): void {
    const now = this.now();
    this.audit.withTransaction(() => {
      this.registry.db
        .prepare("UPDATE tunnel_credentials SET status='retired', retired_at=? WHERE device_id=? AND status='previous'")
        .run(now, deviceId);
      this.registry.db
        .prepare(
          "UPDATE pairings SET rotation_id=NULL, rotation_target_credential_id=NULL, rotation_started_at=NULL, updated_at=? WHERE device_id=?",
        )
        .run(now, deviceId);
      this.audit.append({
        actor: "hub",
        action: "token.rotate_completed",
        outcome: "ok",
        detail: { deviceId, rotationId, credentialId: targetCredentialId, via },
      });
    });
    this.cache.delete(rotationId);
  }
}
