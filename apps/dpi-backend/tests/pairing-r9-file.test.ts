/**
 * R9 (audit 1.1): a corrupt pairing.json is QUARANTINED and surfaced as
 * `file-error` — never a silent "unpaired" that orphans a live hub credential.
 * Bytes survive as pairing.json.corrupt-<ts>, the warning names the path, and
 * a re-issued credential keeps the previous good file as pairing.json.bak.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { generateKeyPairSync, randomUUID } from "node:crypto";
import { existsSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DevicePairing } from "../src/pairing.js";
import { pairingPath } from "../src/pairing-files.js";
import { until } from "./helpers.js";

const UID = "0f1e2d3c-4b5a-6978-8796-a5b4c3d2e1f0";
const HUB_ID = "1a2b3c4d-5e6f-4a5b-8c9d-0e1f2a3b4c5d";
const NOW = 1760000000000;

/** Minimal scripted hub (same contract as pairing.test.ts's fakeHub, trimmed to this file's flows). */
function fakeHub(script: { verifyStatus: number[]; verifyBodies: unknown[] }) {
  let verifyIndex = 0;
  let challenge: { enrollmentId: string; issuedAt: number } | undefined;
  const fetchImpl: typeof fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input);
    if (url.endsWith("/api/pair/start")) {
      challenge = { enrollmentId: randomUUID(), issuedAt: NOW };
      return new Response(
        JSON.stringify({
          type: "pair.challenge",
          v: 1,
          enrollmentId: challenge.enrollmentId,
          nonce: "N".repeat(43),
          issuedAt: NOW,
          hubId: HUB_ID,
        }),
        { status: 200, headers: { "content-type": "application/json" } },
      );
    }
    if (url.endsWith("/api/pair/verify")) {
      const status = script.verifyStatus[Math.min(verifyIndex, script.verifyStatus.length - 1)];
      let body = script.verifyBodies[Math.min(verifyIndex, script.verifyBodies.length - 1)];
      if ((body as { type?: string }).type === "pair.token")
        body = { ...(body as object), ...challenge };
      verifyIndex += 1;
      return new Response(JSON.stringify(body), {
        status,
        headers: { "content-type": "application/json" },
      });
    }
    return new Response(JSON.stringify({ error: { code: "not_found", message: "?" } }), {
      status: 404,
    });
  }) as unknown as typeof fetch;
  return { fetchImpl };
}

const newPairing = (home: string, hub: ReturnType<typeof fakeHub>) =>
  new DevicePairing({ uid: UID } as never, home, "dev", undefined, {
    fetchImpl: hub.fetchImpl,
    pollMs: 10,
    now: () => NOW,
  });

const pending = (enrollmentId: string) => ({
  type: "pair.pending",
  v: 1,
  enrollmentId,
  state: "awaiting_approval",
  expiresAt: NOW + 300_000,
  pollAfterMs: 1,
});
const token = (over: { pairingEpoch: string; credentialId: string; mark: string }) => ({
  type: "pair.token",
  v: 1,
  enrollmentId: "e1",
  deviceUid: UID,
  deviceId: "dev-9",
  pairingEpoch: over.pairingEpoch,
  credentialId: over.credentialId,
  generation: 1,
  hubId: HUB_ID,
  hubOrigin: "https://h.example.com",
  hubUrl: "https://h.example.com/api/tunnel",
  tunnelToken: `dpt_${over.mark.repeat(43)}`,
  issuedAt: NOW,
  expiresAt: null,
});

