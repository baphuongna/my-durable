/**
 * `dpi pair …` — pairing from the CLI in BOTH directions, no browser:
 *   device side  : pair this machine with a code/link, or ask the hub itself
 *   operator side: mint an offer, list who is waiting, approve, revoke
 * The device side must print the identity block (name/hostname/platform/
 * fingerprint) because that is what the operator compares before approving.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile, mkdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { parsePairCommand, localTarget, hubTarget, runPairCommand, listDevices } from "../src/pair-cli.js";

const HUB = "https://hub.example.com";
const FP = `sha256:${"a".repeat(64)}`;

/** A scripted backend: each call matches a route and returns a canned body. */
function scripted(routes: Record<string, unknown | ((init?: RequestInit) => unknown)>) {
  const calls: { url: string; method: string; body?: string }[] = [];
  const fetchImpl = (async (url: string, init?: RequestInit) => {
    const key = `${init?.method ?? "GET"} ${new URL(url).pathname}`;
    calls.push({ url, method: init?.method ?? "GET", body: init?.body as string | undefined });
    const route = routes[key];
    if (route === undefined)
      return new Response(JSON.stringify({ error: { message: `no route ${key}` } }), { status: 404 });
    const body = typeof route === "function" ? (route as (i?: RequestInit) => unknown)(init) : route;
    return new Response(JSON.stringify(body), { status: 200 });
  }) as unknown as typeof fetch;
  return { fetchImpl, calls };
}

test("parsePairCommand: device, offer, list, approve, revoke + flags", () => {
  assert.deepEqual(parsePairCommand(["AB12", "--hub", HUB, "--force"]), {
    action: "device",
    target: "AB12",
    hub: HUB,
    force: true,
    wait: false,
    watch: false,
  });
  assert.equal(parsePairCommand(["list", "--watch"]).watch, true);
  assert.equal(parsePairCommand(["--hub", HUB]).action, "device");
  assert.equal(parsePairCommand(["--hub", HUB]).target, undefined, "--hub alone is device-initiated");
  assert.deepEqual(parsePairCommand(["offer", "--hub", HUB]), {
    action: "offer",
    hub: HUB,
    force: false,
    wait: false,
    watch: false,
  });
  assert.equal(parsePairCommand(["list"]).action, "list");
  assert.equal(parsePairCommand(["approve", "Laptop"]).target, "Laptop");
  assert.equal(parsePairCommand(["revoke", "Laptop"]).action, "revoke");
});

test("tokens: device token from its env file, admin token from the hub home", async () => {
  const dir = await mkdtemp(join(tmpdir(), "dpi-pairtok-"));
  const devHome = join(dir, "dev");
  const hubHome = join(dir, "hub");
  await mkdir(devHome, { recursive: true });
  await mkdir(hubHome, { recursive: true });
  await writeFile(join(devHome, "backend.env"), "DPI_TOKEN=dpi_device_token_value\n");
  await writeFile(join(hubHome, "admin.token"), "adm_hub_token_value\n");

  assert.equal(localTarget({ DPI_HOME: devHome, DPI_PORT: "4999" }).token, "dpi_device_token_value");
  assert.equal(localTarget({ DPI_HOME: devHome, DPI_PORT: "4999" }).url, "http://127.0.0.1:4999");
  assert.equal(hubTarget({ DPI_HOME: hubHome }).token, "adm_hub_token_value");
  assert.equal(hubTarget({ DPI_HUB_URL: `${HUB}/` }).origin, HUB, "trailing slash trimmed");
  await rm(dir, { recursive: true, force: true });
});

test("device: a code pairs this machine and prints the identity block", async () => {
  const { fetchImpl, calls } = scripted({
    "POST /v1/pairing/start": {
      state: "pairing",
      deviceName: "PhuongNB-Laptop",
      hostname: "laptop",
      platform: "win32-x64",
      fingerprint: FP,
      pending: { hubOrigin: HUB },
    },
    "GET /v1/pairing": { state: "paired", hubOrigin: HUB, fingerprint: FP },
  });
  const out: string[] = [];
  const code = await runPairCommand(["AB12CD34", "--hub", HUB], {
    env: { DPI_HOME: "/nonexistent", DPI_TOKEN: "dpi_x", DPI_PORT: "4799" },
    fetchImpl,
    print: (l) => out.push(l),
    sleep: async () => {},
  });
  assert.equal(code, 0);
  assert.equal(JSON.parse(calls[0]!.body!).code, "AB12CD34");
  const text = out.join("\n");
  assert.match(text, /device\s+PhuongNB-Laptop/);
  assert.match(text, /hostname\s+laptop/);
  assert.match(text, /platform\s+win32-x64/);
  assert.match(text, new RegExp(`fingerprint ${FP}`), "the full fingerprint must be shown");
  assert.match(text, /approve there/);
  assert.match(text, /paired ✓/);
});

