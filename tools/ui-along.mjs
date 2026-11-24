// PN-38 places along the route, PN-41 round trip + share by QR, PN-49 trip-log names (Playwright).
//   node tools/ui-along.mjs [base-url] [out-dir] [WxH]        ONLY=A,B,C runs some sections
// Needs a local navd with real routing + the map (pmtiles serve) and, for the fast path, an along index
// (tools/build_along.py) under NAV_DATA/<region>/along/. GPS is mocked in the page (Marienplatz, Munich).
// All routes stay inside Upper Bavaria: REGION=oberbayern is enough (germany/europe work too).
// /api/display answers 409 on a PC without a backlight: not counted as a page error.
import { createRequire } from "module";
const require = createRequire(import.meta.url);
const { chromium } = require(process.env.PLAYWRIGHT_DIR || "playwright");
const base = process.argv[2] || "http://127.0.0.1:18380";
const out = process.argv[3] || new URL("./shots", import.meta.url).pathname;
const [w, h] = (process.argv[4] || "1280x720").split("x").map(Number);
const tag = w > h ? "land" : "port";
const run = s => !process.env.ONLY || process.env.ONLY.split(",").includes(s);
const b = await chromium.launch({ args: ["--use-angle=swiftshader", "--enable-unsafe-swiftshader", "--ignore-gpu-blocklist"] });
let fails = 0;
const check = (name, ok) => { if (!ok) fails++; console.log((ok ? "PASS " : "FAIL ") + name); };
const MUNICH = [48.1371, 11.5754];

async function page() {
  const ctx = await b.newContext({ viewport: { width: w, height: h }, hasTouch: true });
  const p = await ctx.newPage();
  p.errs = []; p.routes = []; p.along = [];
  p.on("pageerror", e => p.errs.push(e.message));
  p.on("console", m => m.type() === "error" && !/\/api\/display$/.test(m.location().url || "") && p.errs.push(m.text()));
  p.on("request", r => { if (r.url().endsWith("/api/route")) p.routes.push(JSON.parse(r.postData())); });
  p.on("response", async r => { if (r.url().endsWith("/api/along")) p.along.push(await r.json().catch(() => ({}))); });
  await p.addInitScript(fix => {
    const ES = window.EventSource;
    window.EventSource = function (url) {
      if (!String(url).includes("/api/gps")) return new ES(url);
      const es = { close() {} };
      setInterval(() => !window.__noFix && es.onmessage && es.onmessage({ data: JSON.stringify({ receiver: true, mode: 3, lat: fix[0], lon: fix[1], speed: 0, track: 0 }) }), 1000);
      return es;
    };
    window.__dest = []; addEventListener("navpi:dest", e => window.__dest.push(e.detail));
  }, MUNICH);
  await p.goto(base + "/");
  await p.waitForFunction(() => window.__map && window.__map.loaded(), null, { timeout: 60000 });
  await p.waitForTimeout(1500);
  p.shot = n => p.screenshot({ path: `${out}/${tag}-along-${n}.png`, timeout: 90000 }).catch(e => console.log("shot " + n + " skipped: " + e.message.split("\n")[0]));
  // a round trip makes several /api/route calls before the preview: wait for the sheet text instead
  p.sheetSays = async (sel, text) => { await p.waitForFunction(([s, t]) => document.querySelector("#sheet.open:not(.busy)") && document.querySelector(s).textContent.includes(t), [sel, text], { timeout: 60000 }).catch(() => {}); await p.waitForTimeout(800); };
  p.routed = async (n0, ms = 60000) => { await p.waitForFunction(n => document.querySelector("#sheet.open:not(.busy)") && window.__nroutes > n, n0, { timeout: ms }).catch(() => {}); await p.waitForTimeout(800); };
  await p.evaluate(() => { window.__nroutes = 0; const f = window.fetch; window.fetch = async (...a) => {
    const r = await f(...a); if (String(a[0]).endsWith("/api/route")) { await r.clone().text(); window.__nroutes++; } return r; }; });
  return p;
}
const open = (p, sel) => p.$eval(sel, e => e.classList.contains("open")).catch(() => false);
const rows = p => p.$$eval("#al-list .al-row", rs => rs.map(r => r.querySelector(".n").textContent + " | " + r.querySelector(".c").textContent));
async function waitAlong(p, n0) {
  for (let i = 0; i < 120 && p.along.length <= n0; i++) await p.waitForTimeout(250);
  await p.waitForTimeout(400);
  return p.along.at(-1) || {};
}

