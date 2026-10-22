import type { IncomingMessage } from "node:http";
import { BlockList, isIP } from "node:net";

const loopback = new BlockList();
loopback.addSubnet("127.0.0.0", 8, "ipv4");
loopback.addAddress("::1", "ipv6");

/** The reference proxy runs on the same host. No other peers may assert XFF. */
export function isTrustedProxy(address: string): boolean {
  const family = isIP(address);
  return family !== 0 && loopback.check(address, family === 6 ? "ipv6" : "ipv4");
}

/**
 * Did this request reach the TLS proxy over TLS? Only the proxy can say so, and only a loopback peer
 * is the proxy. The reference proxy overwrites X-Forwarded-Proto from the real connection, so the
 * answer is exactly one `https`; a comma list means a hop appended to a value it did not own.
 */
export function viaTls(req: Pick<IncomingMessage, "socket" | "headers">): boolean {
  if (!isTrustedProxy(req.socket.remoteAddress ?? "")) return false;
  const proto = req.headers["x-forwarded-proto"];
  return typeof proto === "string" && proto.trim().toLowerCase() === "https";
}

/** The eight 16-bit groups of a valid IPv6 literal (zone already removed). */
function ipv6Groups(address: string): number[] {
  let text = address;
  const tail = /\d+\.\d+\.\d+\.\d+$/.exec(text)?.[0];
  if (tail) {
    const [a, b, c, d] = tail.split(".").map(Number);
    text = `${text.slice(0, -tail.length)}${((a << 8) | b).toString(16)}:${((c << 8) | d).toString(16)}`;
  }
  const [head, rest] = text.split("::");
  const front = head ? head.split(":") : [];
  const back = rest ? rest.split(":") : [];
  const gap = text.includes("::")
    ? new Array<string>(8 - front.length - back.length).fill("0")
    : [];
  return [...front, ...gap, ...back].map((group) => parseInt(group, 16));
}

/**
 * The identity a per-address limit counts. A /64 is the smallest block an IPv6 host can be handed, so
 * every address in it is one source; an IPv4 client of a dual-stack listener (`::ffff:a.b.c.d`) is
 * the IPv4 address. Anything that is not an IP literal is returned unchanged. Idempotent.
 */
export function ipKey(address: string): string {
  const literal = address.split("%", 1)[0];
  const family = isIP(literal);
  if (family === 4) return literal;
  if (family !== 6) return address;
  const g = ipv6Groups(literal);
  if (g.slice(0, 5).every((group) => group === 0) && g[5] === 0xffff)
    return `${g[6] >> 8}.${g[6] & 0xff}.${g[7] >> 8}.${g[7] & 0xff}`;
  return `${g
    .slice(0, 4)
    .map((group) => group.toString(16))
    .join(":")}::/64`;
}

/** Also used for upgrades, which never pass through Express's req.ip getter. */
export function clientIp(req: IncomingMessage): string {
  const peer = req.socket.remoteAddress ?? "unknown";
  if (!isTrustedProxy(peer)) return peer;
  const forwarded = req.headers["x-forwarded-for"];
  if (typeof forwarded !== "string") return peer;
  const chain = forwarded.split(",").map((address) => address.trim());
  if (chain.some((address) => !isIP(address))) return peer;
  let ip = peer;
  for (let i = chain.length - 1; i >= 0 && isTrustedProxy(ip); i--) ip = chain[i];
  return ip;
}