test("device: --hub alone asks the hub itself (no code travels between machines)", async () => {
  const { fetchImpl, calls } = scripted({
    "POST /v1/pairing/start": { state: "pairing", deviceName: "box", fingerprint: FP, pending: { hubOrigin: HUB } },
    "GET /v1/pairing": { state: "paired", hubOrigin: HUB },
  });
  const out: string[] = [];
  const code = await runPairCommand(["--hub", HUB], {
    env: { DPI_TOKEN: "dpi_x", DPI_PORT: "4799" },
    fetchImpl,
    print: (l) => out.push(l),
    sleep: async () => {},
  });
  assert.equal(code, 0);
  const body = JSON.parse(calls[0]!.body!);
  assert.equal(body.hub, HUB);
  assert.equal(body.code, undefined, "device-initiated carries no code");
  assert.match(out.join("\n"), /asks? the hub|pairing with/i);
});

test("device: an approval timeout is reported on stderr, never claimed as success", async () => {
  const { fetchImpl } = scripted({
    "POST /v1/pairing/start": { state: "pairing", deviceName: "box", fingerprint: FP, pending: { hubOrigin: HUB } },
    "GET /v1/pairing": { state: "pairing" },
  });
  const out: string[] = [];
  const err: string[] = [];
  let now = 0;
  const code = await runPairCommand(["--hub", HUB], {
    env: { DPI_TOKEN: "dpi_x", DPI_PORT: "4799" },
    fetchImpl,
    print: (l) => out.push(l),
    printErr: (l) => err.push(l),
    sleep: async () => {
      now += 5_000;
    },
    pollMs: 1,
    timeoutMs: 10_000,
  });
  assert.equal(code, 1);
  assert.match(err.join("\n"), /still waiting for approval/);
  assert.doesNotMatch(out.join("\n"), /still waiting for approval/, "stdout stays clean");
  assert.doesNotMatch(out.join("\n"), /paired ✓/);
  assert.ok(now >= 10_000, "the loop respected the timeout");
});

test("operator: offer mints a link and says how to use it", async () => {
  const { fetchImpl, calls } = scripted({
    "POST /api/pair/code": {
      codeId: "c1",
      code: "11111111-2222-4333-8444-555555555555",
      expiresAt: Date.now() + 300_000,
      offerUrl: `${HUB}/pair#offer=abc`,
    },
  });
  const out: string[] = [];
  const code = await runPairCommand(["offer", "--hub", HUB], {
    env: { DPI_ADMIN_TOKEN: "adm_x" },
    fetchImpl,
    print: (l) => out.push(l),
  });
  assert.equal(code, 0);
  assert.equal(calls[0]!.method, "POST");
  assert.match(out.join("\n"), new RegExp(`${HUB}/pair#offer=abc`));
  assert.match(out.join("\n"), /dpi pair <link>/);
});

test("operator: list shows every waiting machine with its identity", async () => {
  const { fetchImpl } = scripted({
    "GET /api/pair/codes": {
      codes: [
        {
          codeId: "c1",
          deviceName: "PhuongNB-Laptop",
          hostname: "laptop",
          platform: "win32-x64",
          keyFingerprint: FP,
          phase: "awaiting_approval",
          enrollmentId: "e1",
          deviceUid: "u1",
        },
      ],
    },
  });
  const out: string[] = [];
  const code = await runPairCommand(["list", "--hub", HUB], {
    env: { DPI_ADMIN_TOKEN: "adm_x" },
    fetchImpl,
    print: (l) => out.push(l),
  });
  assert.equal(code, 0);
  const text = out.join("\n");
  assert.match(text, /PhuongNB-Laptop/);
  assert.match(text, /hostname\s+laptop/);
  assert.match(text, /platform\s+win32-x64/);
  assert.match(text, new RegExp(FP));
  assert.match(text, /dpi pair approve PhuongNB-Laptop/);
});

test("operator: approve sends the hub's own fingerprint, never a claimed one", async () => {
  const { fetchImpl, calls } = scripted({
    "GET /api/pair/codes": {
      codes: [
        {
          codeId: "c1",
          deviceName: "Laptop",
          keyFingerprint: FP,
          phase: "awaiting_approval",
          enrollmentId: "e1",
          deviceUid: "u1",
        },
      ],
    },
    "POST /api/pair/codes/c1/approve": { phase: "approved" },
  });
  const out: string[] = [];
  const code = await runPairCommand(["approve", "laptop", "--hub", HUB], {
    env: { DPI_ADMIN_TOKEN: "adm_x" },
    fetchImpl,
    print: (l) => out.push(l),
  });
  assert.equal(code, 0, "matching is case-insensitive");
  const body = JSON.parse(calls.find((c) => c.method === "POST")!.body!);
  assert.deepEqual(body, { enrollmentId: "e1", deviceUid: "u1", keyFingerprint: FP });
  assert.match(out.join("\n"), /approved Laptop/);
});

