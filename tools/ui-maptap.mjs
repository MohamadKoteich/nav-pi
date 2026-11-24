// Map gestures (PN-MAPTAP-01, 2026-11-22: "the drive here appears as soon as I click on the map ... it should
// only appear if I long press"). Playwright against a local navd with real routing (see tools/ui-routes.mjs header):
//   browse: a mouse tap, a touch tap and a two-finger tap open nothing and add no marker; a pan (drag) opens nothing;
//   a mouse long press and a touch long press open the place sheet;
//   preview (Munich -> Ingolstadt): a tap beside the route opens nothing, a tap on the grey alternative line selects it;
//   simulated drive (#s-sim): a tap opens nothing, a long press opens the sheet with Add stop (no Start/Park here),
//   and Add stop re-routes the drive through the pressed point.
//   node tools/ui-maptap.mjs [base-url] [out-dir] [WxH]
import { createRequire } from "module";
const require = createRequire(import.meta.url);
const { chromium } = require(process.env.PLAYWRIGHT_DIR || "playwright");
const base = process.argv[2] || "http://127.0.0.1:18080";
const out = process.argv[3] || new URL("./shots", import.meta.url).pathname;
const [w, h] = (process.argv[4] || "1280x720").split("x").map(Number);
const tag = `${w}x${h}`;
const b = await chromium.launch({ args: ["--use-angle=swiftshader", "--enable-unsafe-swiftshader", "--ignore-gpu-blocklist"] });
let fails = 0, n = 0;
const check = (name, ok) => { n++; if (!ok) fails++; console.log((ok ? "PASS " : "FAIL ") + name); };

const ctx = await b.newContext({ viewport: { width: w, height: h }, hasTouch: true });
const p = await ctx.newPage();
const errs = [], routes = [];
p.on("pageerror", e => errs.push(e.message));
p.on("request", r => { if (r.url().endsWith("/api/route")) routes.push(JSON.parse(r.postData())); });
await p.addInitScript(fix => {   // a GPS fix at Marienplatz, Munich, once a second (no receiver on the build box)
  const ES = window.EventSource;
  window.EventSource = function (url) {
    if (!String(url).includes("/api/gps")) return new ES(url);
    const es = { close() {} };
    setInterval(() => es.onmessage && es.onmessage({ data: JSON.stringify({ receiver: true, mode: 3, lat: fix[0], lon: fix[1], speed: 0, track: 0 }) }), 1000);
    return es;
  };
}, [48.1371, 11.5754]);
await p.goto(base + "/");
await p.waitForFunction(() => window.__map && window.__map.loaded(), null, { timeout: 30000 });
await p.waitForTimeout(1500);
const cdp = await ctx.newCDPSession(p);
const shot = name => p.screenshot({ path: `${out}/maptap-${tag}-${name}.png`, timeout: 90000 }).catch(e => console.log("shot skipped " + e.message.split("\n")[0]));
const isOpen = sel => p.$eval(sel, e => e.classList.contains("open"));
const markers = () => p.$$eval(".maplibregl-marker", m => m.length);
const state = () => p.evaluate(() => Maps.ctx().state);
const touch = (type, pts) => cdp.send("Input.dispatchTouchEvent", { type, touchPoints: pts.map(([x, y], id) => ({ x, y, id })) });
// a free spot on the map canvas (not under a card, button, sheet or marker)
const free = (fx, fy) => p.evaluate(([fx, fy]) => {
  const c = __map.getCanvas();
  for (let dy = 0; dy < 0.5; dy += 0.05) for (let dx = 0; dx < 0.5; dx += 0.05) {
    const x = innerWidth * Math.min(0.95, fx + dx), y = innerHeight * Math.min(0.95, fy + dy);
    if (document.elementFromPoint(x, y) === c) return [x, y];
  }
  return null;
}, [fx, fy]);
await p.evaluate(() => { window.__press = []; let t0 = 0;   // how long each press really lasted in the page
  addEventListener("pointerdown", e => { if (e.isPrimary) t0 = e.timeStamp; }, true);
  addEventListener("pointerup", e => { if (e.isPrimary) window.__press.push(e.timeStamp - t0); }, true); });
