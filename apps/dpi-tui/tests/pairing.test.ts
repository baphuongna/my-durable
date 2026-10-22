/**
 * P2-26 — TUI pairing controller smoke tests: argument parsing, fingerprint
 * wrapping at 40/80/200 columns (never truncated), actionable error mapping,
 * and the panel view (no token ever rendered; hub origin shown).
 */
import test from "node:test";
import assert from "node:assert/strict";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { parsePairArgs, wrapFingerprint, describePairingError, pairingViewLines, runPairing, type PairingStatusDTO } from "../src/pairing.ts";

const FP = `sha256:${"a".repeat(64)}`;

test("parsePairArgs: code, pair URL, --hub, --force, mixed order", () => {
  assert.deepEqual(parsePairArgs("AB12CD34 --hub https://hub.example.com --force"), {
    code: "AB12CD34",
    hub: "https://hub.example.com",
    force: true,
  });
  assert.deepEqual(parsePairArgs("https://hub.example.com/pair?code=AB12CD34"), {
    pairUrl: "https://hub.example.com/pair?code=AB12CD34",
  });
  assert.deepEqual(parsePairArgs("--force --hub=h https://x/pair?c=1"), {
    force: true,
    hub: "h",
    pairUrl: "https://x/pair?c=1",
  });
  assert.deepEqual(parsePairArgs(""), {});
});

test("wrapFingerprint: full fingerprint wraps, never truncates, at 40/80/200", () => {
  for (const width of [40, 80, 200]) {
    const lines = wrapFingerprint(FP, width);
    assert.equal(lines.join(""), FP, `width ${width} keeps every character`);
    for (const line of lines) assert.ok(line.length <= Math.max(8, width - 4), `width ${width} line fits`);
  }
});

test("describePairingError: every known code is actionable", () => {
  const cases: Array<[string, RegExp]> = [
    ["clock_skew", /clock/i],
    ["enrollment_lost", /fresh code/i],
    ["paired_elsewhere", /another hub|--force/i],
    ["hub_mismatch", /another hub|--force/i],
    ["revoked", /revoked/i],
    ["hub_required", /--hub/i],
    ["busy", /already in progress/i],
    ["code_invalid", /does not know this code/i],
    ["code_expired", /expired/i],
    ["unauthorized", /DPI_TOKEN/i],
  ];
  for (const [code, re] of cases)
    assert.match(describePairingError(Object.assign(new Error(code), { code })), re, code);
  assert.equal(describePairingError(new Error("boom")), "boom");
});

