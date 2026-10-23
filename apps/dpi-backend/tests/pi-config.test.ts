/**
 * The device reuses pi's own credentials and custom providers from
 * ~/.pi/agent (auth.json + models.json) — read-only, with pi's precedence:
 * auth.json credential, then the models.json apiKey, then provider env vars.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  piAgentDir,
  readPiAuth,
  readPiModelsJson,
  piCredentialStore,
  credentialedProviders,
  piCustomProviders,
  loadPiConfig,
} from "../src/pi-config.js";

async function fixturePiDir() {
  const dir = await mkdtemp(join(tmpdir(), "dpi-pi-"));
  await writeFile(
    join(dir, "auth.json"),
    JSON.stringify({
      zai: { type: "api_key", key: "zai-key-1" },
      minimax: { type: "api_key", key: "mm-key-1" },
    }),
  );
  await writeFile(
    join(dir, "models.json"),
    JSON.stringify({
      providers: {
        chiase: {
          baseUrl: "https://api.example.com/v1",
          api: "openai-completions",
          apiKey: "chiase-key-1",
          models: [{ id: "model-x", name: "Model X", contextWindow: 200000 }],
        },
        broken: { baseUrl: "https://x.example.com", api: "carrier-pigeon", models: [{ id: "m" }] },
        nokey: { baseUrl: "https://y.example.com", api: "openai-completions", models: [{ id: "m" }] },
      },
    }),
  );
  return dir;
}

test("piAgentDir: PI_AGENT_DIR overrides, default ~/.pi/agent", () => {
  assert.equal(piAgentDir({ PI_AGENT_DIR: "/tmp/pi-agent" } as NodeJS.ProcessEnv), "/tmp/pi-agent");
  assert.match(piAgentDir({} as NodeJS.ProcessEnv), /\.pi\/agent$/);
});

test("credential precedence: auth.json beats models.json apiKey; both beat none", async () => {
  const dir = await fixturePiDir();
  const auth = readPiAuth(dir);
  const modelsJson = readPiModelsJson(dir);
  const store = piCredentialStore(auth, modelsJson);
  assert.equal((await store.read("zai"))?.type, "api_key");
  assert.equal(((await store.read("zai")) as { key?: string }).key, "zai-key-1", "auth.json entry");
  assert.equal(((await store.read("chiase")) as { key?: string }).key, "chiase-key-1", "models.json apiKey");
  assert.equal(await store.read("openrouter"), undefined, "nothing claimed without a source");
  assert.equal(await store.read("unknown"), undefined);
  await rm(dir, { recursive: true, force: true });
});

test("the store is READ-ONLY: modify/delete never persist to pi's files", async () => {
  const dir = await fixturePiDir();
  const before = await readFile(join(dir, "auth.json"), "utf8");
  const store = piCredentialStore(readPiAuth(dir), readPiModelsJson(dir));
  await store.modify("zai", async () => ({ type: "api_key", key: "evil" }));
  await store.delete("zai");
  assert.equal((await store.read("zai"))?.type, "api_key");
  assert.equal(await readFile(join(dir, "auth.json"), "utf8"), before);
  await rm(dir, { recursive: true, force: true });
});

test("credentialedProviders: ids with SOME credential", async () => {
  const dir = await fixturePiDir();
  const auth = readPiAuth(dir);
  const modelsJson = readPiModelsJson(dir);
  assert.deepEqual(credentialedProviders(auth, modelsJson).sort(), ["chiase", "minimax", "zai"]);
  await rm(dir, { recursive: true, force: true });
});

test("piCustomProviders: supported api builds, unsupported api reports why", async () => {
  const dir = await fixturePiDir();
  const modelsJson = readPiModelsJson(dir);
  const skipped: Array<{ id: string; reason: string }> = [];
  const providers = piCustomProviders(modelsJson, (id, reason) => skipped.push({ id, reason }));
  const ids = providers.map((p) => p.id);
  assert.ok(ids.includes("chiase"), "openai-completions is supported");
  assert.equal(
    providers.find((p) => p.id === "chiase")!.getModels().length,
    1,
    "the custom models are registered",
  );
  assert.deepEqual(skipped, [{ id: "broken", reason: "unsupported api carrier-pigeon" }]);
  assert.ok(ids.includes("nokey"), "a provider with models but no key still builds (env fallback)");
  await rm(dir, { recursive: true, force: true });
});

test("loadPiConfig: absent files mean an empty, harmless config", async () => {
  const empty = await mkdtemp(join(tmpdir(), "dpi-pi-empty-"));
  const cfg = loadPiConfig({ PI_AGENT_DIR: empty } as NodeJS.ProcessEnv);
  assert.deepEqual(cfg.credentialed, []);
  assert.deepEqual(cfg.customProviders, []);
  assert.deepEqual(cfg.skipped, []);
  await rm(empty, { recursive: true, force: true });
});
