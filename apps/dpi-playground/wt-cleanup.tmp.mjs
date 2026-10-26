import { chromium } from "@playwright/test";
import { readFileSync } from "node:fs";
const TOKEN = readFileSync(`${process.env.HOME}/.local/share/durable-pi/admin.token`, "utf8").trim();
const browser = await chromium.launch({ executablePath: "/usr/bin/google-chrome", headless: true });
const page = await browser.newPage({ viewport: { width: 1600, height: 1000 } });
page.on("response", (r) => r.url().endsWith("/v1/sessions/" ) === false && r.request().method() === "DELETE" && console.log(`[net] DELETE ${r.url().split("/api/")[1]} -> ${r.status()}`));
await page.goto("https://my-durable.phuongnb.io.vn/");
await page.locator(".login-veil input").fill(TOKEN);
await page.locator(".login-veil input").press("Enter");
await page.waitForTimeout(4000);
await page.evaluate(() => {
  const hit = [...document.querySelectorAll(".tree-row")].find((r) => r.querySelector(".name")?.textContent?.trim() === "wt-fixcheck");
  if (!hit) throw Error("wt-fixcheck row not found");
  hit.classList.add("probe-target");
});
await page.locator(".probe-target").hover();
await page.click(`.probe-target button[aria-label^="Archive session"]`);
await page.click("text=Archive session"); // the dialog's submit button
await page.waitForTimeout(3000);
const still = await page.evaluate(() => [...document.querySelectorAll(".tree-row .name")].some((n) => n.textContent?.trim() === "wt-fixcheck"));
console.log("wt-fixcheck still in live tree:", still);
await browser.close();
