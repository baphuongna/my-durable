/**
 * Welcome-screen startup logic: the app opens first, connection is a state.
 * Pure parts only: startup decision, pair-arg assembly from prompted values,
 * URL+token validation, local backend.env discovery + probe formatting, and
 * the welcome picker's rendered lines.
 */
import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { visibleWidth } from "@earendil-works/pi-tui";
import type { DeviceRow } from "../../dpi-sdk/src/node/registry.ts";
import { encodePairOffer } from "../../dpi-sdk/src/protocol/pairing.ts";
import {
  applyBackendEnv,
  assemblePairArgs,
  describeLocalProbe,
  localBackendUrl,
  parseEnvFile,
  probeLocalBackend,
  resolveStartupAction,
  suggestDeviceId,
  validateDeviceInput,
  welcomeItems,
  WelcomePicker,
} from "../src/welcome.ts";

const TOKEN = `dpi_${"T".repeat(43)}`;

const row = (over: Partial<DeviceRow> = {}): DeviceRow => ({
  id: "mac-mini",
  name: "Mac mini",
  kind: "url",
  transport: "lan",
  url: "http://192.168.1.5:4780",
  token: TOKEN,
  source: "ui",
  position: 0,
  deviceUid: null,
  lastStatus: "checking",
  lastError: null,
  lastSeenAt: null,
  lastInfo: null,
  lastTree: null,
  createdAt: 0,
  updatedAt: 0,
  ...over,
});

// ------------------------------------------------------------------ startup decision

test("resolveStartupAction: no device at all → welcome", () => {
  assert.deepEqual(resolveStartupAction({ devices: [], args: {} }), { kind: "welcome" });
});

test("resolveStartupAction: exactly one connectable device → auto-open it", () => {
  const mac = row();
  assert.deepEqual(resolveStartupAction({ devices: [mac], args: {} }), { kind: "auto-open", device: mac });
});

test("resolveStartupAction: several connectable devices → the device picker", () => {
  const mac = row();
  const pi = row({ id: "pi", url: "http://192.168.1.9:4780", position: 1 });
  assert.deepEqual(resolveStartupAction({ devices: [mac, pi], args: {} }), { kind: "picker", devices: [mac, pi] });
});

test("resolveStartupAction: a saved device without a token cannot auto-connect → welcome", () => {
  assert.deepEqual(resolveStartupAction({ devices: [row({ token: null })], args: {} }), { kind: "welcome" });
});

test("resolveStartupAction: a tunnel-only device cannot auto-connect → welcome", () => {
  assert.deepEqual(resolveStartupAction({ devices: [row({ transport: "tunnel", url: null, token: null })], args: {} }), {
    kind: "welcome",
  });
});

test("resolveStartupAction: an explicit device/url/pair or env override is the caller's business (explicit)", () => {
  for (const args of [{ deviceRef: "mac-mini" }, { url: "http://x:1" }, { pair: "AB12CD34" }, { pair: "" }])
    assert.equal(resolveStartupAction({ devices: [row()], args }).kind, "explicit", JSON.stringify(args));
  assert.equal(resolveStartupAction({ devices: [row()], env: { DPI_DEVICE: "mac-mini" }, args: {} }).kind, "explicit");
  assert.equal(resolveStartupAction({ devices: [row()], env: { DPI_URL: "http://x:1" }, args: {} }).kind, "explicit");
});

// ------------------------------------------------------------------ pair-arg assembly (from the welcome prompt)

test("assemblePairArgs: code + --hub in the pasted text", () => {
  assert.deepEqual(assemblePairArgs("AB12CD34 --hub https://hub.example.com"), {
    code: "AB12CD34",
    pairUrl: undefined,
    hub: "https://hub.example.com",
    force: undefined,
  });
});

test("assemblePairArgs: a pasted pair URL carries its own origin — no hub needed", () => {
  assert.deepEqual(assemblePairArgs("https://hub.example.com/pair?code=AB12CD34"), {
    code: undefined,
    pairUrl: "https://hub.example.com/pair?code=AB12CD34",
    hub: undefined,
    force: undefined,
  });
});

