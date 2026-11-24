// Screenshot the head-unit app through a real user flow (Playwright, headless Chromium).
//   node tools/ui-shots.mjs [base-url] [out-dir] [WxH]
// Default: http://127.0.0.1:18080  tools/shots  720x1280 (Touch Display 2, portrait)
import { createRequire } from "module";
const require = createRequire(import.meta.url);
const { chromium } = require(process.env.PLAYWRIGHT_DIR || "playwright");
const base = process.argv[2] || "http://127.0.0.1:18080";
const out = process.argv[3] || new URL("./shots", import.meta.url).pathname;
const [w, h] = (process.argv[4] || "720x1280").split("x").map(Number);
const tag = w > h ? "land" : "port";
const b = await chromium.launch({ args: ["--use-gl=angle", "--use-angle=swiftshader", "--enable-unsafe-swiftshader", "--ignore-gpu-blocklist"] });
const p = await b.newPage({ viewport: { width: w, height: h }, hasTouch: true });
const errs = []; p.on("pageerror", e => errs.push(e.message)); p.on("console", m => m.type() === "error" && errs.push(m.text()));
const shot = async n => { await p.screenshot({ path: `${out}/${tag}-${n}.png` }); console.log("shot", n); };
await p.goto(base + "/"); await p.waitForTimeout(600); await shot("1-home");
await p.click("#dock [data-go=maps]"); await p.waitForTimeout(4000); await shot("2-map");
await p.click("#q"); await p.waitForTimeout(300);
for (const ch of "leopoldstr") await p.click(`#kbd button:text-is("${ch}")`);
await p.waitForTimeout(1200); await shot("3-search");
await p.click("#search-results .row >> nth=0"); await p.waitForTimeout(4500); await shot("4-preview");
await p.click("#s-sim"); await p.waitForTimeout(7000); await shot("5-nav");
await p.waitForTimeout(12000); await shot("6-nav-later");
await p.click("#btn-stop"); await p.waitForTimeout(800);
await p.click("#dock [data-go=settings]"); await p.click("#st-nav button[data-cat=display]"); await p.waitForTimeout(600);
await p.click("#settings [data-ui-mode=dark]"); await p.waitForTimeout(400); await p.click("#dock [data-go=maps]"); await p.waitForTimeout(3000); await shot("7-night");
console.log(errs.length ? "PAGE ERRORS:\n" + errs.join("\n") : "no page errors");
await b.close();
