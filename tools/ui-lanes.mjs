// Lane arrows (PN-36), junction view (PN-40) and voice options (PN-48) in the real app (Playwright).
// A mocked GPS drives a real route (local Valhalla 3.5.1): start on the A9 northbound south of Ingolstadt (a point of
// the recorded route in tools/fixtures/), destination "ingolstadt" from the search; the fix moves along the whole route
// at ~10x. Which exit the route takes depends on the map data (exit 62 Ingolstadt-Sued in 2026-11 data).
// Works with REGION=oberbayern (or germany).
//   node tools/ui-lanes.mjs [base-url] [out-dir] [WxH]
// Needs a served build (tools/build_edition.py + navd.py with VALHALLA_URL, TILES_URL; see docs/TESTING.md).
import { createRequire } from "module";
import { readFileSync } from "fs";
const require = createRequire(import.meta.url);
const { chromium } = require(process.env.PLAYWRIGHT_DIR || "playwright");
const base = process.argv[2] || "http://127.0.0.1:18080";
const out = process.argv[3] || new URL("./shots", import.meta.url).pathname;
const [w, h] = (process.argv[4] || "1280x720").split("x").map(Number);
const tag = w > h ? "land" : "port";
let fails = 0;
const check = (name, ok) => { if (!ok) fails++; console.log((ok ? "PASS " : "FAIL ") + name); };

// start point: ~3 km before A9 exit 62 on the recorded Munich -> Ingolstadt route
const fx = JSON.parse(readFileSync(new URL("./fixtures/lanes-munich-ingolstadt.json", import.meta.url)));
function decode(str) {
  let i = 0, lat = 0, lon = 0; const o = [];
  while (i < str.length) {
    for (const k of [0, 1]) { let s = 0, r = 0, b; do { b = str.charCodeAt(i++) - 63; r |= (b & 31) << s; s += 5; } while (b >= 32); const d = r & 1 ? ~(r >> 1) : r >> 1; k ? lon += d : lat += d; }
    o.push([lon / 1e6, lat / 1e6]);
  }
  return o;
}
const leg = fx.route.legs[0], shp = decode(leg.shape), ex = leg.maneuvers.find(m => /Ausfahrt 62/.test(m.instruction));
const dist = (a, b) => { const p = Math.PI / 180; return 6371000 * Math.hypot((b[1] - a[1]) * p, (b[0] - a[0]) * p * Math.cos(a[1] * p)); };
let si = ex.begin_shape_index;
for (let d = 0; si > 0 && d < 3000; si--) d += dist(shp[si - 1], shp[si]);
const START = shp[si];   // ~3 km south on the A9

const b = await chromium.launch({ args: ["--use-angle=swiftshader", "--enable-unsafe-swiftshader", "--ignore-gpu-blocklist"] });
async function page() {
  const ctx = await b.newContext({ viewport: { width: w, height: h }, hasTouch: true });
  const p = await ctx.newPage();
  p.errs = []; p.speaks = [];
  p.on("pageerror", e => p.errs.push(e.message));
  p.on("console", m => m.type() === "error" && !/\/api\/display$/.test(m.location().url || "") && p.errs.push(m.text()));
  p.on("request", r => { if (r.url().endsWith("/api/speak")) p.speaks.push(JSON.parse(r.postData())); });
  // GPS stand-in: a fix every 100 ms from window.__fix [lat, lon, speed m/s, track]
  await p.addInitScript(start => {
    window.__fix = [start[1], start[0], 0, 0];
    const ES = window.EventSource;
    window.EventSource = function (url) {
      if (!String(url).includes("/api/gps")) return new ES(url);
      const es = { close() {} };
      setInterval(() => { const f = window.__fix; es.onmessage && es.onmessage({ data: JSON.stringify({ receiver: true, mode: 3, lat: f[0], lon: f[1], speed: f[2], track: f[3] }) }); }, 100);
      return es;
    };
    const f = window.fetch;
    window.fetch = async (...a) => { const r = await f(...a); if (String(a[0]).endsWith("/api/route")) window.__route = await r.clone().json(); return r; };
  }, START);
  await p.goto(base + "/");
  await p.waitForFunction(() => window.__map && window.__map.loaded(), null, { timeout: 30000 });
  await p.waitForTimeout(1500);
  p.shot = n => p.screenshot({ path: `${out}/${tag}-lanes-${n}.png`, timeout: 90000 }).catch(e => console.log("shot " + n + " skipped: " + e.message.split("\n")[0]));
  p.type = async text => { for (const ch of text) await p.click(`#kbd button:text-is("${ch}")`); };
  return p;
}
const store = (p, k) => p.evaluate(k => JSON.parse(localStorage.getItem("navpi." + k)), k);

