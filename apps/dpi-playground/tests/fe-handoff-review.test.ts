import test from "node:test";
import assert from "node:assert/strict";
import {
  barePairHome,
  readPairHandoff,
  settledPairPath,
} from "../apps/dpi-playground-fe/src/client/pair-handoff.js";

test("R08: pairing handoffs reject ambiguous or foreign inputs without echoing the code", () => {
  for (const query of [
    "?code=ABCD2345&v=1#untrusted",
    "?code=ABCD2345&v=1&origin=https://other.example",
    "?code=ABCD2345&v=1&origin=https://hub.example/path",
    "?code=ABCD2345",
    "?code=ABCD2345&v=1&v=2",
    "?code=ABCD2345&code=ZZZZ7777&v=1",
  ]) {
    const value = readPairHandoff(new URL(`https://hub.example/pair${query}`));
    assert.ok(value && "error" in value, "invalid handoffs cannot start a pairing lookup");
    assert.equal(JSON.stringify(value).includes("ABCD2345"), false);
  }
  assert.deepEqual(readPairHandoff(new URL("https://hub.example/pair?code=ABCD2345&v=1")), {
    code: "ABCD2345",
    origin: "https://hub.example",
  });
  assert.equal(readPairHandoff(new URL("https://hub.example/other?code=ABCD2345&v=1")), undefined);
});

test("R08: a bare /pair URL goes home instead of re-opening the wizard and minting a fresh code", () => {
  // reload of the scrubbed URL (or a typed /pair) has no handoff to resume
  assert.equal(barePairHome(new URL("https://hub.example/pair")), "/");
  assert.equal(barePairHome(new URL("https://hub.example/pair/")), "/");
  // any handoff — valid or error — keeps the wizard URL so the flow survives reload
  assert.equal(barePairHome(new URL("https://hub.example/pair?code=ABCD2345&v=1")), undefined);
  assert.equal(barePairHome(new URL("https://hub.example/pair?code=bogus&v=1")), undefined);
  assert.equal(barePairHome(new URL("https://hub.example/")), undefined);
});

test("R08: 12-char and grouped handoffs are accepted and scrubbed to the canonical code", () => {
  for (const [query, canonical] of [
    ["?code=ABCD2345EF67&v=1", "ABCD2345EF67"],
    ["?code=abcd-2345-ef67&v=1", "ABCD2345EF67"],
    ["?code=ABCD%202345%20EF67&v=1", "ABCD2345EF67"],
    ["?code=AB2C7DEF&v=1", "AB2C7DEF"], // legacy 8-char link already in flight
  ] as const) {
    assert.deepEqual(readPairHandoff(new URL(`https://hub.example/pair${query}`)), {
      code: canonical,
      origin: "https://hub.example",
    });
    const handoff = readPairHandoff(new URL(`https://hub.example/pair${query}`));
    assert.ok(handoff && "code" in handoff);
    // the value handed to the wizard is canonical: no separators, upper case
    assert.match(handoff.code, /^(?:[A-Z2-7]{12}|[A-Z2-7]{8})$/);
  }
  // unsupported lengths / alphabets / a truncated group never start a lookup, and are not echoed
  for (const raw of [
    "ABCD2345EF678",
    "ABCD2345EF",
    "ABCD2345EF6",
    "AB2C7DE0",
    "ABCD-2345",
    "ABCD2345EF67-AB",
  ]) {
    const value = readPairHandoff(new URL(`https://hub.example/pair?code=${raw}&v=1`));
    assert.ok(value && "error" in value, raw);
    assert.equal(JSON.stringify(value).includes(raw.replace(/[-% ]/g, "")), false, raw);
  }
});

const UUID_CODE = "a1b2c3d4-e5f6-4789-abcd-eff012345678";

test("R08: a minted UUID v4 handoff is accepted, canonicalised and keeps its hyphens", () => {
  // canonical lower-case UUID
  assert.deepEqual(readPairHandoff(new URL(`https://hub.example/pair?code=${UUID_CODE}&v=1`)), {
    code: UUID_CODE,
    origin: "https://hub.example",
  });
  // upper case from a human is the same code, scrubbed to the canonical form
  const upper = readPairHandoff(
    new URL(`https://hub.example/pair?code=${UUID_CODE.toUpperCase()}&v=1`),
  );
  assert.ok(upper && "code" in upper);
  assert.equal(upper.code, UUID_CODE);
  assert.equal(JSON.stringify(upper).includes("-"), true, "a UUID keeps its hyphens");

  // a hyphen-less hex string is not a code, a wrong version/variant nibble is not a v4, and none are echoed
  for (const raw of [
    UUID_CODE.replace(/-/g, ""),
    "a1b2c3d4-e5f6-5789-abcd-eff012345678",
    "a1b2c3d4-e5f6-4789-7bcd-eff012345678",
  ]) {
    const value = readPairHandoff(new URL(`https://hub.example/pair?code=${raw}&v=1`));
    assert.ok(value && "error" in value, raw);
    assert.equal(JSON.stringify(value).includes(raw), false, raw);
  }
  // the version contract is unchanged for UUID links
  assert.ok("error" in readPairHandoff(new URL(`https://hub.example/pair?code=${UUID_CODE}&v=2`))!);
});

// --- v2 offer links: the whole handoff rides the #offer= fragment, decoded client-side ---

import { encodePairOffer } from "../../dpi-sdk/src/protocol/pairing.js";