async function nothingAfter(what, act, [x, y], tries = 3) {
  if (await isOpen("#pick")) { await p.click("#p-cancel"); await p.waitForTimeout(250); }   // each check starts clean
  const m0 = await markers(), pk0 = await p.evaluate(() => Maps.picked());
  const n0 = await p.evaluate(() => window.__press.length);
  await act(x, y); await p.waitForTimeout(900);   // longer than the long press
  // a busy build box can stretch an 80 ms tap past the 500 ms long press: that run did not test a tap, try again
  const held = await p.evaluate(n => Math.max(0, ...window.__press.slice(n)), n0);
  if (held > 420 && tries > 1) {
    console.log(`note ${what}: the page saw a ${Math.round(held)} ms press (box busy), again`);
    if (await isOpen("#pick")) { await p.click("#p-cancel"); await p.waitForTimeout(250); }
    return nothingAfter(what, act, [x, y], tries - 1);
  }
  const pick = await isOpen("#pick"), m1 = await markers(), pk1 = await p.evaluate(() => Maps.picked());
  // while driving, the map adds/removes its own markers (cameras, stops ahead): there the pressed point is the proof
  const markOk = (await state()) === "nav" ? JSON.stringify(pk0) === JSON.stringify(pk1) : m1 === m0;
  check(`${what}: no place sheet, no new marker (sheet ${pick ? "OPEN" : "closed"}, markers ${m0}->${m1})`, !pick && markOk);
}
const mouseTap = async (x, y) => { await p.mouse.click(x, y); };
const touchTap = async (x, y) => { await Promise.all([touch("touchStart", [[x, y]]), touch("touchEnd", [])]); };   // down + up queued together
const mouseLong = async (x, y) => { await p.mouse.move(x, y); await p.mouse.down(); await p.waitForTimeout(800); await p.mouse.up(); await p.waitForTimeout(250); };
const touchLong = async (x, y) => { await touch("touchStart", [[x, y]]); await p.waitForTimeout(800); await touch("touchEnd", []); await p.waitForTimeout(250); };

// ---------- browse ----------
let pt = await free(0.55, 0.45);
check("browse: free map spot found " + JSON.stringify(pt), !!pt && (await state()) === "browse");
await shot("browse-before");
await nothingAfter("browse mouse tap", mouseTap, pt);
await nothingAfter("browse touch tap", touchTap, pt);
await nothingAfter("browse two-finger tap", async (x, y) => { await touch("touchStart", [[x, y], [x + 120, y + 40]]); await p.waitForTimeout(700); await touch("touchEnd", []); }, pt, 1);
await nothingAfter("browse double tap", async (x, y) => { await p.mouse.dblclick(x, y); }, pt);
await nothingAfter("browse pan (mouse drag)", async (x, y) => {
  await p.mouse.move(x, y); await p.mouse.down(); await p.mouse.move(x + 140, y + 60, { steps: 12 }); await p.waitForTimeout(700); await p.mouse.up();
}, pt, 1);
await nothingAfter("browse pan (touch drag, then held still 700 ms)", async (x, y) => {
  const moves = [touch("touchStart", [[x, y]])];
  for (let i = 1; i <= 8; i++) moves.push(touch("touchMove", [[x - 15 * i, y - 6 * i]]));
  await Promise.all(moves); await p.waitForTimeout(700); await touch("touchEnd", []);
}, pt, 1);
await shot("browse-after-taps");
pt = await free(0.55, 0.45);
await mouseLong(...pt);
check("browse mouse long press: place sheet with Drive here", await isOpen("#pick") && await p.isVisible("#p-dest") && await p.$eval("#p-stop", e => e.hidden));
await shot("browse-longpress");
await p.click("#p-cancel"); await p.waitForTimeout(250);
await touchLong(...pt);
check("browse touch long press: place sheet", await isOpen("#pick"));
await p.click("#p-cancel"); await p.waitForTimeout(250);