test("pairingViewLines: awaiting approval shows origin + full fp, never a token", () => {
  const status: PairingStatusDTO = {
    state: "pairing",
    deviceUid: "uid-1",
    deviceName: "mac-mini",
    fingerprint: FP,
    pending: { hubOrigin: "https://hub.example.com", startedAt: 1, note: "polling for approval" },
  };
  for (const width of [40, 80, 200]) {
    const lines = pairingViewLines(status, "", width, "https://hub.example.com");
    const text = lines.join("\n");
    assert.match(text, /hub: https:\/\/hub\.example\.com/);
    assert.match(text, /Awaiting approval/);
    // The full fingerprint (joined) is present — no width truncation.
    const plain = (l: string) => l.replace(/\x1b\[[0-9;]*m/g, "");
    // Everything between the fingerprint header and the next blank line.
    const start = lines.findIndex((l) => plain(l).includes("key fingerprint"));
    const fpLines: string[] = [];
    for (let k = start + 1; k < lines.length && plain(lines[k]).trim(); k++) fpLines.push(lines[k]);
    assert.equal(
      fpLines.map(plain).join("").replace(/\s+/g, "").includes(FP.replace("sha256:", "")),
      true,
      `fp intact at ${width}`,
    );
    assert.ok(!text.includes("dpt_"), "no tunnel token in view");
    assert.ok(!text.includes("dpi_"), "no device token in view");
  }
  const paired = pairingViewLines({ ...status, pending: undefined, state: "paired", hubOrigin: "https://hub.example.com", generation: 2 }, "", 80);
  assert.match(paired.join("\n"), /generation 2/);
});

test("pairingViewLines: pending re-pair takes priority over incumbent paired state", () => {
  const lines = pairingViewLines({
    state: "paired", fingerprint: FP, hubOrigin: "https://old.example.com", generation: 2,
    pending: { hubOrigin: "https://new.example.com", startedAt: 1, note: "polling for approval" },
  }, "", 80, "https://new.example.com").join("\n");
  assert.match(lines, /Awaiting approval/);
  assert.doesNotMatch(lines, /Paired to/);
});

test("pairingViewLines: terminal re-pair error stays actionable beside unchanged incumbent credentials", () => {
  const status = Object.assign({
    state: "paired" as const, fingerprint: FP, hubOrigin: "https://old.example.com", generation: 2,
  }, { lastError: "enrollment_lost: The enrollment disappeared" });
  const lines = pairingViewLines(status, "", 80).join("\n");
  assert.match(lines, /fresh code/i);
  assert.match(lines, /Existing pairing.*unchanged/);
  assert.doesNotMatch(lines, /Paired to/);
});

// -- closing the pairing panel ----------------------------------------------------

const TOKEN = `dpi_${"T".repeat(43)}`;

/** Just enough App for runPairing: records flashes and hands the test the panel's close handler. */
function fakeApp() {
  const flashes: { text: string; error: boolean }[] = [];
  let close: (() => void) | undefined;
  const app = {
    flash: (text: string, error = false) => flashes.push({ text, error }),
    overlay: (_panel: unknown, onClose: () => void) => (close = onClose),
    closeOverlay: () => {},
    tui: { invalidate: () => {}, requestRender: () => {} },
  };
  return { app: app as never, flashes, close: () => close?.() };
}

async function localBackend(handler: (req: IncomingMessage, res: ServerResponse, calls: string[]) => void) {
  const calls: string[] = [];
  const server = createServer((req, res) => {
    calls.push(`${req.method} ${req.url}`);
    res.setHeader("content-type", "application/json");
    handler(req, res, calls);
  });
  await new Promise<void>((done) => server.listen(0, "127.0.0.1", done));
  process.env.DPI_TOKEN = TOKEN;
  process.env.DPI_PORT = String((server.address() as { port: number }).port);
  return {
    calls,
    stop: async () => {
      server.closeAllConnections();
      await new Promise<void>((done) => server.close(() => done()));
    },
  };
}

const settle = () => new Promise((r) => setTimeout(r, 120));
const json = (res: ServerResponse, status: number, body: unknown) => res.writeHead(status).end(JSON.stringify(body));

test("closing the panel after the backend refused to start adds nothing to the refusal already shown", async () => {
  const be = await localBackend((_req, res) => json(res, 409, { error: { code: "busy", message: "A pairing operation is already running" } }));
  try {
    const t = fakeApp();
    await runPairing(t.app, { code: "ABCD2345", hub: "https://hub.example.com" });
    assert.equal(t.flashes.length, 1);
    assert.match(t.flashes[0]!.text, /already in progress/);
    assert.equal(t.flashes[0]!.error, true);
    t.close();
    await settle();
    assert.equal(t.flashes.length, 1, "no cancel claim, no success-looking note for an operation that never started");
    assert.ok(!be.calls.some((c) => c.includes("/cancel")), "nothing to cancel was asked for");
  } finally {
    await be.stop();
  }
});

test("closing the panel after a pairing that ended in failure reports the failure as an error", async () => {
  const be = await localBackend((_req, res) =>
    json(res, 200, { state: "unpaired", fingerprint: FP, lastError: "enrollment_lost: Hub enrollment disappeared" }));
  try {
    const t = fakeApp();
    await runPairing(t.app, { code: "ABCD2345", hub: "https://hub.example.com" });
    t.close();
    await settle();
    const last = t.flashes.at(-1)!;
    assert.equal(last.error, true);
    assert.match(last.text, /did not complete/);
    assert.match(last.text, /fresh code/i);
    assert.match(last.text, /No active local operation to cancel/);
    assert.match(last.text, /nothing was paired/);
  } finally {
    await be.stop();
  }
});

test("closing the panel after a failed re-pair says the incumbent credentials are unchanged, as an error", async () => {
  const be = await localBackend((_req, res) =>
    json(res, 200, { state: "paired", fingerprint: FP, hubOrigin: "https://old.example.com", generation: 2, lastError: "code_expired: gone" }));
  try {
    const t = fakeApp();
    await runPairing(t.app, { code: "ABCD2345", hub: "https://hub.example.com" });
    t.close();
    await settle();
    const last = t.flashes.at(-1)!;
    assert.equal(last.error, true);
    assert.match(last.text, /expired/i);
    assert.match(last.text, /No active local operation to cancel; existing credentials are unchanged/);
  } finally {
    await be.stop();
  }
});

test("closing the panel after a completed pairing names the hub and does not claim credentials are unchanged", async () => {
  const be = await localBackend((_req, res) =>
    json(res, 200, { state: "paired", fingerprint: FP, hubOrigin: "https://hub.example.com", generation: 1 }));
  try {
    const t = fakeApp();
    await runPairing(t.app, { code: "ABCD2345", hub: "https://hub.example.com" });
    t.close();
    await settle();
    const last = t.flashes.at(-1)!;
    assert.equal(last.error, false);
    assert.match(last.text, /Paired to https:\/\/hub\.example\.com/);
    assert.doesNotMatch(last.text, /unchanged/);
  } finally {
    await be.stop();
  }
});

test("closing the panel while the backend cannot be reached still says the cancel was not confirmed", async () => {
  const be = await localBackend((req) => req.destroy());
  try {
    const t = fakeApp();
    await runPairing(t.app, { code: "ABCD2345", hub: "https://hub.example.com" });
    t.close();
    await settle();
    assert.match(t.flashes.at(-1)!.text, /cancel was not confirmed/);
    assert.equal(t.flashes.at(-1)!.error, true);
  } finally {
    await be.stop();
  }
});

test("closing the panel during an active pairing cancels it locally and says only that", async () => {
  let pending = true;
  const be = await localBackend((req, res) => {
    if (req.url === "/v1/pairing/cancel") pending = false;
    json(res, 200, { state: pending ? "pairing" : "unpaired", fingerprint: FP, ...(pending ? { pending: { hubOrigin: "https://hub.example.com", startedAt: 1 } } : {}) });
  });
  try {
    const t = fakeApp();
    const running = runPairing(t.app, { code: "ABCD2345", hub: "https://hub.example.com" });
    await settle();
    t.close();
    await settle();
    assert.ok(be.calls.includes("POST /v1/pairing/cancel"));
    assert.match(t.flashes.at(-1)!.text, /local operation was cancelled/);
    await running;
  } finally {
    await be.stop();
  }
});
