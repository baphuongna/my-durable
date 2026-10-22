import test from "node:test";
import assert from "node:assert/strict";
import {
  barePairHome,
  readPairHandoff,
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
  for (const raw of ["ABCD2345EF678", "ABCD2345EF", "ABCD2345EF6", "AB2C7DE0", "ABCD-2345", "ABCD2345EF67-AB"]) {
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
  const upper = (readPairHandoff(new URL(`https://hub.example/pair?code=${UUID_CODE.toUpperCase()}&v=1`)));
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