// ---------- A: places along a long route (Munich -> Berchtesgaden, A8), add one as a stop, then while driving ----------
if (run("A")) {
  const p = await page();
  let n = await p.evaluate(() => window.__nroutes);
  await p.evaluate(() => Maps.preview({ name: "Berchtesgaden", ctx: "Test", lat: 47.6314, lon: 13.0017 }));
  await p.routed(n);
  check("preview of a long route open", await open(p, "#sheet") && /km/.test(await p.textContent("#s-dist")));
  check("sheet has Along the route / Share buttons", await p.isVisible("#s-along") && await p.isVisible("#s-share") && !(await p.isVisible("#s-shuffle")));
  await p.shot("1-sheet");
  let k = p.along.length;
  await p.click("#s-along");
  let r = await waitAlong(p, k);
  check("panel open, fuel first (" + (r.items || []).length + " rows, " + r.source + ", " + r.ms + " ms on navd)", await open(p, "#along") && (r.items || []).length > 0);
  console.log("  fuel:", (await rows(p)).slice(0, 4).join(" || "));
  check("rows sorted by km ahead", (r.items || []).every((it, i, a) => i === 0 || a[i - 1].ahead_m <= it.ahead_m));
  check("rows say ahead + detour", (await rows(p)).every(t => /(ahead|here) · /.test(t)));
  await p.shot("2-fuel");
  for (const c of ["rest", "toilets", "parking"]) {
    k = p.along.length; await p.click(`#along .al-cat[data-cat="${c}"]`); r = await waitAlong(p, k);
    check(`${c}: ${(r.items || []).length} rows, ${r.ms} ms`, (r.items || []).length > 0 && await p.$eval(`#along .al-cat[data-cat="${c}"]`, e => e.getAttribute("aria-checked") === "true"));
    if (c === "rest") { console.log("  rest:", (await rows(p)).slice(0, 4).join(" || ")); await p.shot("3-rest"); }
  }
  // a rest area as a stop: it goes in as a break location, the panel closes, the sheet comes back
  k = p.along.length; await p.click('#along .al-cat[data-cat="rest"]'); r = await waitAlong(p, k);
  const first = r.items[0];
  n = await p.evaluate(() => window.__nroutes);
  await p.click("#al-list .al-row >> nth=0");
  await p.routed(n);
  const last = p.routes.at(-1);
  check("tap = added as stop (break location at the place)", !(await open(p, "#along")) && last.locations.length === 3 && last.locations[1].type === "break"
    && Math.abs(last.locations[1].lat - first.lat) < 1e-5);
  check("sheet lists the stop", (await p.$$("#s-stops .stop")).length === 1);
  await p.shot("4-stop");
  // drive (simulated): the round button opens the list, km ahead counts from the car
  n = await p.evaluate(() => window.__nroutes);
  await p.click("#s-sim"); await p.waitForTimeout(2500);
  check("driving: along button visible", await p.isVisible("#btn-along"));
  k = p.along.length; await p.click("#btn-along"); r = await waitAlong(p, k);
  check("driving: list opens with rows (" + (r.items || []).length + ")", await open(p, "#along") && (r.items || []).length > 0);
  await p.shot("5-driving");
  // "Drive there" (arrow) from the list while driving: guidance switches to it, the trip log hears the name
  const target = r.items[0];
  n = await p.evaluate(() => window.__nroutes);
  await p.click("#al-list .al-row >> nth=0 >> .go");
  await p.waitForFunction(n0 => window.__nroutes > n0, n, { timeout: 60000 }).catch(() => {});
  await p.waitForTimeout(1200);
  const lr = p.routes.at(-1), dests = await p.evaluate(() => window.__dest);
  check("drive there: new route ends at the place, still navigating", Math.abs(lr.locations.at(-1).lat - target.lat) < 1e-5 && await p.evaluate(() => Maps.ctx().state) === "nav");
  check("navpi:dest: {from, to} at Go, {to} on drive-there (PN-49)", dests.length === 2 && dests[0].to === "Berchtesgaden" && !!dests[0].from && dests[1].to === (target.name || dests[1].to));
  await p.click("#btn-stop"); await p.waitForTimeout(500);
  check("A: no page errors", p.errs.length === 0 || (console.log(p.errs), false));
  await p.close();
}

