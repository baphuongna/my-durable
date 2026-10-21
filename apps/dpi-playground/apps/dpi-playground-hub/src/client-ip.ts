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
