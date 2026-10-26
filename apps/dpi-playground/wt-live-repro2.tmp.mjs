import { chromium } from "@playwright/test";
import { readFileSync } from "node:fs";
const TOKEN = readFileSync(`${process.env.HOME}/.local/share/durable-pi/admin.token`, "utf8").trim();
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
await page.locator("input").last().fill("wt-fixcheck2");
await page.click("text=Create worktree session");
await page.waitForTimeout(12000);
const bodyText = await page.evaluate(() => document.body.textContent ?? "");
console.log("err shown:", (bodyText.match(/model must be[^.]*|Unknown model[^.]*/) ?? ["none"])[0]);
await browser.close();
