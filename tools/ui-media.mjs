// Media + layout flow (Playwright): start screen, Media sources, audiobook play + resume, Settings from the dock, back.
//   node tools/ui-media.mjs [base-url] [out-dir] [WxH]
import { createRequire } from "module";
const require = createRequire(import.meta.url);
const { chromium } = require(process.env.PLAYWRIGHT_DIR || "playwright");
const base = process.argv[2] || "http://127.0.0.1:18080";
const out = process.argv[3] || new URL("./shots", import.meta.url).pathname;
const [w, h] = (process.argv[4] || "1280x720").split("x").map(Number);
const b = await chromium.launch({ args: ["--use-angle=swiftshader", "--enable-unsafe-swiftshader", "--autoplay-policy=no-user-gesture-required"] });
const p = await b.newPage({ viewport: { width: w, height: h } });
const errs = []; p.on("pageerror", e => errs.push(e.message)); p.on("console", m => m.type() === "error" && !/\/api\/display$/.test(m.location().url || "") && errs.push(m.text()));   // 409 = no backlight on a PC
const shot = async n => { await p.screenshot({ path: `${out}/media-${n}.png` }); };
const check = (name, ok) => console.log((ok ? "PASS " : "FAIL ") + name);
await p.goto(base + "/"); await p.waitForTimeout(2500);
check("starts on Maps", await p.evaluate(() => document.querySelector(".view.active").id === "maps"));
// rail order (features/core/shell.js): Maps, Places, Media, Trips, GPS, then other apps, Settings always last
check("dock = Maps, Places, Media, Trips, GPS, Settings", (await p.$$eval("#dock button", bs => bs.map(b => b.dataset.go).join(","))) === "maps,places,media,trip,gps,settings");
await shot("1-start");
await p.click("#q"); await p.waitForTimeout(400);
check("recents shown on focus", await p.isVisible("#search-results.open"));
await p.click("#kbd button.w >> nth=0"); await p.click("#q-clear");
await p.click("#dock [data-go=media]"); await p.waitForTimeout(1200); await shot("2-media-phone");
await p.click('.srcs [data-src="Audiobooks"]'); await p.waitForTimeout(600);
await p.click("#m-body .row >> nth=0"); await p.waitForTimeout(600); await shot("3-book");
await p.click("#m-body .row >> nth=1"); await p.waitForTimeout(2500);         // [0] = back, [1] = chapter 1
const t1 = await p.evaluate(() => document.getElementById("p-cur").textContent);
check("audiobook plays (time " + t1 + ")", t1 !== "0:00");
check("now-playing chip in status bar", await p.isVisible("#np-chip"));
await p.click("#p-fwd"); await p.waitForTimeout(500);
await shot("4-player");
await p.click("#np-chip"); await p.waitForTimeout(500);                       // pause via status bar
await p.click('.srcs [data-src="Music"]'); await p.waitForTimeout(400); await p.click('.srcs [data-src="Audiobooks"]'); await p.waitForTimeout(400);
await p.click("#m-body .row >> nth=0"); await p.waitForTimeout(600);
check("resume offered", (await p.textContent("#m-body .row >> nth=1")).includes(await p.evaluate(() => T("media.continue"))));
await shot("5-resume");
check("no quick panel / chevron (status bar = information only)", await p.locator("#qs, #qs-btn").count() === 0);
await p.click("#dock [data-go=settings]"); await p.waitForTimeout(800);
check("dock Settings opens settings", await p.evaluate(() => document.querySelector(".view.active").id === "settings"));
check("dock marks Settings", await p.evaluate(() => document.querySelector("#dock [data-go=settings]").classList.contains("active")));
await shot("7-settings");
await p.click("#settings-back"); await p.waitForTimeout(500);
check("back returns to media", await p.evaluate(() => document.querySelector(".view.active").id === "media"));
// a pull-down on the status bar changes nothing any more (2026-11-22)
await p.mouse.move(w * 0.3, 20); await p.mouse.down(); await p.mouse.move(w * 0.3, 160, { steps: 8 }); await p.mouse.up(); await p.waitForTimeout(600);
check("pull-down on the status bar: still on media", await p.evaluate(() => document.querySelector(".view.active").id === "media"));
console.log(errs.length ? "PAGE ERRORS:\n" + errs.join("\n") : "no page errors");
await b.close();