const OFFER = {
  v: 2 as const,
  hub: "https://hub.example",
  id: "1a2b3c4d-5e6f-4a5b-8c9d-0e1f2a3b4c5d",
  code: UUID_CODE,
  exp: Date.now() + 240_000,
};
const offerLink = (over: Partial<typeof OFFER> = {}) =>
  `https://hub.example/pair#offer=${encodePairOffer({ ...OFFER, ...over })}`;

test("R08: a valid offer fragment hands over the canonical code without any query", () => {
  const link = offerLink();
  const handoff = readPairHandoff(new URL(link));
  assert.deepEqual(handoff, {
    code: UUID_CODE,
    origin: "https://hub.example",
    offerFragment: `offer=${link.split("#offer=")[1]}`,
  });
  // the settled scrub target is unchanged: the replaceState to it clears query AND fragment
  assert.equal(settledPairPath(new URL(link)), "/");
  assert.notEqual(barePairHome(new URL(link)), "/", "a live handoff keeps the wizard URL");
  // /pair/ with a trailing slash is the same page
  const trailing = readPairHandoff(new URL(link.replace("/pair#", "/pair/#")));
  assert.deepEqual(
    {
      code: trailing && "code" in trailing ? trailing.code : undefined,
      origin: trailing && "code" in trailing ? trailing.origin : undefined,
    },
    { code: UUID_CODE, origin: "https://hub.example" },
  );
  assert.ok(
    trailing && "code" in trailing && trailing.offerFragment,
    "the trailing-slash link also relays the fragment",
  );
});

test("gap #4: an offer handoff carries its RAW fragment for the device page relay — never a query, never a fetch", () => {
  const link = offerLink();
  const handoff = readPairHandoff(new URL(link));
  assert.ok(handoff && "offerFragment" in handoff && handoff.offerFragment);
  // exactly the URL fragment, nothing else — no code-only echo, no origin munging
  assert.equal(handoff.offerFragment, link.split("#")[1]);
  assert.match(handoff.offerFragment, /^offer=[A-Za-z0-9_-]+$/);
  // v1 query handoffs have NO fragment to relay (the wizard stays their only path)
  const v1 = readPairHandoff(new URL("https://hub.example/pair?code=ABCD2345&v=1"));
  assert.ok(v1 && "code" in v1 && v1.offerFragment === undefined);
});

test("R08: an offer minted by another hub is the existing foreign-origin error, without echoing the payload", () => {
  const link = offerLink({ hub: "https://other.example" });
  const value = readPairHandoff(new URL(link));
  assert.ok(value && "error" in value, "a foreign offer never starts a lookup");
  assert.match(value.error, /does not belong to this hub/);
  assert.equal(JSON.stringify(value).includes(link.split("#offer=")[1]!), false);
});

test("R08: junk fragments are rejected like today — only a decodable #offer= counts", () => {
  // a bare junk hash with no query is not a handoff at all (goes home, like today)
  assert.equal(readPairHandoff(new URL("https://hub.example/pair#junk")), undefined);
  assert.equal(barePairHome(new URL("https://hub.example/pair#junk")), "/");
  // an #offer= fragment that does not decode is an explicit error, payload not echoed
  for (const link of [
    "https://hub.example/pair#offer=!!!",
    "https://hub.example/pair#offer=",
    `https://hub.example/pair#offer=${encodePairOffer({ ...OFFER, exp: Date.now() - 60_000 })}`,
    `https://hub.example/pair?x=1#offer=${encodePairOffer(OFFER)}`,
    `https://hub.example/pair?code=${UUID_CODE}&v=1#offer=${encodePairOffer(OFFER)}`,
  ]) {
    const value = readPairHandoff(new URL(link));
    assert.ok(value && "error" in value, link.slice(0, 60));
    const payload = link.split("#offer=")[1] ?? "";
    if (payload) assert.equal(JSON.stringify(value).includes(payload), false, link.slice(0, 60));
  }
  // the v1 path is untouched: no offer fragment, same rules as before
  assert.deepEqual(readPairHandoff(new URL(`https://hub.example/pair?code=${UUID_CODE}&v=1`)), {
    code: UUID_CODE,
    origin: "https://hub.example",
  });
});

// --- gap #4: the no-admin "Pair THIS machine" relay card ---

test("gap #4: DeviceHandoff renders the local relay card from the offer fragment (vite SSR)", async () => {
  const { createServer } = await import("vite");
  const { createSSRApp, h } = await import("vue");
  const { renderToString } = await import("vue/server-renderer");
  const FE_ROOT = new URL("../apps/dpi-playground-fe/", import.meta.url);
  const vite = await createServer({
    configFile: new URL("vite.config.ts", FE_ROOT).pathname,
    server: { middlewareMode: true, hmr: false, watch: null },
    appType: "custom",
    logLevel: "error",
  });
  try {
    const mod = await vite.ssrLoadModule("src/components/DeviceHandoff.vue");
    const fragment = `offer=${offerLink().split("#offer=")[1]}`;
    const html = await renderToString(
      createSSRApp({ render: () => h(mod.default, { offerFragment: fragment }) }),
    );
    assert.match(html, /Pair THIS machine/);
    assert.match(html, /127\.0\.0\.1/, "the relay target is the machine's own backend");
    assert.ok(!html.includes("https://hub.example"), "the hub origin never leaks into the card");
    assert.match(html, /Open the device page/);
    assert.match(html, /Copy link/);
  } finally {
    await vite.close();
  }
});
