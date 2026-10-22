/**
 * Credential issuance service (spec 03 §8.1, 07 §5.2, plan P2-10).
 *
 * The PairingService calls issue() exactly once per approved enrollment.
 * Everything secret is prepared in RAM first; then ONE synchronous SQLite
 * transaction writes devices + pairings + tunnel_credentials + the audit row
 * and only afterwards does the TokenIssue (with plaintext token) leave this
 * process. node:sqlite is synchronous, so check/consume/commit cannot
 * interleave in-process.
 *
 * - The device never chooses its registry ID: unique device_uid reuses the
 *   existing row, fresh identities get a stripped-UUID id.
 * - Re-pair revokes EVERY credential of the old epoch (tombstones retained)
 *   and starts a new epoch at generation 1.
 * - Receipt cache validation: a cached TokenIssue is only served again while
 *   its credential is still current/previous AND its epoch is still the
 *   active pairing. Revoked/re-paired → never return the stale secret.
 */
import { createHash, randomUUID } from "node:crypto";
import type { NetworkRegistry } from "../../../../dpi-sdk/src/node/registry.js";
import type { Audit } from "./audit.js";
import { observeIdentity } from "./identity.js";
import { newTunnelToken } from "./tunnel-token.js";
import type { TokenIssue } from "../../../../dpi-sdk/src/protocol/pairing.js";

export interface IssueInput {
  enrollmentId: string;
  codeId: string;
  deviceUid: string;
  deviceName: string;
  publicKeyPem: string;
  keyFingerprint: string;
  replaceKey: boolean;
  /**
   * `observeIdentity().stamp` the operator approved against. Re-checked inside the issuance
   * transaction: if the identity moved since (revoke, re-pair, key replacement), nothing is issued.
   * PairingService always supplies it; omit only for trusted in-process seeding.
   */
  expectedIdentity?: string;
}

export type IssueFailPoint = "preflight" | "after-prepare" | "after-commit";

const UUID_CANONICAL = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

export class CredentialService {
  constructor(
    private readonly registry: NetworkRegistry,
    private readonly audit: Audit,
    private readonly hubOrigin: string,
    private readonly hubId: string,
    private readonly failAt?: IssueFailPoint,
  ) {}

  /**
   * Resolve + validate identity BEFORE any mutation. Throws identity_conflict
   * for duplicate UID rows or non-canonical UIDs (operator resolves manually).
   */
  private preflight(deviceUid: string): { existingRowId?: string; newId: string } {
    if (!UUID_CANONICAL.test(deviceUid))
      throw Object.assign(new Error(`non-canonical deviceUid ${deviceUid}`), {
        code: "identity_conflict",
      });
    const rows = this.registry.db
      .prepare("SELECT id FROM devices WHERE device_uid=?")
      .all(deviceUid) as { id: string }[];
    if (rows.length > 1)
      throw Object.assign(
        new Error(`device_uid ${deviceUid} maps to ${rows.length} rows; operator must resolve`),
        { code: "identity_conflict" },
      );
    const newId = randomUUID().replace(/-/g, "");
    if (this.registry.get(newId))
      throw Object.assign(new Error(`registry id collision on ${newId}`), {
        code: "identity_conflict",
      });
    return { existingRowId: rows[0]?.id, newId };
  }

