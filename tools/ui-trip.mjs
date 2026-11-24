// Trip computer + trip log (PN-49/50): simulated drive feeds the counters, trip is logged, replay on the map, GPX.
//   node tools/ui-trip.mjs [base-url] [out-dir] [WxH]
// Needs a served build + navd with NAV_TRIP_SIM=1 TRIP_END_IDLE=8 TRIP_MEDIA=<dir with a STICK subdir>, VALHALLA_URL set
// (sim positions are only counted in that test mode). Map tiles are optional: tile/font errors are ignored.
import { createRequire } from "module";
const require = createRequire(import.meta.url);
const { chromium } = require(process.env.PLAYWRIGHT_DIR || "playwright");
const base = process.argv[2] || "http://127.0.0.1:18091";
const out = process.argv[3] || new URL("./shots", import.meta.url).pathname;
const [w, h] = (process.argv[4] || "720x1280").split("x").map(Number);
const tag = w > h ? "land" : "port";
const b = await chromium.launch({ args: ["--use-gl=angle", "--use-angle=swiftshader", "--enable-unsafe-swiftshader", "--ignore-gpu-blocklist"] });
const p = await b.newPage({ viewport: { width: w, height: h }, hasTouch: true });
const errs = [];
p.on("pageerror", e => errs.push(e.message));
p.on("console", m => m.type() === "error" && !/tiles|fonts|glyphs|502|404|api\/display/.test(m.text() + (m.location().url || "")) && errs.push(m.text() + " @ " + m.location().url));
let fails = 0;
const check = (n, ok) => { if (!ok) { fails++; errs.push("FAIL " + n); } console.log((ok ? "PASS " : "FAIL ") + n); };
const shot = async n => { await p.screenshot({ path: `${out}/${tag}-trip-${n}.png` }); console.log("shot", n); };
const api = path => p.evaluate(u => fetch(u).then(r => r.json()), path);

await p.goto(base + "/"); await p.waitForTimeout(600);
await p.waitForTimeout(500);
if (await p.locator("#dock [data-go=maps]").isVisible()) await p.click("#dock [data-go=maps]");
await p.waitForTimeout(2500);
await p.evaluate(() => window.__map.jumpTo({ center: [11.6000, 48.1200], zoom: 14 }));
await p.evaluate(() => Maps.preview({ name: "Test", ctx: "Simulated", lat: 48.0770, lon: 11.9700 }));
await p.waitForTimeout(3500);
await p.click("#s-sim");
await p.waitForTimeout(80000);                                  // > 60 s driving: long enough to be kept as a trip
const mid = await api("/api/trip");
console.log("counters while driving:", JSON.stringify(mid.a), JSON.stringify(mid.b));
check("distance counts", mid.a.dist > 300 && mid.b.dist > 300);
check("driving time counts", mid.a.drive > 60);
check("max speed above average", mid.a.vmax >= mid.a.avg && mid.a.avg > 10);
check("recording", mid.recording === true);
await p.click("#dock [data-go=trip]"); await p.waitForTimeout(900);
await shot("2-settings");
const tile = await p.textContent("#trip-card .trip-ctr[data-c=a]");
check("Trips page (rail) shows trip A", /km/.test(tile));
// stop driving: the recording ends after TRIP_END_IDLE
await p.click("#dock [data-go=maps]"); await p.waitForTimeout(500);
await p.click("#btn-stop").catch(() => {});
await p.waitForTimeout(12000); await api("/api/trip");
await p.waitForTimeout(500);
const list = (await api("/api/trips")).trips;
console.log("trips:", JSON.stringify(list.map(t => ({ id: t.id, dist: t.dist, dur: t.dur, n: t.n, sim: t.sim }))));
check("trip logged", list.length === 1 && list[0].sim && list[0].n > 20);
// PN-49 follow-up: maps.js fires navpi:dest at Go, trip.js passes it on: the log knows where the drive went
check("trip log names: " + list[0].from + " -> " + list[0].to, list[0].to === "Test" && !!list[0].from);
const gpx = await p.evaluate(u => fetch(u).then(r => r.text()), "/api/trips/" + list[0].id + ".gpx");
check("gpx served", gpx.startsWith("<?xml") && gpx.includes("<trkpt"));
await p.click("#dock [data-go=trip]"); await p.waitForTimeout(1200);
await p.evaluate(() => document.getElementById("trips-card").scrollIntoView()); await p.waitForTimeout(300);
await shot("3-log");
const usb = await p.locator("#trips-list .btn", { hasText: /USB/ }).first();
await usb.click(); await p.waitForTimeout(600);
check("gpx written to the stick", (await p.evaluate(() => document.querySelector("#toast, .toast") ? document.querySelector("#toast, .toast").textContent : "")).includes(".gpx"));
await p.locator("#trips-list .btn.primary").first().click(); await p.waitForTimeout(2500);
await shot("4-replay-a");
await p.waitForTimeout(8000);
await shot("5-replay-b");
const lay = await p.evaluate(() => ["trip-line", "trip-done", "trip-dot"].map(i => !!window.__map.getLayer(i)));
check("replay layers on the map", lay.every(Boolean));
await p.click("#tr-close"); await p.waitForTimeout(400);
check("replay cleaned up", await p.evaluate(() => !window.__map.getLayer("trip-line") && !window.__map.getSource("trip-dot")));
// reset
await p.evaluate(() => fetch("/api/trip/reset", { method: "POST", body: JSON.stringify({ which: "b" }) }));
const after = await api("/api/trip");
check("Trip B reset, Trip A kept", after.b.dist === 0 && after.a.dist > 300);
console.log(errs.length ? "PAGE ERRORS / FAILS:\n" + errs.join("\n") : "no page errors");
await b.close();
process.exit(errs.length ? 1 : 0);
