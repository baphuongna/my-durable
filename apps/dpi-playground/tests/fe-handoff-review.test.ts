import test from "node:test";
import assert from "node:assert/strict";
import { barePairHome, readPairHandoff } from "../apps/dpi-playground-fe/src/client/pair-handoff.js";

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
  assert.deepEqual(readPairHandoff(new URL("https://hub.example/pair?code=ABCD2345&v=1")), { code: "ABCD2345", origin: "https://hub.example" });
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