// search ingolstadt, Go (GPS route from the A9), then move the fix along the route; returns per-step observations
async function drive(p, label, shotAt) {
  await p.click("#q"); await p.waitForTimeout(300); await p.type("ingolstadt"); await p.waitForTimeout(1500);
  await p.waitForSelector("#search-results .row .c.num", { timeout: 15000 });
  await p.click("#search-results .row:not(.saved) >> nth=0");
  await p.waitForFunction(() => document.getElementById("sheet").classList.contains("open") && window.__route, null, { timeout: 30000 });
  await p.waitForTimeout(800);
  await p.click("#s-go");
  await p.waitForFunction(() => document.getElementById("banner").classList.contains("open"), null, { timeout: 30000 });
  await p.waitForTimeout(1500);   // /api/lanes answered
  const obs = [];
  let shot = false, seen = 0;
  // the route's own shape; 40 m per 100 ms step at a reported 30 m/s (10x), slower in town
  const n = await p.evaluate(() => {
    const s = U.decodePolyline(window.__route.trip.legs[0].shape), cum = [0];
    for (let i = 1; i < s.length; i++) cum.push(cum[i - 1] + U.dist(s[i - 1], s[i]));
    window.__drv = { s, cum, d: 0 };
    return cum[cum.length - 1];
  });
  for (let d = 0; d < n - 50; ) {   // the whole route: which exit it takes depends on the map data
    const o = await p.evaluate(d => {
      const { s, cum } = window.__drv;
      let i = 0; while (i + 1 < cum.length - 1 && cum[i + 1] < d) i++;
      const t = (d - cum[i]) / ((cum[i + 1] - cum[i]) || 1), pt = [s[i][0] + (s[i + 1][0] - s[i][0]) * t, s[i][1] + (s[i + 1][1] - s[i][1]) * t];
      const v = d < 3500 ? 30 : 12;
      window.__fix = [pt[1], pt[0], v, U.bearing(s[i], s[i + 1])];
      const lanes = document.getElementById("b-lanes"), j = document.getElementById("jct");
      return { lanes: !!lanes && lanes.classList.contains("on"), nl: lanes ? lanes.querySelectorAll("svg.lane").length : 0,
        ok: lanes ? lanes.querySelectorAll("svg.lane.ok").length : 0, jct: !!j && j.classList.contains("open"),
        jr: j && j.classList.contains("open") ? j.getBoundingClientRect().toJSON() : null,
        br: document.getElementById("banner").getBoundingClientRect().toJSON(), dist: document.getElementById("b-dist").textContent, v };
    }, d);
    obs.push({ d, ...o });
    seen = o.jct ? seen + 1 : 0;
    if (seen === 6 && !shot && shotAt) { shot = true; await p.waitForTimeout(400); await p.shot(label); }
    await p.waitForTimeout(110);
    d += o.v > 20 ? 40 : 16;
  }
  return obs;
}