test("assemblePairArgs: a pasted v2 offer link passes through WHOLE as pairUrl — the backend parses the fragment", () => {
  const link = `https://hub.example.com/pair#offer=${encodePairOffer({
    v: 2,
    hub: "https://hub.example.com",
    id: "1a2b3c4d-5e6f-4a5b-8c9d-0e1f2a3b4c5d",
    code: "a1b2c3d4-e5f6-4789-abcd-eff012345678",
    exp: 1760000240000,
  })}`;
  assert.deepEqual(assemblePairArgs(link), {
    code: undefined,
    pairUrl: link, // the whole link, fragment included — origin and code travel inside it
    hub: undefined,
    force: undefined,
  });
});

test("assemblePairArgs: a plain code takes the hub from the second prompt", () => {
  assert.deepEqual(assemblePairArgs("AB12CD34", "https://hub.example.com"), {
    code: "AB12CD34",
    pairUrl: undefined,
    hub: "https://hub.example.com",
    force: undefined,
  });
});

test("assemblePairArgs: a plain code with no origin anywhere is refused (no hardcoded hub)", () => {
  assert.equal(assemblePairArgs("AB12CD34"), undefined);
  assert.equal(assemblePairArgs("AB12CD34", "  "), undefined);
  assert.equal(assemblePairArgs(""), undefined);
  assert.equal(assemblePairArgs("--hub https://h"), undefined);
});

// ------------------------------------------------------------------ backend.env discovery

test("parseEnvFile: KEY=VALUE, comments, quotes, junk lines", () => {
  assert.deepEqual(parseEnvFile("DPI_TOKEN=abc\n# comment\n\nDPI_PORT=4781\nQUOTED=\"x y\"\nSINGLE='z'\nbroken\n=X\n"), {
    DPI_TOKEN: "abc",
    DPI_PORT: "4781",
    QUOTED: "x y",
    SINGLE: "z",
  });
});

test("applyBackendEnv: primes env from DPI_HOME/backend.env without overwriting the caller's env", async () => {
  const home = await mkdtemp(join(tmpdir(), "dpi-welcome-env-"));
  try {
    await writeFile(join(home, "backend.env"), `DPI_TOKEN=${TOKEN}\nDPI_PORT=4790\n`, { mode: 0o600 });
    const env: Record<string, string | undefined> = {};
    const applied = applyBackendEnv(env, home);
    assert.equal(applied.token, TOKEN);
    assert.equal(applied.port, 4790);
    assert.equal(env.DPI_TOKEN, TOKEN, "LocalPairing.fromEnv() must find the token after this");
    assert.equal(env.DPI_PORT, "4790");

    const kept = applyBackendEnv({ DPI_TOKEN: "dpi_caller", DPI_PORT: "1234" }, home);
    assert.equal(kept.token, "dpi_caller");
    assert.equal(kept.port, 1234);
  } finally {
    await import("node:fs/promises").then((fs) => fs.rm(home, { recursive: true, force: true }));
  }
});

test("applyBackendEnv: no file, no env → port 4780 and no token", () => {
  const applied = applyBackendEnv({}, "/nonexistent-dpi-home");
  assert.equal(applied.token, undefined);
  assert.equal(applied.port, 4780);
});

// ------------------------------------------------------------------ local probe

const info = { uid: "u1", name: "mac-mini", hostname: "mac-mini", platform: "linux" };

test("probeLocalBackend: a reachable, token-accepted backend yields its device info", async () => {
  const probe = await probeLocalBackend(localBackendUrl(4780), TOKEN, async () => new Response(JSON.stringify(info), { status: 200 }));
  assert.deepEqual(probe, { ok: true, info: { ...info } as never });
});

