import { randomBytes } from "node:crypto";

/**
 * The one place a tunnel token is minted — pairing issuance and rotation both call it. The wire
 * schema (`dpt_` + 43 base64url chars) is 32 bytes; every one of those bits must come from the
 * CSPRNG, not from text that merely has the right length (a UUID is 122 random bits in a fixed
 * layout of hex digits and dashes).
 */
export function newTunnelToken(): string {
  return `dpt_${randomBytes(32).toString("base64url")}`;
}
