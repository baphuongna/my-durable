import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, readFile, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { loadConfig } from "../src/config.js";

/**
 * First-run token bootstrap: a fresh `dpi device` (npm install) has no DPI_TOKEN and no
 * `npm run token` — the daemon must mint its own, persist it, and reuse it forever after.
 * A user-provided short token is an explicit mistake and must stay an error.
 */
test("first run: DPI_TOKEN is generated, persisted owner-only, and reused on the next boot", async () => {
  const home = await mkdtemp(join(tmpdir(), "dpi-cfg-"));
  const first = loadConfig([], { DPI_HOME: home } as unknown as NodeJS.ProcessEnv);
  assert.match(first.token, /^dpi_[A-Za-z0-9_-]{32,}$/, "a full-strength device token is minted");
  const envFile = join(home, "backend.env");
  const raw = await readFile(envFile, "utf8");
  assert.ok(raw.includes(`DPI_TOKEN=${first.token}`), "the token is persisted to backend.env");
  if (process.platform !== "win32") {
    assert.equal((await stat(envFile)).mode & 0o777, 0o600, "the env file is owner-only");
  }
  // Simulated restart: the next boot's process env carries the file's token.
  const second = loadConfig([], { DPI_HOME: home, DPI_TOKEN: first.token } as unknown as NodeJS.ProcessEnv);
  assert.equal(second.token, first.token, "the same token survives a restart");
  assert.equal(first.tokenCreated, true, "boot 1 reports it created the token");
  assert.equal(second.tokenCreated, false, "boot 2 does not");
});

test("a user-provided short DPI_TOKEN is refused, never silently rotated", async () => {
  const home = await mkdtemp(join(tmpdir(), "dpi-cfg-"));
  assert.throws(
    () => loadConfig([], { DPI_HOME: home, DPI_TOKEN: "dpi_short" } as unknown as NodeJS.ProcessEnv),
    /shorter than 32/,
  );
});
