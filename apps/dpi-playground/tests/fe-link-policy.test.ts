// Gate A GA-01 (FE half): transcript markdown is written by a device or by an agent that a
// device can prompt-inject, and it is rendered inside the ADMIN origin. A link in it must never
// lead back into the hub itself, because one click is a top-level navigation under the
// operator's credentials. This pins the pure policy; the rendered result in a real browser is
// asserted by tests/network-ui.mjs.
import test from "node:test";
import assert from "node:assert/strict";
import { externalHref } from "../apps/dpi-playground-fe/src/client/link-policy.js";

const HUB = "https://hub.example.com";

test("GA-01: absolute http(s) links to other origins survive, normalised", () => {
  assert.equal(externalHref("https://example.org/a?b=1#c", HUB), "https://example.org/a?b=1#c");
  assert.equal(externalHref("http://example.org", HUB), "http://example.org/");
  assert.equal(externalHref("HTTPS://EXAMPLE.ORG/x", HUB), "https://example.org/x");
  assert.equal(externalHref("  https://example.org/x\n", HUB), "https://example.org/x");
  assert.equal(
    externalHref("https://hub.example.com.evil.test/x", HUB),
    "https://hub.example.com.evil.test/x",
  );
  assert.equal(
    externalHref("https://hub.example.com:8443/x", HUB),
    "https://hub.example.com:8443/x",
    "another port is another origin",
  );
});

test("GA-01: relative, protocol-relative and fragment-only links are dropped", () => {
  for (const href of [
    "/api/devices/dev/v1/sessions/s1/transcript",
    "api/devices/dev/v1/x",
    "./x",
    "../x",
    "#top",
    "?q=1",
    "//evil.test/x",
    "///evil.test/x",
    "",
    "   ",
  ])
    assert.equal(externalHref(href, HUB), null, JSON.stringify(href));
});

test("GA-01: links that resolve to the hub's own origin are dropped however they are spelled", () => {
  for (const href of [
    "https://hub.example.com/api/network",
    "HTTPS://HUB.EXAMPLE.COM/api/network",
    "https://hub.example.com:443/api/network",
    "https://user:pw@hub.example.com/api/network",
    " \thttps://hub.example.com/api/network\n",
    "https://hub.example.com",
  ])
    assert.equal(externalHref(href, HUB), null, JSON.stringify(href));
  assert.equal(externalHref("http://127.0.0.1:4781/api/network", "http://127.0.0.1:4781"), null);
  assert.equal(
    externalHref("http://0x7f.1:4781/api/network", "http://127.0.0.1:4781"),
    null,
    "numeric host forms normalise first",
  );
});

test("GA-01: non-web schemes are dropped", () => {
  for (const href of [
    "javascript:alert(1)",
    "JaVaScRiPt:alert(1)",
    "java\nscript:alert(1)",
    "data:text/html,<script>alert(1)</script>",
    "vbscript:msgbox(1)",
    "mailto:a@example.org",
    "tel:+100",
    "file:///etc/passwd",
    "blob:https://hub.example.com/6f1c0b9e",
    "ws://example.org/",
  ])
    assert.equal(externalHref(href, HUB), null, JSON.stringify(href));
});