  async issue(input: IssueInput): Promise<TokenIssue> {
    const identity = this.preflight(input.deviceUid);
    if (this.failAt === "preflight")
      throw Object.assign(new Error("injected: preflight"), { code: "injected" });

    // ---- prepare everything in RAM (secrets never touch the DB as plaintext)
    const token = newTunnelToken();
    const tokenHash = createHash("sha256").update(token).digest("hex");
    const credentialId = randomUUID();
    const pairingEpoch = randomUUID();
    const now = Date.now();
    const deviceId = identity.existingRowId ?? identity.newId;

    if (this.failAt === "after-prepare")
      throw Object.assign(new Error("injected: after-prepare"), { code: "injected" });

    // ---- one synchronous transaction: identity + pairing + credential + audit
    this.audit.withTransaction(() => {
      // GA-05: judged inside the write lock, against what the operator actually approved.
      const current = observeIdentity(this.registry, input.deviceUid);
      if (input.expectedIdentity !== undefined && input.expectedIdentity !== current.stamp)
        throw Object.assign(
          new Error("device identity changed since approval; a new approval is required"),
          { code: "identity_changed" },
        );
      const replacedKeyFingerprint =
        current.storedFingerprint && current.storedFingerprint !== input.keyFingerprint
          ? current.storedFingerprint
          : undefined;
      if (replacedKeyFingerprint && !input.replaceKey)
        throw Object.assign(
          new Error("a different key is on record for this device; replaceKey is required"),
          { code: "key_replacement_required" },
        );

      if (identity.existingRowId) {
        const row = this.registry.get(identity.existingRowId)!;
        if (row.transport === "lan") {
          // Converting a LAN row: identity stays, endpoint/token are cleared,
          // and the audit row records the conversion for the operator.
          this.registry.setTransportTunnel(identity.existingRowId);
        } else {
          // Re-pair over an existing tunnel row: retire the old epoch first.
          this.registry.db
            .prepare(
              `UPDATE tunnel_credentials SET status='revoked', revoked_at=? WHERE device_id=? AND status IN ('current','previous','retired')`,
            )
            .run(now, identity.existingRowId);
          this.registry.db
            .prepare(
              `UPDATE pairings SET status='revoked', updated_at=? WHERE device_id=? AND status='paired'`,
            )
            .run(now, identity.existingRowId);
        }
        this.registry.db
          .prepare("UPDATE devices SET name=?, updated_at=? WHERE id=?")
          .run(input.deviceName, now, identity.existingRowId);
      } else {
        this.registry.db
          .prepare(
            `INSERT INTO devices(id,name,kind,url,token,source,position,device_uid,last_status,created_at,updated_at,transport)
             VALUES(?,?,'url',NULL,NULL,'ui',0,?,'checking',?,?,'tunnel')`,
          )
          .run(deviceId, input.deviceName || deviceId, input.deviceUid, now, now);
      }
      // pairings is one row per device (PK): upsert the CURRENT epoch.
      this.registry.db
        .prepare(
          `INSERT INTO pairings(device_id,pairing_epoch,public_key,key_fingerprint,status,credential_generation,paired_at,created_at,updated_at)
           VALUES(?,?,?,?,'paired',1,?,?,?)
           ON CONFLICT(device_id) DO UPDATE SET pairing_epoch=excluded.pairing_epoch,
             public_key=excluded.public_key, key_fingerprint=excluded.key_fingerprint,
             status='paired', credential_generation=1, paired_at=excluded.paired_at, updated_at=excluded.updated_at,
             rotation_id=NULL, rotation_target_credential_id=NULL, rotation_started_at=NULL, rotation_requested_at=NULL`,
        )
        .run(deviceId, pairingEpoch, input.publicKeyPem, input.keyFingerprint, now, now, now);
      this.registry.db
        .prepare(
          `INSERT INTO tunnel_credentials(credential_id,device_id,pairing_epoch,generation,token_hash,status,created_at)
           VALUES(?,?,?,1,?,'current',?)`,
        )
        .run(credentialId, deviceId, pairingEpoch, tokenHash, now);
      this.audit.append({
        actor: "hub",
        action: "pair.success",
        outcome: "ok",
        detail: {
          codeId: input.codeId,
          enrollmentId: input.enrollmentId,
          deviceId,
          pairingEpoch,
          credentialId,
          keyFingerprint: input.keyFingerprint,
          replaceKey: input.replaceKey,
          ...(replacedKeyFingerprint ? { replacedKeyFingerprint } : {}),
        },
      });
    });

    if (this.failAt === "after-commit")
      throw Object.assign(new Error("injected: after-commit"), { code: "injected" });

    // Response precomputed above; returned only after the commit succeeded.
    return {
      type: "pair.token",
      v: 1,
      enrollmentId: input.enrollmentId,
      deviceUid: input.deviceUid,
      deviceId,
      pairingEpoch,
      credentialId,
      generation: 1,
      hubId: this.hubId,
      hubOrigin: this.hubOrigin,
      hubUrl: `${this.hubOrigin}/api/tunnel`,
      tunnelToken: token,
      issuedAt: now,
      expiresAt: null,
    };
  }

  /**
   * Durable revoke (03 §8.3, P2-20): pairing paired→revoked, EVERY credential
   * hash (current/previous/retired) → revoked with tombstones retained, one
   * audit row, all in ONE transaction. The caller is responsible for cutting
   * the live transport right after commit — authorization is already dead:
   * the upgrade path consults these rows directly, so a revoked bearer is
   * 401 within the same tick, notice ACK or not.
   */
  revoke(deviceId: string, reason: "user" | "compromise" | "hub_migrated", actor: string): void {
    const now = Date.now();
    const pairing = this.registry.db
      .prepare("SELECT pairing_epoch, status FROM pairings WHERE device_id=?")
      .get(deviceId) as { pairing_epoch: string; status: string } | undefined;
    if (!pairing || pairing.status !== "paired")
      throw Object.assign(new Error(`No active pairing for ${deviceId}`), { status: 404 });
    this.audit.withTransaction(() => {
      this.registry.db
        .prepare("UPDATE pairings SET status='revoked', updated_at=? WHERE device_id=?")
        .run(now, deviceId);
      this.registry.db
        .prepare(
          "UPDATE tunnel_credentials SET status='revoked', revoked_at=? WHERE device_id=? AND status IN ('current','previous','retired')",
        )
        .run(now, deviceId);
      this.registry.db.prepare("DELETE FROM tunnel_state WHERE device_id=?").run(deviceId);
      this.audit.append({
        actor,
        action: "pair.revoke",
        outcome: "ok",
        detail: { deviceId, pairingEpoch: pairing.pairing_epoch, reason },
      });
    });
  }

  /**
   * A cached TokenIssue may only be replayed while its credential is still
   * current/previous AND its epoch is the active pairing. Never return a
   * revoked or superseded secret just because the receipt TTL is still open.
   */
  receiptStillValid(
    tokenIssue: Pick<TokenIssue, "credentialId" | "pairingEpoch" | "deviceId">,
  ): boolean {
    const cred = this.registry.db
      .prepare("SELECT status FROM tunnel_credentials WHERE credential_id=?")
      .get(tokenIssue.credentialId) as { status: string } | undefined;
    if (!cred || !["current", "previous"].includes(cred.status)) return false;
    const pairing = this.registry.db
      .prepare("SELECT status, pairing_epoch FROM pairings WHERE device_id=?")
      .get(tokenIssue.deviceId) as { status: string; pairing_epoch: string } | undefined;
    return (
      !!pairing && pairing.status === "paired" && pairing.pairing_epoch === tokenIssue.pairingEpoch
    );
  }

  /** Which failure to surface for a stale receipt. */
  receiptFailure(
    tokenIssue: Pick<TokenIssue, "pairingEpoch" | "deviceId">,
  ): "paired_elsewhere" | "invalid" {
    const pairing = this.registry.db
      .prepare("SELECT status, pairing_epoch FROM pairings WHERE device_id=?")
      .get(tokenIssue.deviceId) as { status: string; pairing_epoch: string } | undefined;
    if (pairing && pairing.pairing_epoch !== tokenIssue.pairingEpoch) return "paired_elsewhere";
    return "invalid";
  }
}
