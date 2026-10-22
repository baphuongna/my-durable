/**
 * Scriptable fake hub for the device pairing client: answers /api/pair/start and /api/pair/verify through an
 * injected fetch, builds the TokenIssue from what the device actually sent, and lets a test override any field
 * of the challenge or the issue.
 */
import { generateKeyPairSync, createHash, sign as edSign } from "node:crypto";
import { hubProofSigningPayload } from "../../dpi-sdk/src/protocol/pairing.js";
import { randomUUID } from "node:crypto";

export const PAIR_UID = "0f1e2d3c-4b5a-6978-8796-a5b4c3d2e1f0";
export const PAIR_HUB_ID = "1a2b3c4d-5e6f-4a5b-8c9d-0e1f2a3b4c5d";
export const PAIR_NOW = 1760000000000;

export interface PairHubOptions {
  origin: string;
  hubId?: string;
  now?: number;
  challenge?: Record<string, unknown>;
  issue?: Record<string, unknown>;
  /** Hold the approval back until `approve()`. */
  held?: boolean;
  /**
   * Offer-v3 identity: when the request carries a hubNonce, the challenge
   * answers with a REAL Ed25519 proof over hubProofSigningPayload(...). By
   * default the proof signs with THIS key — set `tamper` to flip one piece.
   */
  identity?:
    | { kind: "honest" }
    | { kind: "wrong-key" } // proof by a DIFFERENT key than the pinned one
    | { kind: "garbage-signature" }; // right key, wrong bytes
  /** The kfp a v3 offer should pin (fingerprint of the harness identity key). */
  pinnedKfp?: string;
}

export function pairHub(options: PairHubOptions) {
  const now = options.now ?? PAIR_NOW;
  const hubId = options.hubId ?? PAIR_HUB_ID;
  const calls: { url: string; body: any }[] = [];
  let approved = !options.held;
  let request: { deviceUid?: string } = {};
  const enrollmentId = randomUUID();
  // One identity key per harness instance; a second one for wrong-key tampering.
  const idKey = generateKeyPairSync("ed25519");
  const otherKey = generateKeyPairSync("ed25519");
  const spkiFp = (k: typeof idKey) =>
    `sha256:${createHash("sha256")
      .update(k.publicKey.export({ format: "der", type: "spki" }) as Buffer)
      .digest("hex")}`;
  const idPem = idKey.publicKey.export({ type: "spki", format: "pem" }) as string;
  const sign = (payload: string, k: typeof idKey) =>
    edSign(null, Buffer.from(payload), k.privateKey).toString("base64url");
  const identity = options.identity;
  const fetchImpl = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input);
    const body = init?.body ? JSON.parse(String(init.body)) : {};
    calls.push({ url, body });
    const json = (status: number, payload: unknown) =>
      new Response(JSON.stringify(payload), {
        status,
        headers: { "content-type": "application/json" },
      });
    if (url.endsWith("/api/pair/start")) {
      request = body;
      // Offer v3: a hubNonce in the request is answered with the identity proof
      // the configured tamper mode picks.
      const proofFields: Record<string, unknown> = {};
      if (body.hubNonce && identity) {
        const payload = hubProofSigningPayload({
          hubOrigin: options.origin,
          hubId,
          subject: `pair:${enrollmentId}`,
          nonce: body.hubNonce,
        });
        if (identity.kind === "honest")
          Object.assign(proofFields, {
            hubPublicKey: idPem,
            hubKeyFingerprint: spkiFp(idKey),
            hubSignature: sign(payload, idKey),
          });
        else if (identity.kind === "wrong-key")
          Object.assign(proofFields, {
            hubPublicKey: otherKey.publicKey.export({ type: "spki", format: "pem" }) as string,
            hubKeyFingerprint: spkiFp(otherKey),
            hubSignature: sign(payload, otherKey),
          });
        else if (identity.kind === "garbage-signature")
          Object.assign(proofFields, {
            hubPublicKey: idPem,
            hubKeyFingerprint: spkiFp(idKey),
            hubSignature: "B".repeat(86),
          });
      }
      return json(200, {
        type: "pair.challenge",
        v: 1,
        enrollmentId,
        nonce: "N".repeat(43),
        issuedAt: now,
        hubId,
        ...proofFields,
        ...options.challenge,
      });
    }
    if (url.endsWith("/api/pair/verify")) {
      if (!approved)
        return json(202, {
          type: "pair.pending",
          v: 1,
          enrollmentId,
          state: "awaiting_approval",
          expiresAt: now + 300_000,
          pollAfterMs: 1,
        });
      return json(200, {
        type: "pair.token",
        v: 1,
        enrollmentId,
        deviceUid: request.deviceUid,
        deviceId: "dev-9",
        pairingEpoch: randomUUID(),
        credentialId: randomUUID(),
        generation: 1,
        hubId,
        hubOrigin: options.origin,
        hubUrl: `${options.origin}/api/tunnel`,
        tunnelToken: `dpt_${"T".repeat(43)}`,
        issuedAt: now,
        expiresAt: null,
        ...(identity ? { hubKeyFingerprint: spkiFp(idKey) } : {}),
        ...options.issue,
      });
    }
    return json(200, { ok: true });
  }) as unknown as typeof fetch;
  return {
    fetchImpl,
    calls,
    /** The harness identity's fingerprint — what an honest v3 offer pins. */
    identityFingerprint: spkiFp(idKey),
    approve: () => {
      approved = true;
    },
  };
}
