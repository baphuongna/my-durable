import { chromium } from "playwright-core";
const b = await chromium.launch({ executablePath: "/usr/bin/google-chrome", args: ["--no-sandbox"] });
for (const w of [360, 412, 800]) {
  const pg = await b.newPage({ viewport: { width: w, height: 1700 }, hasTouch: true, isMobile: true });
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
          <tbody><tr><td>4</td><td>orca/workspaces/.../redis-scan-auto-payment-long-name</td><td>(detached HEAD)</td><td>3c33a</td></tr></tbody></table>
          <p><strong>Thay đổi so với lần check trước:</strong></p>
        </div></div>
      </section>`;
  });
  const r = await pg.evaluate(() => {
    const hdr = document.querySelector(".chat-header");
    const crumb = document.querySelector(".crumb-main");
    const tbl = document.querySelector(".markdown table");
    const hr = hdr.getBoundingClientRect();
    const tr = tbl.getBoundingClientRect();
    return {
      headerH: Math.round(hr.height),
      headerBg: getComputedStyle(hdr).backgroundColor,
      crumbVisible: crumb.getBoundingClientRect().right <= innerWidth,
      tableInScroll: tr.top >= hr.bottom - 2,
      tableScrollable: tbl.scrollWidth > tbl.clientWidth,
      hOverflow: document.documentElement.scrollWidth > innerWidth,
    };
  });
  console.log(`${w}px | header ${r.headerH}px bg:${r.headerBg} | crumb trong màn:${r.crumbVisible} | table dưới header:${r.tableInScroll} | table tự cuộn:${r.tableScrollable} | tràn trang:${r.hOverflow}`);
  await pg.close();
}
await b.close();
