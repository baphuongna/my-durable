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
 *   remind  a live connection whose rotation is still pending gets ONE
 *           redelivery shortly before the plaintext TTL ends (a failed first
 *           deliver() lands here too). The hub never regenerates blind for a
 *           connection that merely looks alive: minting G+2 without proof the
 *           device is on the previous credential could strand one that
 *           persisted G+1, and a wedged device would inflate a generation per
 *           TTL. After the TTL, only the reconnect path owns recovery.
 *
 * Stale/duplicate acks never retire or overwrite a newer generation. Timer
 * eviction NEVER retires anything in the DB — only the RAM cache forgets.
 */
import { randomUUID, createHash } from "node:crypto";
import type { NetworkRegistry } from "../../../../dpi-sdk/src/node/registry.js";
import type { TunnelFrame } from "../../../../dpi-sdk/src/protocol/tunnel.js";
import { ROTATION_INTERVAL_DAYS } from "../../../../dpi-sdk/src/protocol/limits.js";
import { Audit } from "./audit.js";
import { newTunnelToken } from "./tunnel-token.js";
import type { TunnelServer } from "./tunnel.js";

export interface RotationHooks {
  now?(): number;
  /** Cache TTL override (test policy); production 120 s. */
  cacheTtlMs?: number;
  /** RAM cache capacity (bounded). */
  cacheCapacity?: number;
  /** Publish committed metadata changes to open browser streams. */
  onChange?(): void;
}

interface CacheEntry {
  deviceId: string;
  token: string;
  credentialId: string;
  generation: number;
  epoch: string;
  expiresAt: number;
  /** Ends the entry's life even if nobody ever asks for it again. */
  timer: NodeJS.Timeout;
  /** One last delivery attempt on a still-live connection, shortly before `timer` fires. */
  reminder: NodeJS.Timeout;
}

/** Why a rotation was not started. */
export type RotationRefusal = "unknown_device" | "not_tunnel" | "no_pairing" | "in_flight";

export class RotationService {
  private readonly cache = new Map<string, CacheEntry>();
  /**
   * rotationId → the connection the token was last sent over. An ACK only counts from that
   * connection (spec 03 §8.2). Kept apart from the plaintext cache on purpose: a slow device that
   * persisted the token must still be acknowledged after the plaintext has been forgotten. RAM only —
   * a restarted hub has no connections to match, so the next handshake resends or regenerates.
   */
  private readonly deliveries = new Map<string, string>();
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

  /**
   * Bounded + TTL'd RAM cache; eviction forgets, it never touches the DB. Each entry carries its
   * own timer so the plaintext is gone when the TTL ends, not whenever the next reconnect happens
   * to look at it; the `expiresAt` check in `cacheGet` only backstops a wall clock that jumped.
   * A second, earlier timer is the ONE reminder a still-pending rotation gets on a live
   * connection before its plaintext is forgotten.
   */
  private cachePut(
    rotationId: string,
    entry: Omit<CacheEntry, "expiresAt" | "timer" | "reminder">,
  ): void {
    this.cacheForget(rotationId);
    const cap = this.hooks.cacheCapacity ?? 256;
    while (this.cache.size >= cap) {
      const oldest = this.cache.keys().next().value;
      if (oldest === undefined) break;
      this.cacheForget(oldest);
    }
    const ttl = this.hooks.cacheTtlMs ?? 120_000;
    const timer = setTimeout(() => this.cacheForget(rotationId), ttl);
    timer.unref();
    const reminder = setTimeout(
      () => this.redeliverIfPending(rotationId),
      Math.max(250, ttl - 5_000),
    );
    reminder.unref();
    this.cache.set(rotationId, { ...entry, expiresAt: this.now() + ttl, timer, reminder });
  }

  private cacheGet(rotationId: string): CacheEntry | undefined {
    const e = this.cache.get(rotationId);
    if (!e) return undefined;
    if (this.now() > e.expiresAt) {
      this.cacheForget(rotationId); // forget only — never retire on a timer
      return undefined;
    }
    return e;
  }

  private cacheForget(rotationId: string): void {
    const e = this.cache.get(rotationId);
    if (!e) return;
    clearTimeout(e.timer);
    clearTimeout(e.reminder);
    this.cache.delete(rotationId);
  }

