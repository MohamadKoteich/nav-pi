// Walk the real head unit over CDP and screenshot each step (needs the ssh tunnel to port 9222).
//   node tools/device-flow.mjs [query] [out-dir]
import { createRequire } from "module";
const require = createRequire(import.meta.url);
const { chromium } = require(process.env.PLAYWRIGHT_DIR || "playwright");
const q = process.argv[2] || "munchen";
const out = process.argv[3] || new URL("./shots", import.meta.url).pathname;
const b = await chromium.connectOverCDP(process.env.CDP || "http://127.0.0.1:19222");
const p = b.contexts()[0].pages()[0];
await p.goto("http://127.0.0.1:8080/?kiosk=1"); await p.waitForTimeout(1500);
const shot = async n => { await p.screenshot({ path: `${out}/device-${n}.png` }); console.log("shot", n); };
await shot("a-home");
await p.click("#dock [data-go=maps]"); await p.waitForTimeout(3000);
await p.click("#q"); await p.waitForTimeout(300);
const t0 = Date.now();
for (const ch of q) await p.click(ch === " " ? "#kbd button.sp" : `#kbd button:text-is("${ch}")`);
await p.waitForSelector("#search-results.open .row, #search-results.open .empty", { timeout: 10000 });
console.log("search results after last key:", Date.now() - t0, "ms (incl. typing)");
await shot("b-search");
if (process.env.ROUTE) {
  await p.click("#search-results .row >> nth=0"); await p.waitForSelector("#sheet.open", { timeout: 20000 }); await p.waitForTimeout(1500);
  await shot("c-preview");
  await p.click("#s-sim"); await p.waitForTimeout(8000); await shot("d-nav");
  await p.click("#btn-stop");
}
await b.close();
