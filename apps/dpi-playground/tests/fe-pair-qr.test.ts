/**
 * Gap #3 (pairing-ceremony comparison 2026-10-22): the wizard QR must encode
 * the v2 offer link — the whole handoff rides the #offer= fragment — and NEVER
 * the v1 pairUrl, whose ?code= query drops the pairing code into every server,
 * CDN and proxy log it passes. Copy-link already rides the fragment; this pins
 * the QR to the same contract.
 */
import test from "node:test";
import assert from "node:assert/strict";
import { bootHub } from "./harness/hub.js";
import { qrPayload } from "../apps/dpi-playground-fe/src/client/pair.js";
import { parsePairOfferUrl } from "../../dpi-sdk/src/protocol/pairing.js";
import type { PairCodeIssue } from "../../dpi-sdk/src/api.js";

const UUID = "0d87c6c0-a46d-4d9b-a3fe-b2f0a5669c62";

/** A v2 issue (both links): the QR MUST choose the offer link, not the pairUrl. */
const v2Issue = {
  type: "pair.code",
  v: 1,
  codeId: UUID,
  code: UUID,
  expiresAt: Date.now() + 300_000,
  hubOrigin: "https://hub.example.test",
  pairUrl: `https://hub.example.test/pair?code=${UUID}&v=1`,
  offerUrl: `https://hub.example.test/pair#offer=${"A".repeat(64)}`,
} as PairCodeIssue;

/** A legacy hub answer with no offerUrl: the v1 pairUrl stays the only option. */
const v1Issue = {
  type: "pair.code",
  v: 1,
  codeId: UUID,
  code: UUID,
  expiresAt: Date.now() + 300_000,
  hubOrigin: "https://hub.example.test",
  pairUrl: `https://hub.example.test/pair?code=${UUID}&v=1`,
} as PairCodeIssue;

test("QR payload: #offer= fragment when the hub minted an offer link; never a ?code= query", () => {
  const payload = qrPayload(v2Issue);
  assert.equal(payload, v2Issue.offerUrl, "the offer link wins over the pairUrl");
  assert.ok(payload.includes("#offer="), "the handoff rides the #offer= fragment");
  assert.ok(!payload.includes("code="), "no ?code= query — the code never rides a URL servers see");
  assert.ok(!payload.includes("?"), "no query at all: fragment-only");
});

test("QR payload: a legacy v1 issue (no offerUrl) still falls back to the pairUrl", () => {
  assert.equal(qrPayload(v1Issue), v1Issue.pairUrl, "old hubs keep a scannable QR");
  // The fallback is the ONLY path where a query may appear.
  assert.ok(qrPayload(v1Issue).includes("code="));
});

test("real hub mint: the QR payload is a self-contained, decodable offer carrying the code", async () => {
  const hub = await bootHub();
  try {
    const r = await fetch(`${hub.base}/api/pair/code`, {
      method: "POST",
      headers: { "content-type": "application/json", ...hub.adminHeaders },
      body: "{}",
    });
    assert.equal(r.status, 201);
    const created = (await r.json()) as PairCodeIssue;
    assert.ok(created.offerUrl, "the hub mints the v2 offer link");

    const payload = qrPayload(created);
    assert.match(payload, /#offer=/);
    assert.ok(!payload.includes("code="), "the QR never carries a ?code= query");

    // Scanning the QR yields the SAME handoff the fragment link carries.
    const parsed = parsePairOfferUrl(payload);
    assert.ok(parsed, "the QR payload parses as an offer link");
    assert.equal(parsed!.offer.code, created.code);
    assert.equal(parsed!.offer.hub, created.hubOrigin);
    assert.equal(parsed!.rest, `${created.hubOrigin}/pair`);
  } finally {
    await hub.cleanup();
  }
});
