// Focused real-browser pairing regressions. Run after npm run build:
// node --import tsx tests/pairing-ui.mjs
import assert from "node:assert/strict";
import { cp, mkdtemp, mkdir, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { createHash, generateKeyPairSync, randomUUID, sign } from "node:crypto";
import { chromium, expect } from "@playwright/test";
import { WebSocket } from "ws";
import { bootHub } from "./harness/hub.ts";
import { freePort } from "./harness/caddy.ts";
import { pairingSigningPayload } from "../../dpi-sdk/src/protocol/pairing.ts";

const root = await mkdtemp(join(tmpdir(), "dpi-pair-ui-"));
const port = await freePort();
const base = `http://127.0.0.1:${port}`;
// Evidence lives under the run's temp dir; it is copied into the repo only when the run fails.
const evidence = join(root, "evidence");
const config = join(root, "network.yaml");
await writeFile(config, "devices: {}\n");
process.env.DPI_NETWORK_FILE = config;
process.env.DPI_HUB_ORIGIN = base;
let hub;
let browser;
let page;
const post = async (path, body) => {
  const response = await fetch(`${base}${path}`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
  assert.ok(response.ok, `${path} returned ${response.status}`);
  return response.json();
};

// S-7: nothing a browser can read may hold a credential. Exact values issued during this run are
// checked by value; the shapes catch anything that merely looks like a token, a token hash or a key.
const issuedSecrets = new Set();
const mintedCodes = new Set();
const SECRET_SHAPES = [
  [/\bdp[ti]_[A-Za-z0-9_-]{16,}/, "device/tunnel token"],
  [/-----BEGIN [A-Z ]*PRIVATE KEY-----/, "private key PEM"],
  [
    /(?<![0-9a-fA-F:])[0-9a-f]{64}(?![0-9a-fA-F])/,
    "bare 64-hex digest (a token hash would look like this)",
  ],
];
const leaksIn = (text, { codes = false } = {}) => {
  const found = [];
  for (const secret of issuedSecrets)
    if (text.includes(secret)) found.push(`issued secret ${secret.slice(0, 6)}…`);
  if (codes)
    for (const code of mintedCodes) if (text.includes(code)) found.push(`pairing code ${code}`);
  for (const [shape, what] of SECRET_SHAPES) if (shape.test(text)) found.push(what);
  return found;
};
/** Everything page script can read: DOM, URL/history, cookies, web storage, IndexedDB, caches, workers. */
const browserSurface = (page) =>
  page.evaluate(async () => {
    const dump = (store) =>
      Object.fromEntries(Object.keys(store).map((key) => [key, store.getItem(key)]));
    return JSON.stringify({
      html: document.documentElement.outerHTML,
      url: location.href,
      referrer: document.referrer,
      historyState: history.state,
      title: document.title,
      cookie: document.cookie,
      local: dump(localStorage),
      session: dump(sessionStorage),
      indexedDB: (await indexedDB.databases?.()) ?? [],
      caches: (await globalThis.caches?.keys?.()) ?? [],
      serviceWorkers: (await navigator.serviceWorker?.getRegistrations?.())?.length ?? 0,
    });
  });
async function issueDevice(code) {
  const kp = generateKeyPairSync("ed25519");
  issuedSecrets.add(kp.privateKey.export({ type: "pkcs8", format: "pem" }));
  const uid = randomUUID();
  const fingerprint = `sha256:${createHash("sha256")
    .update(kp.publicKey.export({ type: "spki", format: "der" }))
    .digest("hex")}`;
  const challenge = await post("/api/pair/start", {
    type: "pair.request",
    v: 1,
    requestId: randomUUID(),
    code: code.code,
    deviceUid: uid,
    deviceName: "Browser race fixture",
    publicKey: kp.publicKey.export({ type: "spki", format: "pem" }),
    keyFingerprint: fingerprint,
    clientTime: Date.now(),
  });
  const payload = pairingSigningPayload({
    hubOrigin: code.hubOrigin,
    hubId: challenge.hubId,
    enrollmentId: challenge.enrollmentId,
    nonce: challenge.nonce,
    issuedAt: challenge.issuedAt,
    deviceUid: uid,
    keyFingerprint: fingerprint,
  });
  const proof = {
    type: "pair.response",
    v: 1,
    enrollmentId: challenge.enrollmentId,
    nonce: challenge.nonce,
    signature: sign(null, Buffer.from(payload), kp.privateKey).toString("base64url"),
  };
  await post("/api/pair/verify", proof);
  await post(`/api/pair/codes/${code.codeId}/approve`, {
    enrollmentId: challenge.enrollmentId,
    deviceUid: uid,
    keyFingerprint: fingerprint,
  });
  const issued = await post("/api/pair/verify", proof);
  issuedSecrets.add(issued.tunnelToken);
  issuedSecrets.add(createHash("sha256").update(issued.tunnelToken, "utf8").digest("hex"));
  // The fingerprint is not part of TokenIssue, but the device-side tunnel handshake below must
  // present exactly the pairing's key fingerprint — attach it to the script's copy of the ticket.
  return { ...issued, keyFingerprint: fingerprint };
}
try {
  hub = await bootHub({ port });
  browser = await chromium.launch({ channel: "chrome", headless: !process.env.HEADED });
  page = await browser.newPage({ viewport: { width: 1200, height: 900 } });
  // CSP check: the hub serves the shell with style-src 'self' (no 'unsafe-inline'), so inline style
  // attributes anywhere in the shipped UI are silently dropped and reported here as violations.
  await page.addInitScript(() => {
    window.__cspViolations = [];
    document.addEventListener("securitypolicyviolation", (event) => {
      window.__cspViolations.push({
        directive: event.violatedDirective,
        blockedURI: event.blockedURI,
        sample: event.sample,
      });
    });
  });
  // Admin stream scan: wrap the app's own EventSource('/api/stream') page-side so every event
  // payload of the run is recorded (sessionStorage keeps the log across the handoff navigation)
  // and leak-scanned with everything else at the end — no token or key may ever ride the browser
  // event stream (the unit-level pin is hub.test.ts R03).
  await page.addInitScript(() => {
    const KEY = "__sseEvents";
    const record = (data) => {
      try {
        const all = JSON.parse(sessionStorage.getItem(KEY) ?? "[]");
        all.push(data);
        sessionStorage.setItem(KEY, JSON.stringify(all));
      } catch {}
    };
    const Native = window.EventSource;
    window.EventSource = class extends Native {
      constructor(...args) {
        super(...args);
        try {
          if (new URL(args[0], location.href).pathname !== "/api/stream") return;
        } catch {
          return;
        }
        this.addEventListener("message", (event) => record(event.data));
      }
    };
  });
  const cspConsole = [];
  page.on("console", (message) => {
    if (/Content Security Policy/i.test(message.text())) cspConsole.push(message.text());
  });
  const errors = [];
  page.on("pageerror", (e) => errors.push(e.message));
  // Everything the page received, sent or logged during the run. SSE response bodies are not
  // readable from here, so the page-side collector above records every admin stream event for the
  // final scan; an HTTP body that could not be read is recorded in lostBodies and fails the run.
  const received = [];
  const lostBodies = [];
  const sent = [];
  const logged = [];
  page.on("response", (response) => {
    // 3xx — redirects and 304 revalidations — carry no body by spec: nothing to lose
    if (response.status() >= 300 && response.status() < 400) return;
    if (
      !response.url().startsWith(base) ||
      (response.headers()["content-type"] ?? "").includes("event-stream")
    )
      return;
    received.push(
      response.text().then(
        (text) => ({ url: response.url(), text }),
        (error) => {
          lostBodies.push({ url: response.url(), error: String(error) });
          return null;
        },
      ),
    );
  });
  page.on("request", (request) =>
    sent.push({
      url: request.url(),
      body: request.postData() ?? "",
      headers: JSON.stringify(request.headers()),
    }),
  );
  page.on("console", (message) => logged.push(message.text()));
  await page.goto(base);
  const minted = page.waitForResponse(
    (r) => new URL(r.url()).pathname === "/api/pair/code" && r.request().method() === "POST",
  );
  await page.getByRole("button", { name: "Pair a device", exact: true }).click();
  const issue = await (await minted).json();
  mintedCodes.add(issue.code);
  await expect(page.getByLabel("Pairing code", { exact: true })).toBeVisible();
  assert.deepEqual(leaksIn(await browserSurface(page)), [], "S-7: wizard open with a live code");
  await page.keyboard.press("Escape");
  await expect(page.getByRole("dialog")).toHaveCount(0);
  const state = await (await fetch(`${base}/api/pair/codes/${issue.codeId}`)).json();
  assert.equal(
    state.phase,
    "cancelled",
    "R05: Escape cancels the live hub code, not just the dialog",
  );
  console.log("PASS R05 Escape cancels pairing on the real hub");
  // R08: a bare /pair URL (reload of a scrubbed link, or a typed one) goes home —
  // the wizard must NOT re-open and mint a fresh code
  {
    const before = sent.length;
    await page.goto(`${base}/pair`);
    await expect(page).toHaveURL(`${base}/`);
    await expect(page.getByRole("dialog")).toHaveCount(0);
    const mintedOnBare = sent
      .slice(before)
      .filter((r) => new URL(r.url).pathname === "/api/pair/code");
    assert.equal(mintedOnBare.length, 0, "R08: bare /pair must not mint a pairing code");
    console.log("PASS R08 bare /pair lands home without minting a code");
  }
  let releaseCreate;
  const delayed = new Promise((resolve) => {
    releaseCreate = resolve;
  });
  let lateIssue;
  await page.route("**/api/pair/code", async (route) => {
    const response = await route.fetch();
    lateIssue = await response.json();
    await delayed;
    await route.fulfill({ response });
  });
  await page.getByRole("button", { name: "Pair a device", exact: true }).click();
  await expect(page.getByText("Minting a pairing code…")).toBeVisible();
  await expect.poll(() => !!lateIssue).toBe(true);
  mintedCodes.add(lateIssue.code);
  await page.keyboard.press("Escape");
  await expect(page.getByRole("dialog")).toHaveCount(0);
  releaseCreate();
  await expect
    .poll(
      async () => (await (await fetch(`${base}/api/pair/codes/${lateIssue.codeId}`)).json()).phase,
    )
    .toBe("cancelled");
  await page.unroute("**/api/pair/code");
  console.log("PASS R05 closing before code creation returns cancels the late code");
  const raceMinted = page.waitForResponse((r) => new URL(r.url()).pathname === "/api/pair/code");
  await page.getByRole("button", { name: "Pair a device", exact: true }).click();
  const raceCode = await (await raceMinted).json();
  mintedCodes.add(raceCode.code);
  await expect(page.getByLabel("Pairing code", { exact: true })).toBeVisible();
  const openState = await (await fetch(`${base}/api/pair/codes/${raceCode.codeId}`)).json();
  let unlockStatus = false;
  // Collect, never assert, inside a route handler: an assert there can be swallowed by Playwright.
  const cancelStatuses = [];
  await page.route(`**/api/pair/codes/${raceCode.codeId}`, (route) =>
    unlockStatus ? route.continue() : route.fulfill({ json: openState }),
  );
  await page.route(`**/api/pair/codes/${raceCode.codeId}/cancel`, async (route) => {
    const response = await route.fetch();
    cancelStatuses.push(response.status());
    unlockStatus = true;
    await route.fulfill({ response });
  });
  const ticket = await issueDevice(raceCode);
  await page.keyboard.press("Escape");
  await expect(page.getByRole("dialog")).toHaveCount(1);
  await expect(page.getByRole("alert")).toContainText(/already issued/i);
  await expect(
    page.getByRole("button", { name: "Revoke this credential", exact: true }),
  ).toBeVisible();
  assert.deepEqual(
    cancelStatuses,
    [409],
    "the hub refused the late cancel with 409 (checked after the flow, outside the route handler)",
  );
  assert.equal(
    issuedSecrets.has(ticket.tunnelToken),
    true,
    "the scan knows the token that was just issued",
  );
  assert.deepEqual(
    leaksIn(await browserSurface(page)),
    [],
    "S-7: wizard showing an issued credential",
  );
  const network = await (await fetch(`${base}/api/network`)).json();
  assert.equal(
    network.devices.find((d) => d.id === ticket.deviceId)?.pairing?.status,
    "paired",
    "dismissal never automatically revokes",
  );
  await page.getByRole("button", { name: "Close dialog", exact: true }).click();
  await expect(page.getByRole("dialog")).toHaveCount(0);
  console.log(
    "PASS R05 issuance racing cancellation offers explicit Revoke without revoking automatically",
  );
  const handoff = await post("/api/pair/code", {});
  mintedCodes.add(handoff.code);
  let extraCodes = 0;
  let leakedReferrer = false;
  page.on("request", (request) => {
    if (new URL(request.url()).pathname === "/api/pair/code" && request.method() === "POST")
      extraCodes++;
    if (request.headers().referer?.includes("code=")) leakedReferrer = true;
  });
  await page.goto(`${base}/pair?code=${handoff.code}&v=1&origin=${encodeURIComponent(base)}`);
  await expect(page.getByRole("dialog", { name: "Pair a device", exact: true })).toBeVisible();
  await expect.poll(() => page.evaluate(() => location.search)).toBe("");
  await expect
    .poll(() => page.evaluate(() => location.pathname))
    .toBe("/", "R08: the scrubbed handoff URL is replaced by the app root");
  await expect
    .poll(
      async () =>
        (await page.getByLabel("Pairing code", { exact: true }).textContent())
          .replace("-", "")
          .trim() === handoff.code,
    )
    .toBe(true);
  assert.equal(
    extraCodes,
    0,
    "R08: handoff reuses the existing code instead of minting a replacement",
  );
  assert.equal(leakedReferrer, false, "pairing query is not sent as a resource referrer");
  assert.equal(
    await page.evaluate(
      (code) => JSON.stringify([localStorage, sessionStorage]).includes(code),
      handoff.code,
    ),
    false,
  );
  await page.keyboard.press("Escape");
  await expect(page.getByRole("dialog")).toHaveCount(0);
  assert.equal(
    (await (await fetch(`${base}/api/pair/codes/${handoff.codeId}`)).json()).phase,
    "cancelled",
  );
  console.log(
    "PASS R08 direct handoff reuses and scrubs the code without approval, persistence or referrer leaks",
  );
  const deviceRow = page.locator(`.tree-row[data-key="${ticket.deviceId}"]`);
  await expect(deviceRow).toBeVisible();
  await deviceRow.hover();
  await deviceRow.getByRole("button", { name: /Manage credentials/ }).click();
  const manager = page.getByRole("region", { name: "Credential manager", exact: true });
  await expect(manager).toBeVisible();
  await expect(page.getByRole("dialog", { name: "Device credentials", exact: true })).toContainText(
    /offline/,
  );
  await expect(manager.locator(".credential-fingerprint")).toHaveText(
    network.devices.find((d) => d.id === ticket.deviceId).pairing.keyFingerprint,
  );
  // Offline rotate first: the UI's button is the admin route POST /api/devices/:id/rotate (its
  // /api/pairings/:id/rotate alias) — capture the real reply to pin the requested-mode 202.
  const rotatePath = `/api/pairings/${ticket.deviceId}/rotate`;
  const offlineReply = page.waitForResponse((r) => new URL(r.url()).pathname === rotatePath);
  await manager.getByRole("button", { name: "Rotate credential", exact: true }).click();
  const offlineResponse = await offlineReply;
  assert.equal(offlineResponse.status(), 202, "offline rotate is accepted");
  assert.deepEqual(
    await offlineResponse.json(),
    { ok: true, mode: "requested" },
    "offline the hub only records the intent — no token is minted yet",
  );
  await expect(manager.getByRole("status")).toContainText(/waiting.*ACK/);
  await expect(
    manager.getByRole("button", { name: "Rotate credential", exact: true }),
  ).toBeDisabled();
  // S-7 (rotation really exercised): the click above minted nothing, so the rotation leak
  // surfaces — the rotate HTTP reply, the tunnel token-rotate control frame, the hub plaintext
  // cache — were never on the wire. Bring the device ONLINE through the real tunnel endpoint the
  // way the device connector does (bearer-authed upgrade → pair-handshake → hub hello), let the
  // hub hand over the rotation queued above, then drive one more, LIVE rotation from the same UI
  // button and ack both deliveries from the device side.
  const wsFrames = [];
  const rotations = []; // device-side view of hub token-rotate frames, token values redacted
  const acks = [];
  const credential = {
    pairingEpoch: ticket.pairingEpoch,
    credentialId: ticket.credentialId,
    generation: ticket.generation,
  };
  const deviceWs = new WebSocket(`ws://127.0.0.1:${port}/api/tunnel`, {
    headers: { authorization: `Bearer ${ticket.tunnelToken}` },
  });
  deviceWs.on("message", (data) => {
    const frame = JSON.parse(data.toString());
    wsFrames.push(`${frame.type}${frame.action ? `:${frame.action}` : ""}`);
    if (frame.type !== "control" || frame.action !== "token-rotate") return;
    issuedSecrets.add(frame.tunnelToken); // the scan must also know the ROTATED plaintext + hash
    issuedSecrets.add(createHash("sha256").update(frame.tunnelToken, "utf8").digest("hex"));
    rotations.push({
      generation: frame.generation,
      rotationId: `${frame.rotationId.slice(0, 8)}…`,
      token: `${frame.tunnelToken.slice(0, 8)}…`,
    });
    credential.pairingEpoch = frame.pairingEpoch;
    credential.credentialId = frame.credentialId;
    credential.generation = frame.generation;
    acks.push(frame.generation);
    // A real device persists the new credential BEFORE acking. The short apply delay keeps the
    // hub's rotation in flight long enough for the UI's "waiting for ACK" state to be observable
    // instead of racing the completion push.
    const ack = JSON.stringify({
      type: "control",
      action: "token-rotate-ack",
      rotationId: frame.rotationId,
      credentialId: frame.credentialId,
      generation: frame.generation,
      pairingEpoch: frame.pairingEpoch,
    });
    setTimeout(() => deviceWs.send(ack), 1_000).unref?.();
  });
  await new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error("tunnel upgrade timed out")), 10_000);
    deviceWs.once("open", () => {
      clearTimeout(timer);
      resolve();
    });
    deviceWs.once("unexpected-response", (_q, res) => {
      clearTimeout(timer);
      reject(new Error(`tunnel upgrade refused: ${res.statusCode}`));
    });
    deviceWs.once("error", (e) => {
      clearTimeout(timer);
      reject(e);
    });
  });
  deviceWs.send(
    JSON.stringify({
      type: "pair-handshake",
      v: 1,
      deviceUid: ticket.deviceUid,
      deviceId: ticket.deviceId,
      pairingEpoch: credential.pairingEpoch,
      credentialId: credential.credentialId,
      generation: credential.generation,
      apiVersion: 1,
      tunnelProto: 1,
      keyFingerprint: ticket.keyFingerprint,
    }),
  );
  await expect.poll(() => wsFrames.includes("hello")).toBe(true);
  await expect.poll(() => rotations.length).toBe(1);
  assert.equal(
    rotations[0].generation,
    2,
    "reconnect hands the device the rotation queued while it was offline",
  );
  await expect(manager.getByRole("status")).toHaveCount(0, { timeout: 10_000 }); // the device ACK settles it
  await expect(
    manager.getByRole("button", { name: "Rotate credential", exact: true }),
  ).toBeEnabled();
  await expect(page.locator(".toast")).toHaveCount(0, { timeout: 6_000 }); // the offline toast must be gone so the next sighting is fresh
  const onlineReply = page.waitForResponse((r) => new URL(r.url()).pathname === rotatePath);
  await manager.getByRole("button", { name: "Rotate credential", exact: true }).click();
  const onlineResponse = await onlineReply;
  assert.equal(onlineResponse.status(), 202, "online rotate is accepted");
  assert.deepEqual(
    await onlineResponse.json(),
    { ok: true, mode: "online" },
    "a connected device rotates now, over its live tunnel",
  );
  assert.deepEqual(
    leaksIn(await onlineResponse.text()),
    [],
    "S-7: the rotate HTTP reply carries no token",
  );
  await expect(page.locator(".toast")).toContainText(/Rotation queued/); // the UI surfaces the request
  await expect(manager.getByRole("status")).toContainText(/waiting.*ACK/); // …and the in-flight rotation
  await expect.poll(() => rotations.length).toBe(2);
  assert.deepEqual(
    rotations.map((r) => r.generation),
    [2, 3],
    "exactly one rotation per trigger — no duplicate delivery, no double mint",
  );
  assert.equal(
    new Set(rotations.map((r) => r.rotationId)).size,
    2,
    "each delivery is a distinct hub rotation",
  );
  await expect(manager.getByRole("status")).toHaveCount(0, { timeout: 10_000 });
  await expect(manager.locator("dd").nth(2)).toHaveText("3", { timeout: 10_000 }); // the UI shows the new generation
  const rotatedPairing = (await (await fetch(`${base}/api/network`)).json()).devices.find(
    (d) => d.id === ticket.deviceId,
  ).pairing;
  assert.equal(rotatedPairing.credentialGeneration, 3, "the committed generation is 3");
  assert.equal(rotatedPairing.rotationPending, false, "nothing is left in flight");
  assert.deepEqual(
    acks,
    [2, 3],
    "the device acknowledged both rotations from the connection they arrived on",
  );
  assert.deepEqual(
    leaksIn(await browserSurface(page)),
    [],
    "S-7: page surface right after a live rotation",
  );
  const probes = wsFrames.filter((f) => f === "rest-request").length;
  console.log(
    `PASS S-7 live rotation over the real tunnel: ws frames ${[...new Set(wsFrames)].join(", ")} (+${probes} monitor probes ignored); token-rotate ${rotations.map((r) => `gen${r.generation} rotation ${r.rotationId} token ${r.token}`).join(" | ")}; both acked; rotate replies 202 requested/online, no token in any HTTP reply`,
  );
  await new Promise((done) => {
    const timer = setTimeout(done, 5_000);
    deviceWs.once("close", () => {
      clearTimeout(timer);
      done();
    });
    deviceWs.close(1000, "scenario complete");
  });
  await manager.getByRole("button", { name: "Revoke", exact: true }).click();
  await expect(page.getByRole("dialog")).toHaveCount(1);
  await page.getByRole("dialog").getByRole("button", { name: "Revoke", exact: true }).click();
  await expect(page.getByRole("dialog")).toHaveCount(0);
  await deviceRow.hover();
  await deviceRow.getByRole("button", { name: /Manage credentials/ }).click();
  await expect(manager.locator(".pairing-status")).toHaveText("revoked");
  await expect(manager.getByRole("button", { name: "Rotate credential", exact: true })).toHaveCount(
    0,
  );
  await expect(manager.getByRole("button", { name: "Revoke", exact: true })).toHaveCount(0);
  await page.getByRole("button", { name: "Close device credentials", exact: true }).click();
  console.log(
    "PASS R03 offline/no-session device exposes full fingerprint, queued rotation and confirmed revoke with live metadata",
  );

  // S-7 — after the whole wizard, credential manager, rotation and revoke flow, with every dialog closed.
  await expect(page.getByRole("dialog")).toHaveCount(0);
  assert.deepEqual(
    leaksIn(await browserSurface(page), { codes: true }),
    [],
    "S-7: page surface after the flow",
  );
  const bodies = (await Promise.all(received)).filter(Boolean);
  assert.deepEqual(
    lostBodies,
    [],
    "every captured response body was actually read — a lost body can never pass unnoticed",
  );
  assert.ok(
    bodies.some((b) => new URL(b.url).pathname === "/api/network"),
    "the scan saw the admin network DTO",
  );
  assert.ok(bodies.length >= 5, `the scan saw the run's admin responses (${bodies.length})`);
  for (const { url, text } of bodies)
    assert.deepEqual(leaksIn(text), [], `S-7: response body of ${new URL(url).pathname}`);
  for (const { url, body, headers } of sent) {
    assert.deepEqual(leaksIn(`${url}\n${body}`), [], `S-7: request to ${new URL(url).pathname}`);
    assert.deepEqual(leaksIn(headers), [], `S-7: request headers to ${new URL(url).pathname}`);
  }
  assert.deepEqual(leaksIn(logged.join("\n"), { codes: true }), [], "S-7: console output");
  // The admin event stream: every payload the page's own EventSource received during the run.
  const sseEvents = await page.evaluate(() => {
    try {
      return JSON.parse(sessionStorage.getItem("__sseEvents") ?? "[]");
    } catch {
      return ["<unreadable>"];
    }
  });
  assert.ok(
    sseEvents.length >= 4,
    `the stream scan saw the run's admin events (${sseEvents.length})`,
  );
  assert.ok(
    sseEvents.some((e) => e.includes('"credentialGeneration":3')),
    "the stream actually carried the rotated generation metadata",
  );
  for (const [i, event] of sseEvents.entries())
    assert.deepEqual(leaksIn(event, { codes: true }), [], `S-7: stream event ${i}`);
  console.log(
    `PASS S-7 ${sseEvents.length} admin stream events are free of tokens, hashes and key material`,
  );
  assert.ok(
    issuedSecrets.size >= 3 && mintedCodes.size >= 4,
    "the scan covered every secret and code of the run",
  );
  console.log(
    `PASS S-7 page surface, ${bodies.length} responses, ${sent.length} requests and console are free of tokens, hashes, keys and spent codes`,
  );
  const cspViolations = await page.evaluate(() => window.__cspViolations ?? []);
  for (const v of cspViolations)
    console.log(`CSP VIOLATION ${v.directive} blocked=${v.blockedURI} sample=${v.sample}`);
  for (const c of cspConsole) console.log(`CSP CONSOLE ${c}`);
  assert.deepEqual(
    cspViolations,
    [],
    "CSP: no securitypolicyviolation events during the pairing flow",
  );
  assert.deepEqual(
    cspConsole,
    [],
    "CSP: no Content-Security-Policy console errors during the pairing flow",
  );
  assert.deepEqual(errors, []);
  console.log("ALL PAIRING UI CHECKS PASSED");
} catch (error) {
  await mkdir(evidence, { recursive: true });
  await page
    ?.locator(".pair-code, .pair-qr")
    .evaluateAll((nodes) =>
      nodes.forEach((node) => {
        node.style.visibility = "hidden";
      }),
    )
    .catch(() => {});
  await page?.screenshot({ path: join(evidence, "failure.png") }).catch(() => {});
  const kept = resolve(
    import.meta.dirname,
    "../../../artifacts/verification",
    `pairing-ui-${Date.now()}`,
    "ui-evidence",
  );
  await mkdir(kept, { recursive: true });
  await cp(evidence, kept, { recursive: true }).catch(() => {});
  console.error(`Pairing UI evidence: ${kept}`);
  throw error;
} finally {
  await browser?.close();
  await hub?.cleanup();
  await rm(root, { recursive: true, force: true });
}
