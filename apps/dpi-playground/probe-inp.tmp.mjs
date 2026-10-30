import { chromium } from "playwright-core";
const b = await chromium.launch({ executablePath: "/usr/bin/google-chrome", args: ["--no-sandbox"] });
for (const noZoom of [false, true]) {
  const pg = await b.newPage({ viewport: { width: 390, height: 844 } });
  await pg.goto("http://127.0.0.1:4203/", { waitUntil: "networkidle" });
  if (noZoom) await pg.addStyleTag({ content: ":root { zoom: 1 !important; }" });
  const r = await pg.evaluate(() => {
    const z = parseFloat(getComputedStyle(document.documentElement).zoom || "1") || 1;
    const i = document.createElement("input");
    document.querySelector(".net-workspace").appendChild(i);
    const idle = parseFloat(getComputedStyle(i).fontSize) * z;
    i.focus();
    const focused = parseFloat(getComputedStyle(i).fontSize); // computed — what iOS reads
    const focusedRendered = focused * z;
    i.blur();
    const body = parseFloat(getComputedStyle(document.body).fontSize) * z;
    return { idle: Math.round(idle * 10) / 10, focusedComputed: focused, focusedRendered: Math.round(focusedRendered * 10) / 10, body: Math.round(body * 10) / 10 };
  });
  console.log(`${noZoom ? "NO-zoom" : "zoom   "} | input idle ${r.idle}px | focus computed ${r.focusedComputed}px (rendered ${r.focusedRendered}px) | body text ${r.body}px | đồng bộ: ${Math.abs(r.idle - r.body) < 1.5}`);
  await pg.close();
}
await b.close();
