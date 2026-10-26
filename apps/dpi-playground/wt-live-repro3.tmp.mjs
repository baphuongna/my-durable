import { chromium } from "@playwright/test";
import { readFileSync } from "node:fs";
const TOKEN = readFileSync(`${process.env.HOME}/.local/share/durable-pi/admin.token`, "utf8").trim();
const errors = [];
const browser = await chromium.launch({ executablePath: "/usr/bin/google-chrome", headless: true });
const page = await browser.newPage({ viewport: { width: 1600, height: 1000 } });
page.on("response", async (r) => {
  const m = r.request().method();
  if ((r.url().includes("/v1/sessions") && m === "POST") || (r.url().includes("/v1/git") && m === "POST")) {
    let body = "";
    try { body = (await r.json()).error?.message ?? ""; } catch {}
    console.log(`[net] ${m} ${r.url().split("/api/")[1]} -> ${r.status()} ${body}`);
  }
});
page.on("console", (m) => m.type() === "error" && !/cloudflare|beacon/.test(m.text()) && errors.push(m.text().slice(0, 120)));

await page.goto("https://my-durable.phuongnb.io.vn/");
await page.locator(".login-veil input").fill(TOKEN);
await page.locator(".login-veil input").press("Enter");
await page.waitForTimeout(4000);

await page.evaluate(() => {
  const hit = [...document.querySelectorAll(".tree-row")].find((r) => r.querySelector(".name")?.textContent?.trim() === "usage-probe");
  if (!hit) throw Error("usage-probe row not found");
  hit.classList.add("probe-target");
});
await page.locator(".probe-target").hover();
await page.click(`.probe-target button[aria-label^="New worktree session from"]`);
await page.locator("input").last().fill("wt-fixcheck");
await page.click("text=Create worktree session");
await page.waitForTimeout(12000);

const bodyText = await page.evaluate(() => document.body.textContent ?? "");
const net = await page.evaluate(async (tok) => {
  const r = await fetch("/api/devices/1e2e23fcd30b49c4ba1ffa2151816bd3/v1/sessions", { headers: { authorization: `Bearer ${tok}` } });
  return (await r.json()).sessions?.map((s) => `${s.name}|${s.cwd}|${s.provider}/${s.model}`);
}, TOKEN);
const created = (net ?? []).filter((s) => s.includes("gitdemo-wt-fixcheck"));
console.log("bundle:", await page.evaluate(() => [...document.scripts].map((s) => s.src).find((s) => s.includes("index-"))));
console.log("sidebar contains wt-fixcheck:", bodyText.includes("wt-fixcheck"));
console.log("message-error 'model must be':", /model must be/.test(bodyText) ? "PRESENT (FAIL)" : "absent (PASS)");
console.log("message-error 'Unknown model':", /Unknown model/.test(bodyText) ? "PRESENT (FAIL)" : "absent (PASS)");
console.log("created session(s):", JSON.stringify(created, null, 2));
console.log("app console errors:", errors.length ? errors : "none");
await page.screenshot({ path: "/tmp/wt-fixcheck-live.png" });
await browser.close();
if (!created.length) process.exit(1);
