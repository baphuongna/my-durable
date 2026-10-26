// Live repro of the worktree-from-session flow against https://my-durable.phuongnb.io.vn
// using the NEW fixed bundle (index-6a3ATkAn.js).
import { chromium } from "@playwright/test";
import { readFileSync } from "node:fs";

const TOKEN = readFileSync(`${process.env.HOME}/.local/share/durable-pi/admin.token`, "utf8").trim();
const errors = [];

const browser = await chromium.launch({ executablePath: "/usr/bin/google-chrome", headless: true });
const page = await browser.newPage({ viewport: { width: 1600, height: 1000 } });
page.on("response", (r) => {
  if (r.url().includes("/v1/sessions") && r.request().method() === "POST")
    console.log(`[net] POST ${r.url().replace("https://my-durable.phuongnb.io.vn", "")} -> ${r.status()}`);
});
page.on("console", (m) => m.type() === "error" && errors.push(m.text()));

await page.goto("https://my-durable.phuongnb.io.vn/");
await page.locator(".login-veil input").fill(TOKEN);
await page.locator(".login-veil input").press("Enter");
await page.waitForTimeout(4000);

// Mark the 'usage-probe' row (walk up to .tree-row, add class probe-target)
await page.evaluate(() => {
  const rows = [...document.querySelectorAll(".tree-row")];
  const hit = rows.find((r) => r.querySelector(".name")?.textContent?.trim() === "usage-probe");
  if (!hit) throw Error("usage-probe row not found; rows=" + rows.length);
  hit.classList.add("probe-target");
  return true;
});
const row = page.locator(".probe-target");
await row.hover();
await page.click(`.probe-target button[aria-label^="New worktree session from"]`);
await page.locator("input").last().fill("wt-fixcheck");
await page.click("text=Create worktree session");
await page.waitForTimeout(12000);

// Assert: a session with cwd containing gitdemo-wt-fixcheck exists + no 'model must be' error
const bodyText = await page.evaluate(() => document.body.textContent ?? "");
const net = await page.evaluate(async () => {
  const r = await fetch("/api/devices/1e2e23fcd30b49c4ba1ffa2151816bd3/v1/sessions", {
    headers: { authorization: `Bearer ${localStorage.getItem("dpi.admin.token") ?? ""}` },
  });
  return { status: r.status, sessions: (await r.json()).sessions?.map((s) => `${s.name}|${s.cwd}`) };
});
const created = (net.sessions ?? []).filter((s) => s.includes("gitdemo-wt-fixcheck"));
console.log("bundle:", await page.evaluate(() => [...document.scripts].map((s) => s.src).join(" ")));
console.log("sidebar has wt-fixcheck:", bodyText.includes("wt-fixcheck"));
console.log("message-error 'model must be':", /model must be/.test(bodyText) ? "PRESENT (FAIL)" : "absent (PASS)");
console.log("created session(s):", JSON.stringify(created, null, 2));
console.log("console errors:", errors.length ? errors.slice(0, 3) : "none");
await page.screenshot({ path: "/tmp/wt-fixcheck-live.png", fullPage: false });
await browser.close();
if (!created.length) process.exit(1);