test("probeLocalBackend: 401 vs down vs erroring transport", async () => {
  const unauthorized = await probeLocalBackend("http://127.0.0.1:4780", "wrong", async () => new Response("{}", { status: 401 }));
  assert.deepEqual(unauthorized, { ok: false, reason: "unauthorized" });
  const down = await probeLocalBackend("http://127.0.0.1:4780", TOKEN, async () => new Response("{}", { status: 503 }));
  assert.deepEqual(down, { ok: false, reason: "unreachable" });
  const thrown = await probeLocalBackend("http://127.0.0.1:4780", TOKEN, async () => {
    throw new Error("ECONNREFUSED");
  });
  assert.deepEqual(thrown, { ok: false, reason: "unreachable" });
});

test("describeLocalProbe: failure says plainly how to start one, with the real port", () => {
  assert.equal(describeLocalProbe({ ok: false, reason: "unreachable" }, 4780), "no local dpi-backend on 127.0.0.1:4780 — start one with: dpi device");
  assert.equal(describeLocalProbe({ ok: false, reason: "unreachable" }, 5000), "no local dpi-backend on 127.0.0.1:5000 — start one with: dpi device");
  assert.match(describeLocalProbe({ ok: false, reason: "unauthorized" }, 4780), /rejected the token/);
  assert.match(describeLocalProbe({ ok: true, info: { ...info } as never }, 4780), /local dpi-backend on 127\.0\.0\.1:4780/);
  assert.match(describeLocalProbe({ ok: true, info: { ...info } as never }, 4780), /mac-mini/);
});

// ------------------------------------------------------------------ ids and device input

test("suggestDeviceId: hostname → a valid registry id, dots to dashes, with fallbacks", () => {
  assert.equal(suggestDeviceId("192.168.1.5"), "192-168-1-5");
  assert.equal(suggestDeviceId("Mac mini"), "mac-mini");
  assert.equal(suggestDeviceId(undefined, "localhost"), "localhost");
  assert.equal(suggestDeviceId(undefined, ""), "device");
  assert.match(suggestDeviceId("UPPER.Host.Name"), /^[a-z0-9][a-z0-9-]{0,31}$/);
});

test("validateDeviceInput: URL and token reuse the registry's own rules", () => {
  assert.deepEqual(validateDeviceInput("http://127.0.0.1:4780/", TOKEN), { url: "http://127.0.0.1:4780", token: TOKEN });
  const error = (r: ReturnType<typeof validateDeviceInput>) => ("error" in r ? r.error : assert.fail("expected an error"));
  assert.match(error(validateDeviceInput("ftp://x", TOKEN)), /http or https/);
  assert.match(error(validateDeviceInput("http://x:1/?q=1", TOKEN)), /query or fragment/);
  assert.match(error(validateDeviceInput("http://x:1", "short")), /32 characters/);
  assert.match(error(validateDeviceInput("nope", TOKEN)), /Invalid URL/);
});

// ------------------------------------------------------------------ the welcome picker renders

test("welcomeItems: three actions with no devices, a fourth to switch when some exist", () => {
  const bare = welcomeItems(0, 4780);
  assert.deepEqual(bare.map((i) => i.value), ["pair", "add-url", "detect-local"]);
  assert.match(bare[0]!.label, /\[p\].*Pair this machine/);
  assert.match(bare[1]!.label, /\[a\].*Add a device by URL/);
  assert.match(bare[2]!.label, /\[d\].*local backend/i);
  assert.ok(bare[2]!.description!.includes("4780"));
  assert.deepEqual(welcomeItems(2, 4780).map((i) => i.value), ["pair", "add-url", "detect-local", "switch-device"]);
});

test("WelcomePicker: renders the title, the notice, and every action within the width", () => {
  const picker = new WelcomePicker(welcomeItems(0, 4780), () => {}, () => {}, "mac-mini is offline at http://1.2.3.4:1 (boom)");
  for (const width of [40, 80, 200]) {
    const lines = picker.render(width);
    const text = lines.join("\n");
    assert.match(text, /No device yet\./, `title at ${width}`);
    assert.match(text, /mac-mini is offline/, `notice at ${width}`);
    assert.match(text, /Pair this machine/);
    assert.match(text, /Add a device by URL/);
    for (const line of lines) assert.ok(visibleWidth(line) <= width, `line fits ${width}`);
  }
});