test("operator: approve with an unknown name lists what IS waiting (on stderr)", async () => {
  const { fetchImpl } = scripted({ "GET /api/pair/codes": { codes: [] } });
  const out: string[] = [];
  const err: string[] = [];
  const code = await runPairCommand(["approve", "ghost", "--hub", HUB], {
    env: { DPI_ADMIN_TOKEN: "adm_x" },
    fetchImpl,
    print: (l) => out.push(l),
    printErr: (l) => err.push(l),
  });
  assert.equal(code, 1);
  assert.match(err.join("\n"), /nothing waiting matches/);
  assert.equal(out.length, 0, "stdout stays clean");
});

test("operator: revoke resolves the device by name and posts the reason", async () => {
  const { fetchImpl, calls } = scripted({
    "GET /api/network": { devices: [{ id: "dev1", name: "PhuongNB-Laptop" }] },
    "POST /api/devices/dev1/revoke": { ok: true },
  });
  const out: string[] = [];
  const code = await runPairCommand(["revoke", "phuongnb-laptop", "--hub", HUB], {
    env: { DPI_ADMIN_TOKEN: "adm_x" },
    fetchImpl,
    print: (l) => out.push(l),
  });
  assert.equal(code, 0);
  assert.match(out.join("\n"), /revoked PhuongNB-Laptop/);
  assert.ok(calls.some((c) => c.url.includes("/api/devices/dev1/revoke")));
});

test("hub commands refuse to run without an admin token instead of guessing", async () => {
  const out: string[] = [];
  const err: string[] = [];
  const code = await runPairCommand(["list", "--hub", HUB], {
    env: { DPI_HOME: "/nonexistent-home" },
    fetchImpl: (async () => new Response("{}")) as unknown as typeof fetch,
    print: (l) => out.push(l),
    printErr: (l) => err.push(l),
  });
  assert.equal(code, 1);
  assert.match(err.join("\n"), /admin token/);
  assert.equal(out.length, 0, "stdout stays clean");
});

test("pair + devices: every failure lands on stderr so stdout stays pipeable", async () => {
  const out: string[] = [];
  const err: string[] = [];
  const capture = { print: (l: string) => out.push(l), printErr: (l: string) => err.push(l) };
  // No hub, no token: pure usage errors, no network involved.
  assert.equal(await runPairCommand(["list"], { env: {}, ...capture }), 1);
  assert.equal(await listDevices({ env: {}, ...capture }), 1);
  assert.equal(out.length, 0, "stdout untouched by failures");
  assert.match(err.join("\n"), /list needs --hub/);
  assert.match(err.join("\n"), /devices needs --hub/);
});

test("devices: lists paired machines with live status, --watch reprints only on change", async () => {
  const calls: string[] = [];
  let round = 0;
  const fetchImpl = (async () => {
    round += 1;
    calls.push(`fetch${round}`);
    const devices =
      round === 1
        ? [{ id: "d1", name: "laptop", status: "online", transport: "tunnel" }]
        : [
            { id: "d1", name: "laptop", status: "offline", transport: "tunnel" },
            { id: "d2", name: "desktop", status: "online", transport: "lan" },
          ];
    return new Response(JSON.stringify({ devices }), { status: 200 });
  }) as unknown as typeof fetch;

  const out: string[] = [];
  let polls = 0;
  const code = await listDevices(
    {
      env: { DPI_ADMIN_TOKEN: "adm_x", DPI_HUB_URL: HUB },
      fetchImpl,
      print: (l) => out.push(l),
      sleep: async () => {
        polls += 1;
        if (polls > 1) throw Error("stop the loop");
      },
    },
    undefined,
    true,
  ).catch((e: Error) => (e.message === "stop the loop" ? 0 : Promise.reject(e)));

  assert.equal(code, 0);
  const text = out.join("\n");
  assert.match(text, /online\s+laptop/);
  assert.match(text, /offline\s+laptop/, "the status change was reprinted");
  assert.match(text, /online\s+desktop/, "the newly paired machine appeared");
});

test("devices: without --watch it prints once and returns", async () => {
  const fetchImpl = (async () =>
    new Response(JSON.stringify({ devices: [{ id: "d1", name: "box", status: "online" }] }), {
      status: 200,
    })) as unknown as typeof fetch;
  const out: string[] = [];
  const code = await listDevices({
    env: { DPI_ADMIN_TOKEN: "adm_x", DPI_HUB_URL: HUB },
    fetchImpl,
    print: (l) => out.push(l),
    sleep: async () => assert.fail("must not poll without --watch"),
  });
  assert.equal(code, 0);
  assert.match(out.join("\n"), /online\s+box/);
});
