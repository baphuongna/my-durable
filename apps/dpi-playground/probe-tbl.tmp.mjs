import { chromium } from "playwright-core";
const b = await chromium.launch({ executablePath: "/usr/bin/google-chrome", args: ["--no-sandbox"] });
const pg = await b.newPage({ viewport: { width: 800, height: 1700 }, hasTouch: true, isMobile: true });
await pg.goto("http://127.0.0.1:4203/", { waitUntil: "networkidle" });
await pg.evaluate(() => {
  const ws = document.querySelector(".net-workspace");
  ws.innerHTML = `
    <section class="chat-panel">
      <header class="chat-header">
        <div class="lineage-picker"><nav class="crumbs conversation-lineage">
          <button class="crumb"><span class="crumb-main"><span class="device-chip">PhuongNB-Laptop</span></span></button>
          <button class="crumb"><span class="crumb-main"><span class="crumb-name">New session</span></span></button>
        </nav></div>
        <div class="chat-header-actions"><button class="icon-button">✎</button><button class="icon-button">⌄</button></div>
      </header>
      <div class="chat-scroll"><div class="markdown">
        <table><thead><tr><th>#</th><th>worktree</th><th>HEAD</th><th>commit</th></tr></thead>
        <tbody><tr><td>4</td><td>orca/workspaces/.../redis-scan-auto-payment</td><td>(detached HEAD)</td><td>3c33a</td></tr></tbody></table>
        <p><strong>Thay đổi so với lần check trước:</strong></p>
      </div></div>
    </section>`;
});
const r = await pg.evaluate(() => {
  const hdr = document.querySelector(".chat-header");
  const scr = document.querySelector(".chat-scroll");
  const tbl = scr.querySelector("table");
  const hr = hdr.getBoundingClientRect();
  const tr = tbl.getBoundingClientRect();
  const hdrCs = getComputedStyle(hdr);
  return {
    headerBg: hdrCs.backgroundColor,
    headerPos: hdrCs.position, headerZ: hdrCs.zIndex,
    headerRect: `${Math.round(hr.top)}..${Math.round(hr.bottom)}`,
    tableTop: Math.round(tr.top),
    OVERLAP: tr.top < hr.bottom && tr.bottom > hr.top,
    scrollPaddingTop: getComputedStyle(scr).paddingTop,
  };
});
console.log(JSON.stringify(r, null, 1));
await pg.screenshot({ path: "/tmp/fe-shot/repro-table.png" });
await b.close();
