/**
 * Gate #2 — writable pi provider keys: the security contract. Values never
 * leave the file (masked tails only), pi's interactive logins are untouchable,
 * and writes are atomic with a backup.
 */
import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, existsSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  piAuthView,
  writePiApiKey,
  removePiApiKey,
  maskPiKey,
  readPiAuth,
  type PiModelsJson,
} from "../src/pi-config.js";

const emptyModels: PiModelsJson = {};

function tempPiDir() {
  return mkdtempSync(join(tmpdir(), "pi-auth-"));
}

test("write → view shows a masked tail, never the value", () => {
  const dir = tempPiDir();
  try {
    writePiApiKey(dir, "zai", "sk-secret-t1234567890");
    const view = piAuthView(readPiAuth(dir), emptyModels);
    const zai = view.find((e) => e.providerId === "zai")!;
    assert.equal(zai.masked, "••••••••7890");
    assert.ok(!JSON.stringify(view).includes("sk-secret"), "raw key leaked in the view");
    // The file itself holds the real credential, 0600 semantics via open flags.
    const raw = JSON.parse(readFileSync(join(dir, "auth.json"), "utf8"));
    assert.equal(raw.zai.key, "sk-secret-t1234567890");
    assert.equal(raw.zai.type, "api_key");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("a write preserves other providers and keeps a .bak", () => {
  const dir = tempPiDir();
  try {
    writePiApiKey(dir, "zai", "key-one-1111");
    writePiApiKey(dir, "opencode-go", "key-two-2222");
    const raw = JSON.parse(readFileSync(join(dir, "auth.json"), "utf8"));
    assert.ok(raw.zai && raw["opencode-go"], "other entries must survive");
    assert.ok(existsSync(join(dir, "auth.json.bak")), "no backup of the previous file");
    // Rotation: same provider, new value — .bak now holds the OLD value.
    writePiApiKey(dir, "zai", "key-one-9999");
    const bak = JSON.parse(readFileSync(join(dir, "auth.json.bak"), "utf8"));
    assert.equal(bak.zai.key, "key-one-1111");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("oauth entries (pi's interactive logins) are refused on write AND delete", () => {
  const dir = tempPiDir();
  try {
    writeFileSync(
      join(dir, "auth.json"),
      JSON.stringify({ anthropic: { type: "oauth", access: "x", refresh: "y" } }),
      { mode: 0o600 },
    );
    assert.throws(() => writePiApiKey(dir, "anthropic", "k"), /interactive pi login/);
    assert.throws(() => removePiApiKey(dir, "anthropic"), /interactive pi login/);
    // And the file is untouched.
    const raw = JSON.parse(readFileSync(join(dir, "auth.json"), "utf8"));
    assert.equal(raw.anthropic.type, "oauth");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("a corrupt auth.json is refused, not rewritten", () => {
  const dir = tempPiDir();
  try {
    writeFileSync(join(dir, "auth.json"), "{ not json", { mode: 0o600 });
    assert.throws(() => writePiApiKey(dir, "zai", "k"), /not valid JSON/);
    assert.equal(readFileSync(join(dir, "auth.json"), "utf8"), "{ not json");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("provider ids and keys are validated; delete reports existence", () => {
  const dir = tempPiDir();
  try {
    assert.throws(() => writePiApiKey(dir, "../evil", "k"), /invalid provider id/);
    assert.throws(() => writePiApiKey(dir, "zai", "   "), /1–4096/);
    assert.equal(removePiApiKey(dir, "absent"), false);
    writePiApiKey(dir, "zai", "real-key-0000");
    assert.equal(removePiApiKey(dir, "zai"), true);
    assert.equal(JSON.parse(readFileSync(join(dir, "auth.json"), "utf8")).zai, undefined);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("maskPiKey keeps only the last four", () => {
  assert.equal(maskPiKey("abcdefghijklmnopqrstuvwxyz"), "••••••••wxyz");
  assert.equal(maskPiKey("short"), "••••••••hort");
});

test("models.json apiKeys appear masked in the view but only auth.json is writable", () => {
  const dir = tempPiDir();
  try {
    writePiApiKey(dir, "zai", "auth-key-aaaa");
    const models: PiModelsJson = { providers: { or: { apiKey: "models-key-bbbb" } } };
    const view = piAuthView(readPiAuth(dir), models);
    const or = view.find((e) => e.providerId === "or")!;
    assert.equal(or.source, "models.json");
    assert.equal(or.masked, "••••••••bbbb");
    assert.ok(!JSON.stringify(view).includes("models-key"), "models.json key leaked");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
