/**
 * Scriptable fake hub for the device pairing client: answers /api/pair/start and /api/pair/verify through an
 * injected fetch, builds the TokenIssue from what the device actually sent, and lets a test override any field
 * of the challenge or the issue.
 */
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
}

export function pairHub(options: PairHubOptions) {
  const now = options.now ?? PAIR_NOW;
  const hubId = options.hubId ?? PAIR_HUB_ID;
  const calls: { url: string; body: any }[] = [];
  let approved = !options.held;
  let request: { deviceUid?: string } = {};
  const enrollmentId = randomUUID();
  const fetchImpl = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input);
    const body = init?.body ? JSON.parse(String(init.body)) : {};
    calls.push({ url, body });
    const json = (status: number, payload: unknown) =>
      new Response(JSON.stringify(payload), { status, headers: { "content-type": "application/json" } });
    if (url.endsWith("/api/pair/start")) {
      request = body;
      return json(200, { type: "pair.challenge", v: 1, enrollmentId, nonce: "N".repeat(43), issuedAt: now, hubId, ...options.challenge });
    }
    if (url.endsWith("/api/pair/verify")) {
      if (!approved) return json(202, { type: "pair.pending", v: 1, enrollmentId, state: "awaiting_approval", expiresAt: now + 300_000, pollAfterMs: 1 });
      return json(200, {
        type: "pair.token", v: 1, enrollmentId, deviceUid: request.deviceUid, deviceId: "dev-9", pairingEpoch: randomUUID(),
        credentialId: randomUUID(), generation: 1, hubId, hubOrigin: options.origin, hubUrl: `${options.origin}/api/tunnel`,
        tunnelToken: `dpt_${"T".repeat(43)}`, issuedAt: now, expiresAt: null, ...options.issue,
      });
    }
    return json(200, { ok: true });
  }) as unknown as typeof fetch;
  return {
    fetchImpl,
    calls,
    approve: () => {
      approved = true;
    },
  };
}