// ---------- preview with alternatives ----------
await p.click("#q"); await p.waitForTimeout(300);
for (const ch of "ingolstadt") await p.click(`#kbd button:text-is("${ch}")`);
await p.waitForTimeout(1500);
let r0 = routes.length;
await p.click("#search-results .row:has(.c.num) >> nth=0");
await p.waitForFunction(n => document.querySelectorAll("#s-alts .alt").length >= 2 || false, r0, { timeout: 30000 }).catch(() => {});
await p.waitForTimeout(1200);
check("preview open with alternatives", (await state()) === "preview" && (await p.$$("#s-alts .alt")).length >= 2);
pt = await free(0.6, 0.25);
if (pt) await nothingAfter("preview tap beside the route", mouseTap, pt);
check("preview: sheet still open after the tap", await isOpen("#sheet"));
await p.click("#s-alts .alt >> nth=1"); await p.waitForTimeout(1200);
const altPt = await p.evaluate(() => {   // the visible grey point farthest from the blue route (as in ui-routes.mjs C)
  const m = __map, sh = document.getElementById("sheet").getBoundingClientRect(), c = m.getContainer().getBoundingClientRect();
  const pts = l => m.queryRenderedFeatures({ layers: [l] }).flatMap(f => f.geometry.type === "LineString" ? f.geometry.coordinates : f.geometry.coordinates.flat()).map(x => m.project(x));
  const main = pts("route-line"); let best = null;
  for (const q of pts("route-alt-line")) {
    const x = q.x + c.left, y = q.y + c.top;
    if (x < c.left + 30 || x > c.right - 30 || y < c.top + 120 || y > c.bottom - 30) continue;
    if (x >= sh.left - 20 && x <= sh.right + 20 && y >= sh.top - 20) continue;
    if (document.elementFromPoint(x, y) !== m.getCanvas()) continue;
    const d = Math.min(...main.map(r => Math.hypot(r.x - q.x, r.y - q.y)));
    if (d >= 14 && (!best || d > best.d)) best = { x, y, d };
  }
  return best;
});
for (let i = 0; altPt && i < 3; i++) {   // a busy box can stretch the click into a long press (= place sheet): again
  const n0 = await p.evaluate(() => window.__press.length);
  await p.mouse.click(altPt.x, altPt.y);
  const held = await p.evaluate(n => Math.max(0, ...window.__press.slice(n)), n0);
  if (held < 420) break;
  console.log(`note alt tap: the page saw a ${Math.round(held)} ms press (box busy), again`);
  if (await isOpen("#pick")) { await p.click("#p-cancel"); await p.waitForTimeout(250); }
  await p.click("#s-alts .alt >> nth=1"); await p.waitForTimeout(800);
}
// MapLibre fires the layer click a frame after the mouse-up; on a loaded box (swiftshader, load 20-40) that frame came
// after an immediate read (2026-11-22 integration: failed 2 of 3 runs on the merged build, passed with any delay)
if (altPt) await p.waitForFunction(() => document.querySelector("#s-alts .alt:nth-child(1)")?.getAttribute("aria-checked") === "true", null, { timeout: 3000 }).catch(() => {});
check("preview: tap on the grey alternative line still selects it", !!altPt && (await p.$eval("#s-alts .alt:nth-child(1)", e => e.getAttribute("aria-checked"))) === "true" && !(await isOpen("#pick")));
await shot("preview");

// ---------- simulated drive ----------
await p.click("#s-sim"); await p.waitForTimeout(2500);
check("simulated drive running", (await state()) === "nav" && await isOpen("#banner"));
pt = await free(0.6, 0.3);
check("drive: free map spot found " + JSON.stringify(pt), !!pt);
await nothingAfter("drive mouse tap", mouseTap, pt);
await nothingAfter("drive touch tap", touchTap, pt);
check("drive: still guiding after the taps", (await state()) === "nav");
await shot("drive-after-tap");
pt = await free(0.6, 0.3);
await mouseLong(...pt);
check("drive long press: place sheet with Add stop, no Start/Park here",
  await isOpen("#pick") && !(await p.$eval("#p-stop", e => e.hidden)) && await p.$eval("#p-start", e => e.hidden) && await p.$eval("#p-park", e => e.hidden));
await shot("drive-longpress");
r0 = routes.length;
await p.click("#p-stop");
await p.waitForFunction(n => true, null).catch(() => {});
for (let i = 0; i < 60 && routes.length === r0; i++) await p.waitForTimeout(250);
await p.waitForTimeout(1500);
const last = routes.at(-1);
check("drive: Add stop re-routes through the pressed point (break location)", routes.length > r0 && last.locations.some(l => l.type === "break") && (await state()) === "nav");
await p.click("#btn-stop").catch(() => {}); await p.waitForTimeout(400);

check("no page errors " + errs.filter(e => !/api\/display/.test(e)).join(" | "), errs.filter(e => !/api\/display/.test(e)).length === 0);
await b.close();
console.log(fails ? `${fails} of ${n} FAILED` : `ALL PASS (${n})`);
process.exit(fails ? 1 : 0);