// ---------- 1: defaults (voice on, full, all turns) ----------
const p1 = await page();
const o1 = await drive(p1, "1-junction", true);
const lanesOn = o1.filter(o => o.lanes), jctOn = o1.filter(o => o.jct);
console.log(`steps ${o1.length}, lanes shown on ${lanesOn.length}, junction view on ${jctOn.length}, lane sets seen: ${[...new Set(lanesOn.map(o => o.ok + "/" + o.nl))].join(" ")}`);
check("lane arrows shown before the motorway exit (at least 2 lanes, at least 1 marked)", lanesOn.some(o => o.nl >= 2 && o.ok >= 1));
check("junction view shown before the exit", jctOn.length > 0);
const jr = jctOn[0] && jctOn[0].jr, br = jctOn[0] && jctOn[0].br;
if (w > h) check("landscape: junction view beside the banner, right side, inside the screen", !!jr && jr.left >= br.right && jr.right <= w && jr.width >= 300);
else check("portrait: junction view below the banner, full width", !!jr && jr.top >= br.bottom && jr.width >= w - 40);
check("junction view hidden again after the exit", o1.length > 0 && !o1[o1.length - 1].jct || o1.some((o, i) => i > 0 && o1[i - 1].jct && !o.jct));
check("voice prompts spoken by default", p1.speaks.length > 0);
const all = p1.speaks.length;
check("no page errors (1)", p1.errs.length === 0);
if (p1.errs.length) console.log(p1.errs.slice(0, 5).join("\n"));
await p1.context().close();   // one swiftshader map at a time

if (process.env.ONLY1) { await b.close(); console.log(fails ? `${fails} FAIL` : "all PASS"); process.exit(fails ? 1 : 0); }
// ---------- 2: Settings > Navigation: mute, short + major only ----------
const p2 = await page();
await p2.click("#dock [data-go=settings]"); await p2.click("#st-nav button[data-cat=nav]"); await p2.waitForTimeout(600);
check("Settings > Navigation has the voice switch, on", (await p2.getAttribute("#vo-on", "aria-checked")) === "true");
await p2.click("#vo-on"); await p2.waitForTimeout(200);
check("mute: switch off + stored", (await p2.getAttribute("#vo-on", "aria-checked")) === "false" && (await store(p2, "voiceOpts")).mute === true);
await p2.shot("2-muted");
await p2.click('#vo-style button[data-style="short"]'); await p2.click('#vo-turns button[data-turns="major"]'); await p2.waitForTimeout(200);
const vo = await store(p2, "voiceOpts");
check("settings: short + major stored, mute still on", vo.style === "short" && vo.turns === "major" && vo.mute === true);
await p2.$eval("#vo-card", e => e.scrollIntoView()); await p2.shot("3-settings");
await p2.click("#settings-back"); await p2.waitForTimeout(600);
const before = p2.speaks.length;
await drive(p2, "", false);
check("muted: nothing spoken during the drive", p2.speaks.length === before);
const errs2 = p2.errs; await p2.context().close();
// unmute in Settings and drive again: short + major only says less than the defaults
const p3 = await page();
await p3.evaluate(() => localStorage.setItem("navpi.voiceOpts", JSON.stringify({ mute: false, style: "short", turns: "major" })));
await p3.reload(); await p3.waitForFunction(() => window.__map && window.__map.loaded(), null, { timeout: 30000 }); await p3.waitForTimeout(1500);
await drive(p3, "", false);
console.log(`spoken: defaults ${all}, short + major ${p3.speaks.length}: ${p3.speaks.map(s => s.text).join(" | ")}`);
check("short + major: spoken, fewer than the defaults", p3.speaks.length > 0 && p3.speaks.length < all);
check("no page errors (2, 3)", errs2.length === 0 && p3.errs.length === 0);
if (errs2.length || p3.errs.length) console.log([...errs2, ...p3.errs].slice(0, 5).join("\n"));
await b.close();
console.log(fails ? `${fails} FAIL` : "all PASS");
process.exit(fails ? 1 : 0);
