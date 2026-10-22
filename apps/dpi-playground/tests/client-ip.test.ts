/**
 * Per-address limits count sources, not spellings. One IPv6 host owns a whole /64 and can move
 * through it at will, and an IPv4 client of a dual-stack listener shows up as `::ffff:a.b.c.d`;
 * both would otherwise buy a fresh quota per request.
 */
import test from "node:test";
import assert from "node:assert/strict";
import { ipKey } from "../apps/dpi-playground-hub/src/client-ip.js";

test("ipKey: an IPv4 address is its own key", () => {
  assert.equal(ipKey("203.0.113.9"), "203.0.113.9");
  assert.equal(ipKey("127.0.0.1"), "127.0.0.1");
});

test("ipKey: an IPv4-mapped IPv6 address is the IPv4 address it carries, in either spelling", () => {
  assert.equal(ipKey("::ffff:203.0.113.9"), "203.0.113.9");
  assert.equal(ipKey("::FFFF:203.0.113.9"), "203.0.113.9");
  assert.equal(ipKey("::ffff:cb00:7109"), "203.0.113.9");
  assert.equal(ipKey("0:0:0:0:0:ffff:cb00:7109"), "203.0.113.9");
  assert.equal(ipKey("::ffff:127.0.0.1"), "127.0.0.1");
});

test("ipKey: every address of one /64 shares a key, whatever its spelling", () => {
  const key = ipKey("2001:db8:1:2::1");
  for (const same of [
    "2001:db8:1:2:ffff:ffff:ffff:ffff",
    "2001:DB8:1:2:0:0:0:1",
    "2001:0db8:0001:0002::",
    "2001:db8:1:2:abcd:ef01:2345:6789",
  ])
    assert.equal(ipKey(same), key, same);
  assert.equal(key, "2001:db8:1:2::/64");
});

test("ipKey: a different /64 is a different key", () => {
  const key = ipKey("2001:db8:1:2::1");
  for (const other of [
    "2001:db8:1:3::1",
    "2001:db8:2:2::1",
    "2001:db9:1:2::1",
    "2002:db8:1:2::1",
    "fe80::1",
  ])
    assert.notEqual(ipKey(other), key, other);
  assert.notEqual(
    ipKey("2001:db8::1"),
    ipKey("2001:db8:0:1::1"),
    "the fourth group is part of the /64",
  );
});

test("ipKey: a zone id does not make a new source", () => {
  assert.equal(ipKey("fe80::1%eth0"), ipKey("fe80::2"));
  assert.equal(ipKey("fe80::1%2"), ipKey("fe80::1"));
});

test("ipKey: loopback and compressed forms are stable keys", () => {
  assert.equal(ipKey("::1"), ipKey("0:0:0:0:0:0:0:1"));
  assert.equal(ipKey("::"), ipKey("0:0:0:0:0:0:0:0"));
});

test("ipKey: keying a key changes nothing, so a caller that keys twice still counts one source", () => {
  for (const address of [
    "203.0.113.9",
    "::ffff:203.0.113.9",
    "2001:db8:1:2::1",
    "fe80::1%eth0",
    "::1",
    "unknown",
  ])
    assert.equal(ipKey(ipKey(address)), ipKey(address), address);
});

test("ipKey: a value that is not an IP address is left alone", () => {
  assert.equal(ipKey("unknown"), "unknown");
  assert.equal(ipKey(""), "");
  assert.equal(ipKey("not:an:address"), "not:an:address");
});
