/**
 * Hub identity key (offer v3 pinning, comparison gap #6).
 *
 * The hub keeps a persistent Ed25519 keypair in <DPI_HOME>/hub-identity.pem
 * (owner-only 0600) + hub-identity.pub.pem. Its sha256-of-SPKI fingerprint is
 * the `kfp` that rides every v3 pairing offer: devices pin it and demand a
 * proof of possession both at the ceremony (pair.challenge) and on every
 * tunnel connect (hello), so a hub swap is detectable even with TLS intact.
 *
 * First boot mints the key and audits `hub.identity_created` ONCE; later
 * boots load the same key. Like admin-auth, an unreadable/corrupt file is a
 * hard failure — a hub that silently re-minted its identity would strand
 * every pinned device.
 */
import {
  createHash,
  createPrivateKey,
  createPublicKey,
  generateKeyPairSync,
  sign as edSign,
} from "node:crypto";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { restrictToOwner, writePrivateFileAtomic } from "../../../../dpi-sdk/src/node/private-file.js";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import type { Audit } from "./audit.js";

export interface HubIdentity {
  /** Ed25519 SPKI PEM — sent to devices in the ceremony/hello proofs. */
  publicKeyPem: string;
  /** `sha256:<64 hex>` of the SPKI DER — the value devices pin (offer kfp). */
  fingerprint: string;
  /** Ed25519 signature over a canonical payload, base64url. */
  signPayload: (payload: string) => string;
}

function fingerprintOf(publicKeyPem: string): string {
  const der = createPublicKey(publicKeyPem).export({ format: "der", type: "spki" }) as Buffer;
  return `sha256:${createHash("sha256").update(der).digest("hex")}`;
}

export async function bootstrapHubIdentity(
  home: string = process.env.DPI_HOME ?? join(homedir(), ".dpi"),
  audit?: Audit,
  hooks: { envFile?: string | undefined; existsSync?: typeof existsSync; now?: () => number } = {},
): Promise<HubIdentity> {
  const privPath =
    hooks.envFile ?? process.env.DPI_HUB_IDENTITY_FILE ?? join(home, "hub-identity.pem");
  const pubPath = `${privPath}.pub.pem`;
  const exists = hooks.existsSync ?? existsSync;
  let privateKeyPem: string;
  let created = false;
  if (exists(privPath)) {
    privateKeyPem = readFileSync(privPath, "utf8");
    try {
      createPrivateKey(privateKeyPem); // unreadable/corrupt → hard failure, never re-mint
    } catch (e) {
      throw new Error(
        `hub identity key ${privPath} is unreadable; refusing to boot (a silent re-mint would strand every pinned device): ${(e as Error).message}`,
      );
    }
  } else {
    const kp = generateKeyPairSync("ed25519");
    privateKeyPem = kp.privateKey.export({ type: "pkcs8", format: "pem" }) as string;
    mkdirSync(dirname(privPath), { recursive: true, mode: 0o700 });
    // The hub's signing key is the highest-value secret on disk: publish it
    // atomically and owner-only on every platform (Windows DACL included).
    await writePrivateFileAtomic(privPath, privateKeyPem);
    writeFileSync(pubPath, kp.publicKey.export({ type: "spki", format: "pem" }) as string, {
      mode: 0o600,
    });
    created = true;
  }
  await restrictToOwner(privPath); // 0600 on POSIX, owner-only DACL on Windows
  const publicKeyPem = createPublicKey(createPrivateKey(privateKeyPem)).export({
    type: "spki",
    format: "pem",
  }) as unknown as string;
  const identity: HubIdentity = {
    publicKeyPem,
    fingerprint: fingerprintOf(publicKeyPem),
    signPayload: (payload: string) =>
      edSign(null, Buffer.from(payload), createPrivateKey(privateKeyPem)).toString("base64url"),
  };
  if (created)
    try {
      audit?.append({
        actor: "hub",
        action: "hub.identity_created",
        outcome: "ok",
        detail: { fingerprint: identity.fingerprint },
      });
    } catch {
      // GA-02: an audit volume under its free-space floor must not kill hub
      // boot — the identity file is already durable; the row is best-effort.
    }
  return identity;
}
