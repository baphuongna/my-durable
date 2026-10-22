/**
 * The registry's view of one device UID, shared by the approval gate (PairingService) and the
 * issuance transaction (CredentialService) so both judge "has this identity changed?" the same way.
 *
 * A revoked pairing keeps its key (spec 03 §8.3), so the stored key is read in ANY pairing state:
 * a different key after a revoke is still a key replacement and needs the operator's replaceKey.
 */
import { createHash, createPublicKey } from "node:crypto";
import type { NetworkRegistry } from "../../../../dpi-sdk/src/node/registry.js";

export interface IdentityObservation {
  /**
   * Opaque digest of every registry fact an approval depends on (device row, pairing epoch,
   * pairing status, stored key). It is compared verbatim again inside the issuance transaction:
   * any change in between (revoke, re-pair, key replacement, a second enrollment) voids the approval.
   */
  stamp: string;
  /** Fingerprint of the key on record for this UID in any pairing state; absent when none exists. */
  storedFingerprint?: string;
}

interface Row {
  id: string;
  epoch: string | null;
  status: string | null;
  publicKey: string | null;
  keyFingerprint: string | null;
}

/** SPKI fingerprint recomputed from the stored PEM, so a formatting difference is not a key change. */
function fingerprintOfStoredKey(row: Row): string | undefined {
  if (row.publicKey === null) return undefined;
  try {
    const der = createPublicKey(row.publicKey).export({ format: "der", type: "spki" }) as Buffer;
    return `sha256:${createHash("sha256").update(der).digest("hex")}`;
  } catch {
    return (
      row.keyFingerprint ??
      `unparseable:${createHash("sha256").update(row.publicKey).digest("hex")}`
    );
  }
}

export function observeIdentity(registry: NetworkRegistry, deviceUid: string): IdentityObservation {
  const rows = registry.db
    .prepare(
      `SELECT d.id AS id, p.pairing_epoch AS epoch, p.status AS status, p.public_key AS publicKey,
              p.key_fingerprint AS keyFingerprint
         FROM devices d LEFT JOIN pairings p ON p.device_id = d.id
        WHERE d.device_uid=? ORDER BY d.id`,
    )
    .all(deviceUid) as unknown as Row[];
  const fingerprints = rows.map(fingerprintOfStoredKey);
  const stamp = createHash("sha256")
    .update(JSON.stringify(rows.map((r, i) => [r.id, r.epoch, r.status, fingerprints[i] ?? null])))
    .digest("hex");
  // Several rows for one UID is an operator-resolved conflict (CredentialService preflight): no single stored key.
  const storedFingerprint = rows.length === 1 ? fingerprints[0] : undefined;
  return { stamp, ...(storedFingerprint ? { storedFingerprint } : {}) };
}