test("R9 1.1: corrupt pairing.json → quarantined aside, file-error surfaced, loud warning, bytes preserved", async () => {
  const home = await mkdtemp(join(tmpdir(), "dpi-r9-corrupt-"));
  const hub = fakeHub({ verifyStatus: [], verifyBodies: [] });
  newPairing(home, hub); // first boot writes the keypair only
  const warned: string[] = [];
  const originalWarn = console.warn;
  console.warn = (...args: unknown[]) => warned.push(args.map(String).join(" "));
  try {
    writeFileSync(pairingPath(home), "{ not json", { mode: 0o600 });
    const dp = newPairing(home, hub);
    const s = dp.status();
    assert.equal(s.state, "file-error", "corrupt file must not read as unpaired");
    assert.match(s.lastError ?? "", /pairing\.json\.corrupt-/, "lastError names the quarantine path");
    const aside = readdirSync(home).find((f) => f.startsWith("pairing.json.corrupt-"));
    assert.ok(aside, "corrupt file was moved aside");
    assert.equal(readFileSync(join(home, aside!), "utf8"), "{ not json", "bytes preserved for recovery");
    assert.ok(!existsSync(pairingPath(home)), "pairing.json itself was renamed away, not deleted");
    assert.ok(
      warned.some((w) => w.includes("corrupt-") && /orphan|quarantin/i.test(w)),
      "a loud warning names the quarantine and the orphan risk",
    );
  } finally {
    console.warn = originalWarn;
    await rm(home, { recursive: true, force: true });
  }
});

test("R9 1.1: fresh home stays unpaired with no quarantine artifacts; a valid file still loads as paired", async () => {
  const home = await mkdtemp(join(tmpdir(), "dpi-r9-fresh-"));
  const hub = fakeHub({ verifyStatus: [], verifyBodies: [] });
  try {
    const dp = newPairing(home, hub);
    assert.equal(dp.status().state, "unpaired");
    assert.equal(readdirSync(home).filter((f) => f.startsWith("pairing.json")).length, 0);
    // A healthy file keeps loading exactly as before.
    writeFileSync(
      pairingPath(home),
      JSON.stringify({
        version: 1,
        deviceUid: UID,
        deviceId: "dev-9",
        pairingEpoch: "ep-1",
        credentialId: "c-1",
        generation: 1,
        hubOrigin: "https://h.example.com",
        hubUrl: "https://h.example.com/api/tunnel",
        hubId: HUB_ID,
        tunnelToken: `dpt_${"K".repeat(43)}`,
        updatedAt: NOW,
        operationId: "op-1",
      }),
      { mode: 0o600 },
    );
    const dp2 = newPairing(home, hub);
    const s = dp2.status();
    assert.equal(s.state, "paired");
    assert.equal(s.hubOrigin, "https://h.example.com");
    assert.equal(s.lastError, undefined);
  } finally {
    await rm(home, { recursive: true, force: true });
  }
});

test("R9 1.1: re-pairing keeps the previous good pairing.json as .bak (torn-restore recovery source)", async () => {
  const home = await mkdtemp(join(tmpdir(), "dpi-r9-bak-"));
  const first = token({ pairingEpoch: "ep-1", credentialId: "c-1", mark: "1" });
  const second = token({ pairingEpoch: "ep-2", credentialId: "c-2", mark: "2" });
  const hub = fakeHub({
    verifyStatus: [202, 200, 202, 200],
    verifyBodies: [pending("e1"), first, pending("e1"), second],
  });
  const dp = newPairing(home, hub);
  try {
    await dp.start({ code: "AB2C7DEF", hub: "https://h.example.com" });
    await until(() => dp.status().state === "paired", 5000, "first pairing");
    const firstBytes = readFileSync(pairingPath(home), "utf8");
    assert.equal(JSON.parse(firstBytes).pairingEpoch, "ep-1");
    // Same hub, no force needed: a re-pair replaces the credential in place.
    await dp.start({ code: "AB2C7DEF", hub: "https://h.example.com" });
    await until(() => dp.status().pairingEpoch === "ep-2", 5000, "second pairing");
    const secondBytes = readFileSync(pairingPath(home), "utf8");
    assert.equal(JSON.parse(secondBytes).pairingEpoch, "ep-2");
    const bak = `${pairingPath(home)}.bak`;
    assert.ok(existsSync(bak), "previous good file kept as .bak");
    assert.equal(readFileSync(bak, "utf8"), firstBytes, ".bak holds the last-good credential verbatim");
  } finally {
    await rm(home, { recursive: true, force: true });
  }
});