  /**
   * The pre-TTL reminder. Delivers again ONLY while the rotation is still the pairing's live one,
   * the plaintext is still cached and the connection is still live — a no-op otherwise, and never
   * more than once per minted token.
   */
  private redeliverIfPending(rotationId: string): void {
    const entry = this.cacheGet(rotationId);
    if (!entry) return; // forgotten: only a reconnect may regenerate (never mint blind)
    const row = this.registry.db
      .prepare("SELECT rotation_id FROM pairings WHERE device_id=? AND status='paired'")
      .get(entry.deviceId) as { rotation_id: string | null } | undefined;
    if (row?.rotation_id !== rotationId) return; // acked, replaced or revoked meanwhile
    if (!this.server.hasConnection(entry.deviceId)) return; // offline: the handshake path owns recovery
    this.deliver(
      entry.deviceId,
      rotationId,
      entry.credentialId,
      entry.generation,
      entry.epoch,
      entry.token,
    );
  }

  /** Hub shutdown: drop every cached plaintext and its timer. */
  close(): void {
    for (const id of [...this.cache.keys()]) this.cacheForget(id);
    this.deliveries.clear();
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
  startRotation(
    deviceId: string,
    actor: string,
  ):
    | { ok: true; mode: "online" | "requested" }
    | { ok: false; code: RotationRefusal; error: string } {
    const device = this.registry.get(deviceId);
    if (!device) return { ok: false, code: "unknown_device", error: `No device ${deviceId}` };
    if (device.transport !== "tunnel")
      return { ok: false, code: "not_tunnel", error: `${deviceId} is not a tunnel device` };
    if (!this.server.hasConnection(deviceId)) {
      // "Requested while offline" is recorded against a live pairing only — an unpaired
      // device has nothing to rotate, and an ok:true would be a lie about what happened.
      const paired = this.registry.db
        .prepare("SELECT 1 AS x FROM pairings WHERE device_id=? AND status='paired'")
        .get(deviceId) as { x: 1 } | undefined;
      if (!paired)
        return { ok: false, code: "no_pairing", error: `${deviceId} has no active pairing` };
      this.audit.withTransaction(() => {
        this.registry.db
          .prepare(
            "UPDATE pairings SET rotation_requested_at=? WHERE device_id=? AND status='paired'",
          )
          .run(this.now(), deviceId);
        this.audit.append({
          actor,
          action: "token.rotate_started",
          outcome: "ok",
          detail: { deviceId, mode: "requested_offline" },
        });
      });
      this.hooks.onChange?.();
      return { ok: true, mode: "requested" };
    }
    return this.rotateOnline(deviceId, actor);
  }

  /** Mint G+1, swap current→previous, remember the rotation, deliver. */
  private rotateOnline(
    deviceId: string,
    actor: string,
  ): { ok: true; mode: "online" } | { ok: false; code: RotationRefusal; error: string } {
    const pairing = this.registry.db
      .prepare(
        "SELECT pairing_epoch, credential_generation, rotation_id FROM pairings WHERE device_id=? AND status='paired'",
      )
      .get(deviceId) as
      | { pairing_epoch: string; credential_generation: number; rotation_id: string | null }
      | undefined;
    if (!pairing)
      return { ok: false, code: "no_pairing", error: `${deviceId} has no active pairing` };
    if (pairing.rotation_id)
      return {
        ok: false,
        code: "in_flight",
        error: `${deviceId} already has a rotation in flight`,
      };
    const generation = pairing.credential_generation + 1;
    const credentialId = randomUUID();
    const rotationId = randomUUID();
    const token = newTunnelToken();
    const hash = createHash("sha256").update(token, "utf8").digest("hex");
    const now = this.now();
    this.audit.withTransaction(() => {
      this.registry.db
        .prepare(
          "UPDATE tunnel_credentials SET status='previous', retired_at=NULL WHERE device_id=? AND status='current'",
        )
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
    this.cachePut(rotationId, {
      deviceId,
      token,
      credentialId,
      generation,
      epoch: pairing.pairing_epoch,
    });
    this.hooks.onChange?.();
    // A refused send is not fatal: the pre-TTL reminder (cachePut) redelivers while the
    // connection stays live, and the reconnect path owns everything after that.
    this.deliver(deviceId, rotationId, credentialId, generation, pairing.pairing_epoch, token);
    return { ok: true, mode: "online" };
  }

  private deliver(
    deviceId: string,
    rotationId: string,
    credentialId: string,
    generation: number,
    epoch: string,
    token: string,
  ): boolean {
    const connectionId = this.server.connectionIdOf(deviceId); // read first: a failed send may tear the connection down
    const sent = this.server.send(deviceId, {
      type: "control",
      action: "token-rotate",
      tunnelToken: token,
      pairingEpoch: epoch,
      rotationId,
      credentialId,
      generation,
    });
    if (sent && connectionId) this.rememberDelivery(rotationId, connectionId);
    return sent;
  }

  private rememberDelivery(rotationId: string, connectionId: string): void {
    this.deliveries.delete(rotationId); // re-insert at the young end
    const cap = this.hooks.cacheCapacity ?? 256;
    while (this.deliveries.size >= cap) {
      const oldest = this.deliveries.keys().next().value;
      if (oldest === undefined) break;
      this.deliveries.delete(oldest);
    }
    this.deliveries.set(rotationId, connectionId);
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
        // One transaction: when the audit row cannot be written, the clear must not
        // happen either (a failed append rolls the UPDATE back and the throw is
        // contained by the open-listener loop; the next handshake retries).
        this.audit.withTransaction(() => {
          this.registry.db
            .prepare(
              "UPDATE pairings SET rotation_id=NULL, rotation_target_credential_id=NULL, rotation_started_at=NULL, updated_at=? WHERE device_id=?",
            )
            .run(this.now(), conn.deviceId);
          this.audit.append({
            actor: "hub",
            action: "rotation.stale_cleared",
            outcome: "ok",
            detail: {
              deviceId: conn.deviceId,
              reason: "rotation target predates the current pairing epoch",
            },
          });
        });
        this.cacheForget(pairing.rotation_id);
        this.deliveries.delete(pairing.rotation_id);
        pairing.rotation_id = null;
        pairing.rotation_target_credential_id = null;
        pairing.rotation_started_at = null;
      }
    }

    // Explicit rotation due (admin request recorded while offline, or the
    // routine 90-day interval): start it now that a connection is live.
    if (!pairing.rotation_id && this.rotationDue(conn.deviceId, pairing)) {
      void this.startRotation(conn.deviceId, "hub");
      return;
    }
    if (!pairing.rotation_id || !pairing.rotation_target_credential_id) return;

    // IMPLICIT ACK: the device came back speaking the TARGET credential.
    if (
      conn.credentialId === pairing.rotation_target_credential_id &&
      conn.generation === pairing.credential_generation
    ) {
      this.completeRotation(
        conn.deviceId,
        pairing.rotation_id,
        pairing.rotation_target_credential_id,
        "implicit_ack",
      );
      return;
    }

    // Device still on the PREVIOUS credential: resend the cached token, or
    // recover from cache loss by retiring the unconfirmed current and minting
    // the next generation (previous stays previous — the device lives on it).
    const cached = pairing.rotation_id ? this.cacheGet(pairing.rotation_id) : undefined;
    if (cached) {
      this.deliver(
        conn.deviceId,
        pairing.rotation_id,
        cached.credentialId,
        cached.generation,
        cached.epoch,
        cached.token,
      );
      return;
    }
    if (conn.credentialId !== pairing.rotation_target_credential_id) {
      this.recoverFromCacheLoss(
        conn.deviceId,
        pairing.rotation_id,
        pairing.rotation_target_credential_id,
      );
    }
  }

  /**
   * The 90-day window is measured from the newest credential the device is known to hold: the
   * pairing itself, or the rotation it last confirmed. Measuring from pairing alone would make
   * every reconnect after day 90 rotate again. `confirmed_at` is written when a rotation completes;
   * a credential minted before that column was maintained falls back to its creation time.
   */
  private rotationDue(
    deviceId: string,
    pairing: { pairing_epoch: string; paired_at: number; rotation_requested_at: number | null },
  ): boolean {
    if (pairing.rotation_requested_at !== null) return true;
    const current = this.registry.db
      .prepare(
        "SELECT COALESCE(confirmed_at, created_at) AS held_since FROM tunnel_credentials WHERE device_id=? AND pairing_epoch=? AND status='current'",
      )
      .get(deviceId, pairing.pairing_epoch) as { held_since: number } | undefined;
    const windowStart = Math.max(pairing.paired_at, current?.held_since ?? 0);
    return this.now() - windowStart >= ROTATION_INTERVAL_DAYS * 86_400_000;
  }

  /**
   * Cache lost/expired: retire the UNCONFIRMED current (it never reached the
   * device), keep the previous (the credential the device still holds) and
   * mint the next generation as the new target.
   */
  private recoverFromCacheLoss(
    deviceId: string,
    oldRotationId: string | null,
    unconfirmedCredentialId: string | null,
  ): void {
    if (!oldRotationId || !unconfirmedCredentialId) return;
    const pairing = this.registry.db
      .prepare(
        "SELECT pairing_epoch, credential_generation FROM pairings WHERE device_id=? AND status='paired'",
      )
      .get(deviceId) as { pairing_epoch: string; credential_generation: number } | undefined;
    if (!pairing) return;
    // Previous = generation G (device holds it); new target = G+2.
    const generation = pairing.credential_generation + 1;
    const credentialId = randomUUID();
    const rotationId = randomUUID();
    const token = newTunnelToken();
    const hash = createHash("sha256").update(token, "utf8").digest("hex");
    const now = this.now();
    this.audit.withTransaction(() => {
      // The unconfirmed current becomes retired (never reached the device).
      this.registry.db
        .prepare(
          "UPDATE tunnel_credentials SET status='retired', retired_at=? WHERE credential_id=? AND status='current'",
        )
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
        detail: {
          deviceId,
          oldRotationId: oldRotationId,
          rotationId,
          credentialId,
          generation,
          reason: "cache_loss",
        },
      });
    });
    this.cacheForget(oldRotationId);
    this.deliveries.delete(oldRotationId);
    this.cachePut(rotationId, {
      deviceId,
      token,
      credentialId,
      generation,
      epoch: pairing.pairing_epoch,
    });
    this.hooks.onChange?.();
    this.deliver(deviceId, rotationId, credentialId, generation, pairing.pairing_epoch, token);
  }

  // -- ack ---------------------------------------------------------------------

  private onAck(
    conn: { deviceId: string; connectionId: string },
    ack: Extract<TunnelFrame, { type: "control" }> & {
      action: "token-rotate-ack";
      rotationId: string;
      credentialId: string;
      generation: number;
      pairingEpoch: string;
    },
  ): void {
    const pairing = this.registry.db
      .prepare(
        "SELECT pairing_epoch, credential_generation, rotation_id, rotation_target_credential_id FROM pairings WHERE device_id=? AND status='paired'",
      )
      .get(conn.deviceId) as
      | {
          pairing_epoch: string;
          credential_generation: number;
          rotation_id: string | null;
          rotation_target_credential_id: string | null;
        }
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
    // ...and it must come from the connection the token was sent over.
    if (this.deliveries.get(ack.rotationId) !== conn.connectionId) return;
    this.completeRotation(conn.deviceId, ack.rotationId, ack.credentialId, "ack");
  }

  /** One completion tx: retire previous, clear rotation, audit, drop cache. */
  private completeRotation(
    deviceId: string,
    rotationId: string,
    targetCredentialId: string,
    via: "ack" | "implicit_ack",
  ): void {
    const now = this.now();
    this.audit.withTransaction(() => {
      this.registry.db
        .prepare(
          "UPDATE tunnel_credentials SET status='retired', retired_at=? WHERE device_id=? AND status='previous'",
        )
        .run(now, deviceId);
      this.registry.db
        .prepare("UPDATE tunnel_credentials SET confirmed_at=? WHERE credential_id=?")
        .run(now, targetCredentialId);
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
    this.cacheForget(rotationId);
    this.deliveries.delete(rotationId);
    this.hooks.onChange?.();
  }
}
