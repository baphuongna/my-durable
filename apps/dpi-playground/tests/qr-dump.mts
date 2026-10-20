const { qrMatrix } = await import("../apps/dpi-playground-fe/src/client/qrcode.js");
const payloads = JSON.parse(process.argv[2] ?? "[]") as string[];
const out: string[] = [];
for (const p of payloads) {
  for (let mask = 0; mask < 8; mask++) {
    const m = qrMatrix(p, mask);
    out.push(m.map((r) => r.map((v) => (v ? "1" : "0")).join("")).join("\n"));
  }
}
console.log("===8<===");
console.log(out.join("\n===\n"));