// ---------- B: round trip 25 km from the position, Shuffle, then a typed 40 km from a long-pressed point ----------
if (run("B")) {
  const p = await page();
  await p.click("#q"); await p.waitForTimeout(600);
  check("search panel offers Round trip", await p.isVisible("#rt-row"));
  await p.shot("6-search-row");
  await p.click("#rt-row"); await p.waitForTimeout(300);
  check("round trip panel open, search closed", await open(p, "#rtrip") && !(await p.$eval("#search-results", e => e.classList.contains("open"))));
  await p.click('#rtrip .rt-km[data-km="25"]');
  await p.shot("7-roundtrip");
  let n = await p.evaluate(() => window.__nroutes);
  await p.click("#rt-go");
  await p.sheetSays("#s-ctx", "Variant 1");
  const km = () => p.evaluate(() => { const t = document.querySelector("#s-dist").textContent; return parseFloat(t.replace(",", ".")); });
  const r1 = p.routes.at(-1), k1 = await km();
  check("preview 'Round trip 25 km' (" + k1 + " km), 3 through points, back to the start",
    (await p.textContent("#s-dest")) === "Round trip 25 km" && r1.locations.filter(l => l.type === "through").length === 3
    && Math.abs(r1.locations.at(-1).lat - MUNICH[0]) < 1e-6);
  check("length within 25 % of 25 km", Math.abs(k1 - 25) / 25 <= 0.25);
  check("Shuffle shown, swap + add stop hidden, no Share", await p.isVisible("#s-shuffle") && !(await p.isVisible("#s-swap")) && !(await p.isVisible("#s-addstop")) && !(await p.isVisible("#s-share")));
  await p.shot("8-roundtrip-preview");
  n = await p.evaluate(() => window.__nroutes);
  await p.click("#s-shuffle"); await p.sheetSays("#s-ctx", "Variant 2");
  const r2 = p.routes.at(-1), k2 = await km();
  check("Shuffle: other points (" + k2 + " km), variant 2", JSON.stringify(r2.locations[1]) !== JSON.stringify(r1.locations[1]) && /Variant 2/.test(await p.textContent("#s-ctx")));
  // long-press a point -> Round trip -> type 40 km
  await p.click("#s-cancel"); await p.waitForTimeout(400);
  const lp = [w > h ? w * 0.6 : w * 0.5, h * 0.7];   // below the mid-screen toast (a route into a low-emission zone shows one)
  await p.mouse.move(...lp); await p.mouse.down(); await p.waitForTimeout(900); await p.mouse.up(); await p.waitForTimeout(400);
  check("long-press sheet has Round trip + Share", await p.isVisible("#p-round") && await p.isVisible("#p-share"));
  await p.shot("9-pick");
  await p.click("#p-round"); await p.waitForTimeout(300);
  await p.click('#rtrip .rt-km[data-km="other"]'); await p.waitForTimeout(300);
  for (const ch of "40") await p.click(`#kbd button:text-is("${ch}")`);
  n = await p.evaluate(() => window.__nroutes);
  await p.click("#rt-go"); await p.sheetSays("#s-dest", "Round trip 40 km");
  const r3 = p.routes.at(-1), k3 = await km();
  check("typed 40 km from the marked point (" + k3 + " km), start = Marked point",
    (await p.textContent("#s-dest")) === "Round trip 40 km" && (await p.textContent("#s-from-name")) === "Marked point" && Math.abs(r3.locations[0].lat - MUNICH[0]) > 1e-4);
  check("B: no page errors", p.errs.length === 0 || (console.log(p.errs), false));
  await p.close();
}

// ---------- C: share a destination by QR ----------
if (run("C")) {
  const p = await page();
  const n = await p.evaluate(() => window.__nroutes);
  await p.evaluate(() => Maps.preview({ name: "Frauenkirche München", ctx: "Test", lat: 48.13864, lon: 11.57361 }));
  await p.routed(n);
  await p.click("#s-share"); await p.waitForTimeout(400);
  const box = await p.$eval("#qr-code", e => e.getBoundingClientRect().width);
  check("QR panel open, code " + Math.round(box) + " px", await open(p, "#qrshare") && box >= Math.min(w, h) * 0.45);
  const t1 = await p.textContent("#qr-text");
  check("geo: URI with the name", t1 === "geo:48.138640,11.573610?q=48.138640,11.573610(Frauenkirche%20M%C3%BCnchen)");
  await p.shot("10-qr-geo");
  await p.click('#qrshare .qr-fmt[data-f="osm"]');
  check("OpenStreetMap link", (await p.textContent("#qr-text")).startsWith("https://www.openstreetmap.org/?mlat=48.138640&mlon=11.573610"));
  await p.click('#qrshare .qr-fmt[data-f="google"]');
  check("Google Maps link, choice remembered", (await p.textContent("#qr-text")).includes("query=48.138640,11.573610") && await p.evaluate(() => JSON.parse(localStorage.getItem("navpi.qrFmt"))) === "google");
  await p.shot("11-qr-google");
  await p.click("#qr-close");
  check("closed", !(await open(p, "#qrshare")));
  await p.evaluate(() => { setLang("de"); Shell.relang(); });
  await p.click("#s-along"); await p.waitForTimeout(2500);
  check("German strings", (await p.textContent("#along .ttl")) === "Orte entlang der Route" && (await p.textContent("#s-share")).includes("Teilen"));
  await p.shot("12-de");
  await p.evaluate(() => { setLang("en"); Shell.relang(); });
  check("C: no page errors", p.errs.length === 0 || (console.log(p.errs), false));
  await p.close();
}
await b.close();
console.log(fails ? `${fails} FAILED` : "ALL PASS");
process.exit(fails ? 1 : 0);
