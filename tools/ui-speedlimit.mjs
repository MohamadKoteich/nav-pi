// Simulated drive with the speed-limit sign and over-speed warning (PN-42/43), headless Chromium.
//   node tools/ui-speedlimit.mjs [base-url] [out-dir] [WxH]
// Needs a served build (tools/build_edition.py + navd.py with VALHALLA_URL set; see docs/TESTING.md) at base-url.
// Map tiles are optional here: tile/font fetch errors are ignored, everything else counts as a page error.
import { createRequire } from "module";
const require = createRequire(import.meta.url);
const { chromium } = require(process.env.PLAYWRIGHT_DIR || "playwright");
const base = process.argv[2] || "http://127.0.0.1:18080";
const out = process.argv[3] || new URL("./shots", import.meta.url).pathname;
const [w, h] = (process.argv[4] || "720x1280").split("x").map(Number);
const tag = w > h ? "land" : "port";
const b = await chromium.launch({ args: ["--use-gl=angle", "--use-angle=swiftshader", "--enable-unsafe-swiftshader", "--ignore-gpu-blocklist"] });
const p = await b.newPage({ viewport: { width: w, height: h }, hasTouch: true });
const errs = [];
p.on("pageerror", e => errs.push(e.message));
p.on("console", m => m.type() === "error" && !/tiles|fonts|glyphs|502|404|api\/display/.test(m.text() + (m.location().url || "")) && errs.push(m.text()));
const shot = async n => { await p.screenshot({ path: `${out}/${tag}-limit-${n}.png` }); console.log("shot", n); };
await p.addInitScript(() => localStorage.setItem("navpi.overspeed", JSON.stringify({ mode: "sound", thr: 0 })));
await p.goto(base + "/"); await p.waitForTimeout(600);
await p.click("#dock [data-go=maps]"); await p.waitForTimeout(2500);
await p.evaluate(() => window.__map.jumpTo({ center: [11.6000, 48.1200], zoom: 14 }));
await p.evaluate(() => Maps.preview({ name: "Test", ctx: "Simulated", lat: 48.0770, lon: 11.9700 }));
await p.waitForTimeout(3500); await shot("1-preview");
await p.click("#s-sim"); await p.waitForTimeout(6000);
const sign = async () => p.evaluate(() => ({ hidden: document.getElementById("t-limit").hidden, limit: document.querySelector("#t-limit b").textContent,
  speed: document.getElementById("t-speed").textContent, over: document.querySelector("#speedo .speed").classList.contains("over") }));
const seen = [];
for (let i = 0; i < 14; i++) { seen.push(await sign()); if (i === 3 || i === 9) await shot("2-nav-" + i); await p.waitForTimeout(2500); }
console.log("samples:", JSON.stringify(seen.map(s => s.hidden ? "-" : `${s.speed}/${s.limit}${s.over ? "!" : ""}`)));
if (!seen.some(s => !s.hidden)) errs.push("speed-limit sign never shown");
// force the over-speed state (the recorded stretch never exceeds its limit): the real simulated speed against a 30 zone
let chimes = 0; p.on("request", r => /api\/chime/.test(r.url()) && chimes++);
await p.evaluate(() => { SpeedLimits.at = () => 30; });
await p.waitForTimeout(3500); await shot("4-over");
const o = await sign(); console.log("forced zone:", JSON.stringify(o), "chime requests:", chimes);
if (!o.over || chimes !== 1) errs.push("over-speed state / single chime not seen");
// settings card
await p.click("#btn-stop"); await p.waitForTimeout(500);
await p.click("#dock [data-go=settings]"); await p.click("#st-nav button[data-cat=nav]"); await p.waitForTimeout(800);
await p.evaluate(() => document.getElementById("os-mode").scrollIntoView()); await p.waitForTimeout(300); await shot("3-settings");
console.log(errs.length ? "PAGE ERRORS:\n" + errs.join("\n") : "no page errors");
await b.close();
process.exit(errs.length ? 1 : 0);
