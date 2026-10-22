/** Pair links stay in RAM and may only refer to the browser's own hub. */
import { decodePairOffer, normalizePairCode, parsePairOfferUrl } from "../../../../../dpi-sdk/src/protocol/pairing";

export type PairHandoff = { code: string; origin: string } | { error: string };

export function readPairHandoff(url: URL): PairHandoff | undefined {
  if (!/^\/pair\/?$/.test(url.pathname)) return undefined;
  // v2 FIRST: the whole handoff rides the #offer= fragment, decoded client-side —
  // the code never travels in a query, so it never reaches any server or CDN log.
  if (url.hash.startsWith("#offer=")) {
    const parsed = parsePairOfferUrl(url.href);
    if (parsed) return { code: parsed.offer.code, origin: url.origin };
    const offer = decodePairOffer(url.hash.slice("#offer=".length));
    if (offer && offer.hub !== url.origin)
      return {
        error: "This pairing link does not belong to this hub. Open the original hub link instead.",
      };
    return { error: "Invalid pairing link. Use a complete link from the hub wizard." };
  }
  const params = url.searchParams;
  if (!params.has("code") && !params.has("origin") && !params.has("v")) return undefined;
  const code = params.get("code");
  // The SDK owns the code shape: canonicalise a grouped/lower-case value, refuse anything else.
  const canonical = code === null ? undefined : normalizePairCode(code);
  if (
    url.username ||
    url.password ||
    url.hash ||
    params.getAll("code").length !== 1 ||
    !canonical ||
    params.getAll("v").length !== 1 ||
    params.get("v") !== "1"
  ) {
    return { error: "Invalid pairing link. Use a complete version 1 link from the hub wizard." };
  }
  if (params.has("origin")) {
    try {
      const origin = new URL(params.get("origin")!);
      if (
        params.getAll("origin").length !== 1 ||
        origin.origin !== url.origin ||
        origin.pathname !== "/" ||
        origin.username ||
        origin.password ||
        origin.search ||
        origin.hash
      )
        throw Error("origin mismatch");
    } catch {
      return {
        error: "This pairing link does not belong to this hub. Open the original hub link instead.",
      };
    }
  }
  return { code: canonical, origin: url.origin };
}

/**
 * The scrubbed /pair URL would still open the wizard, and mint a fresh code, on reload.
 * Returns the path to replace it with, or undefined when the URL is not a pair URL.
 */
export const settledPairPath = (url: URL): string | undefined =>
  /^\/pair\/?$/.test(url.pathname) ? "/" : undefined;

/**
 * A bare /pair URL has no handoff to resume: re-opening the wizard there would
 * mint a fresh pairing code on every reload. Go home instead — the admin
 * sidebar button remains the only way to start a pairing without a link.
 */
export const barePairHome = (url: URL): string | undefined =>
  /^\/pair\/?$/.test(url.pathname) && readPairHandoff(url) === undefined ? "/" : undefined;
