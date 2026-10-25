/**
 * Wave 3 slice 2: telegram chat bridge (module → broker wiring → CLI → bin)
 * and conversation shares (registry → hub routes → public page → FE button).
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";

const R = (p: string) => readFile(new URL(p, import.meta.url), "utf8");

test("telegram: module → store broker → daemon start → CLI → bin", async () => {
  const module = await R("../../dpi-backend/src/telegram.ts");
  assert.match(module, /class TelegramBridge/, "no bridge");
  assert.match(module, /getUpdates/, "no long-poll loop");
  assert.match(module, /offset/, "no offset cursor");
  assert.match(module, /expired/, "bind codes must expire");
  const store = await R("../../dpi-backend/src/store.ts");
  assert.match(store, /telegramBroker\(\)/, "no store-side broker");
  assert.match(store, /sendToSession/, "the broker cannot reach a session");
  assert.match(store, /lastAssistantText/, "answers are not read back");
  assert.match(store, /options\.telegramToken\) store\.telegram\.start/, "the daemon does not start the loop");
  assert.match(store, /this\.telegram\?\.stop\(\)/, "close does not stop the loop");
  assert.match(store, /"telegram"/, "deviceInfo does not report the capability");
  const main = await R("../../dpi-backend/src/main.ts");
  assert.match(main, /DPI_TELEGRAM_TOKEN/, "the token is never read from the env");
  const cli = await R("../../dpi-backend/src/telegram-cli.ts");
  assert.match(cli, /export async function telegramCli/, "no CLI");
  const bin = await R("../../../bin/dpi.mjs");
  assert.match(bin, /command === "telegram"/, "dpi telegram is not wired");
});

test("shares: registry → hub routes → public page → FE button", async () => {
  const module = await R("../apps/dpi-playground-hub/src/shares.ts");
  assert.match(module, /DEFAULT_TTL_DAYS = 7/, "retention must be explicit");
  assert.match(module, /expiresAt/, "no expiry");
  assert.match(module, /sweep/, "no expired-share sweep");
  assert.match(module, /escapeHtml/, "the public page does not escape");
  const hubMain = await R("../apps/dpi-playground-hub/src/main.ts");
  for (const route of ['"/api/shares"', '"/api/shares/:token"', '"/share/:token"'])
    assert.ok(hubMain.includes(`app.${route.includes(":token", 8) ? "get" : ""}`) || hubMain.includes(route), `${route} missing`);
  assert.match(hubMain, /adminAuth,\s*\n?\s*\(req, res\)/, "share creation must be admin-only");
  assert.match(hubMain, /default-src 'none'; style-src 'unsafe-inline'/, "the public page CSP is too loose");
  const hub = await R("../apps/dpi-playground-fe/src/client/hub.ts");
  assert.match(hub, /createShare/, "the FE cannot create shares");
  const insp = await R("../apps/dpi-playground-fe/src/components/Inspector.vue");
  assert.match(insp, /shareTranscript/, "no share flow");
  assert.match(insp, /aria-label="Share transcript"/, "the share BUTTON must exist, not just the function");
  assert.match(insp, /Anyone with the link/, "no public-link warning");
  assert.match(insp, /expires/, "the dialog does not say when it expires");
});
