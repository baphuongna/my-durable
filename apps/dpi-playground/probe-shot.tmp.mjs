import { chromium } from "playwright-core";
const b = await chromium.launch({ executablePath: "/usr/bin/google-chrome", args: ["--no-sandbox"] });
// 800×1900 ≈ Samsung Internet CSS viewport của ảnh user; touch
const pg = await b.newPage({ viewport: { width: 800, height: 1700 }, hasTouch: true, isMobile: true });
await pg.goto("http://127.0.0.1:4203/", { waitUntil: "networkidle" });
// dựng đúng cấu trúc màn session: rail inspector + chat markdown
await pg.evaluate(() => {
  const ws = document.querySelector(".net-workspace");
  ws.innerHTML = `
    <aside class="inspector collapsed"><div class="panel-rail"><button class="rail-tab">A</button></div></aside>
    <section class="chat-panel">
      <header class="chat-header">
        <div class="lineage-picker"><nav class="crumbs conversation-lineage">
          <button class="crumb"><span class="crumb-main"><span class="device-chip">PhuongNB-Laptop</span></span></button>
        </nav></div>
        <div class="chat-header-actions"><button class="icon-button">✎</button></div>
      </header>
      <div class="chat-scroll"><div class="markdown"><p><strong>Worktree chính</strong> đã chuyển từ <code>master</code> sang <code>hotfix/phuongnb/261026-clp-14419</code> — đang làm hotfix CLP-14419</p></div></div>
    </section>`;
});
const r = await pg.evaluate(() => {
  const rail = document.querySelector(".inspector");
  const railR = rail.getBoundingClientRect();
  const crumb = document.querySelector(".crumb-main");
  const md = document.querySelector(".markdown p");
  const chat = document.querySelector(".chat-scroll");
  return {
    railVisible: rail.getClientRects().length > 0 && getComputedStyle(rail).display !== "none",
    railWidth: Math.round(railR.width),
    crumbPx: Math.round(parseFloat(getComputedStyle(crumb).fontSize)),
    mdPx: Math.round(parseFloat(getComputedStyle(md).fontSize) * 10) / 10,
    chatWidth: Math.round(chat.getBoundingClientRect().width),
  };
});
console.log(`800px touch: rail visible=${r.railVisible} (${r.railWidth}px) | crumb ${r.crumbPx}px | markdown ${r.mdPx}px | chat rộng ${r.chatWidth}px`);
await pg.screenshot({ path: "/tmp/fe-shot/session-800-fixed.png" });
await b.close();
