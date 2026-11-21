import fs from "node:fs";
import path from "node:path";

const url = process.argv[2];
const out = process.argv[3];

const res = await fetch(url, { redirect: "follow" });
if (!res.ok) { console.error("HTTP", res.status); process.exit(1); }
const total = Number(res.headers.get("content-length") || 0);
let got = 0, lastPct = -1;
const f = fs.createWriteStream(out);
for await (const chunk of res.body) {
  got += chunk.length;
  f.write(chunk);
  if (total) {
    const pct = Math.floor(got / total * 100);
    if (pct !== lastPct && pct % 10 === 0) { console.log(pct + "%  " + (got / 1048576).toFixed(1) + " MB"); lastPct = pct; }
  }
}
await new Promise(r => f.end(r));
console.log("done bytes=" + got + " -> " + out);
