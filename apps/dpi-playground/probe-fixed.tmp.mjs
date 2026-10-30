import { chromium } from "playwright-core";
const b = await chromium.launch({ executablePath: "/usr/bin/google-chrome", args: ["--no-sandbox"] });
console.log("w×h | docScrolls | topbarTop | mnavBottom | vpH | chatScrollable");
for (const [w, h] of [[390, 844], [360, 740], [740, 1014], [600, 952]]) {
  const pg = await b.newPage({ viewport: { width: w, height: h } });
  await pg.goto("http://127.0.0.1:4203/", { waitUntil: "networkidle" });
  // simulate a long conversation inside the chat scroller
  await pg.evaluate(() => {
    const sc = document.querySelector(".chat-scroll") ?? document.querySelector(".welcome");
    if (sc) { sc.innerHTML = "<div style='height:4000px'>long conversation</div>"; sc.scrollTop = 0; }
  });
  const r = await pg.evaluate(async () => {
    window.scrollTo(0, 4000);
    await new Promise((r) => setTimeout(r, 120));
    const tb = document.querySelector(".topbar")?.getBoundingClientRect();
    const mn = document.querySelector(".mnav")?.getBoundingClientRect();
    const sc = document.querySelector(".chat-scroll");
    return {
      docScrolls: window.scrollY > 0,
      tbTop: tb ? Math.round(tb.top) : -1,
      mnBottom: mn ? Math.round(mn.bottom) : -1,
      vh: innerHeight,
      chatScrollable: sc ? sc.scrollHeight > sc.clientHeight : false,
      chatScrolled: sc ? sc.scrollTop : -1,
    };
  });
  // scroll the INTERNAL pane and confirm the bars stay put
  const r2 = await pg.evaluate(async () => {
    const sc = document.querySelector(".chat-scroll");
    if (sc) sc.scrollTop = 800;
    await new Promise((r) => setTimeout(r, 120));
    const tb = document.querySelector(".topbar")?.getBoundingClientRect();
    const mn = document.querySelector(".mnav")?.getBoundingClientRect();
    return { tbTop2: tb ? Math.round(tb.top) : -1, mnBottom2: mn ? Math.round(mn.bottom) : -1, scrolled: sc ? sc.scrollTop : -1 };
  });
  console.log(`${w}×${h} | ${r.docScrolls} | ${r.tbTop}/${r2.tbTop2} | ${r.mnBottom}/${r2.mnBottom2} | ${r.vh} | ${r.chatScrollable} (scrollTop ${r2.scrolled})`);
  await pg.close();
}
await b.close();
