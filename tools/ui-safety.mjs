// Driver alerts (PN-44), speed cameras opt-in (PN-45), low-emission zones (PN-46) — Playwright, headless Chromium.
//   node tools/ui-safety.mjs [base-url] [out-dir] [WxH]            ONLY=A,B,C runs some sections
// Needs the advanced edition (tools/build_edition.py --edition advanced) served by navd with NAV_DATA holding
// <region>/safety/safety.json (scripts/13-build-safety.sh; oberbayern or germany) and VALHALLA_URL = a Valhalla 3.5.1 with
// that region's graph; section C ("Avoid low-emission zones", navd /api/safety/route) needs that Valhalla's max_exclude_polygons_length raised
// (21-push-data.sh does it on the Pi). GPS is mocked (no receiver): routes start at the map center.
// Route: Grafing -> Munich Marienplatz (39 km: level crossings, fixed cameras, a curve, the Munich Umweltzone).
import { createRequire } from "module";
const require = createRequire(import.meta.url);
const { chromium } = require(process.env.PLAYWRIGHT_DIR || "playwright");
const base = process.argv[2] || "http://127.0.0.1:18730";
const out = process.argv[3] || new URL("./shots", import.meta.url).pathname;
const [w, h] = (process.argv[4] || "720x1280").split("x").map(Number);
const tag = w > h ? "land" : "port";
const run = s => !process.env.ONLY || process.env.ONLY.split(",").includes(s);
const b = await chromium.launch({ args: ["--use-gl=angle", "--use-angle=swiftshader", "--enable-unsafe-swiftshader", "--ignore-gpu-blocklist"] });
let fails = 0;
const check = (name, ok, info) => { if (!ok) fails++; console.log((ok ? "PASS " : "FAIL ") + name + (info !== undefined ? "  " + info : "")); };
const GRAFING = [11.9661, 48.0454], MUNICH = { name: "München Mitte", ctx: "test", lat: 48.1371, lon: 11.5754 };

async function page(cfg, lang = "en") {
  const ctx = await b.newContext({ viewport: { width: w, height: h }, hasTouch: true });
  const p = await ctx.newPage();
  p.errs = []; p.routes = []; p.chimes = 0;
  p.on("pageerror", e => p.errs.push(e.message));
  p.on("console", m => m.type() === "error" && !/tiles|fonts|glyphs|\/api\/display/.test(m.text() + (m.location().url || "")) && p.errs.push(m.text()));
  p.on("request", r => { if (r.url().endsWith("/api/route")) p.routes.push(JSON.parse(r.postData())); if (r.url().endsWith("/api/chime")) p.chimes++; });
  await p.addInitScript(([cfg, lang]) => {
    localStorage.setItem("navpi.safety", JSON.stringify(cfg)); localStorage.setItem("navpi.lang", JSON.stringify(lang));
    const ES = window.EventSource;   // no GPS receiver here
    window.EventSource = function (url) { return String(url).includes("/api/gps") ? { close() {} } : new ES(url); };
    window.__toasts = []; window.__alerts = []; window.__saChimed = [];
    addEventListener("DOMContentLoaded", () => {
      new MutationObserver(() => { const t = document.getElementById("toast").textContent; if (t && window.__toasts.at(-1) !== t) window.__toasts.push(t); })
        .observe(document.getElementById("toast"), { childList: true, characterData: true, subtree: true });
    });
    setInterval(() => {   // record every alert the card shows (type class + title + sub)
      const c = document.getElementById("sa-card");
      if (!c || !c.classList.contains("open")) return;
      const k = c.className + "|" + c.querySelector(".sa-t").textContent;
      if (!window.__alerts.length || window.__alerts.at(-1).k !== k) window.__alerts.push({ k, type: (c.className.match(/t-(\w+)/) || [])[1], level: c.classList.contains("info") ? "info" : "warn",
        t: c.querySelector(".sa-t").textContent, s: c.querySelector(".sa-s").textContent, top: c.getBoundingClientRect().top,
        bannerBottom: (document.getElementById("banner").getBoundingClientRect() || {}).bottom });
    }, 100);
  }, [cfg, lang]);
  await p.goto(base + "/");
  await p.waitForFunction(() => window.__map && window.__map.loaded(), null, { timeout: 60000 });
  await p.waitForTimeout(800);
  p.shot = n => p.screenshot({ path: `${out}/${tag}-safety-${n}.png`, timeout: 90000 }).catch(e => console.log("shot " + n + " skipped: " + e.message.split("\n")[0]));
  return p;
}
async function preview(p, dest, from = GRAFING, ms = 60000) {
  const n = p.routes.length;
  await p.evaluate(c => window.__map.jumpTo({ center: c, zoom: 13 }), from);
  await p.evaluate(d => Maps.preview(d), dest);
  await p.waitForFunction(() => document.getElementById("sheet").classList.contains("open") && !document.getElementById("sheet").classList.contains("busy"), null, { timeout: ms });
  await p.waitForTimeout(1200);
  return p.routes.slice(n);
}
const ALL = { curves: true, crossings: true, brk: true, brkMin: 0.6, chime: true, cameras: true, lezWarn: true, sticker: "yellow", lezAvoid: false };

// ---------- A: preview note + simulated drive with every alert ----------
if (run("A")) {
  const p = await page(ALL);
  await preview(p, MUNICH);
  const toasts = await p.evaluate(() => window.__toasts);
  check("preview: the route enters the Munich zone, a yellow sticker may not", toasts.some(t => /may not enter: .*München/.test(t)), JSON.stringify(toasts.slice(-1)));
  await p.shot("1-preview");
  // the simulated drive 10x (as tools/ui-routes.mjs), the alert speed fixed at 90 km/h so the curve rule is deterministic
  await p.evaluate(() => {
    const now = performance.now.bind(performance), t0 = now(), si = window.setInterval;
    performance.now = () => t0 + (now() - t0) * 10;
    window.setInterval = (f, ms, ...a) => si(f, ms === 250 ? 50 : ms, ...a);
    window.__safetySpeed = 25;
  });
  await p.click("#s-sim");
  let brkSeen = false, brkClosed = false, shots = new Set();
  for (let i = 0; i < 400; i++) {
    await p.waitForTimeout(500);
    const a = await p.evaluate(() => window.__alerts.at(-1));
    if (a && !shots.has(a.type) && shots.size < 6) { shots.add(a.type); await p.shot("2-" + a.type); }
    if (a && a.type === "brk" && !brkSeen) {
      brkSeen = true;
      await p.click("#sa-card .sa-x"); await p.waitForTimeout(300);
      brkClosed = !(await p.$eval("#sa-card", c => c.classList.contains("open") && c.classList.contains("t-brk")));
    }
    if (!(await p.$eval("#banner", e => e.classList.contains("open")))) break;
  }
  const al = await p.evaluate(() => window.__alerts);
  const types = new Set(al.map(a => a.type));
  console.log("alerts:", JSON.stringify(al.map(a => a.type + ":" + a.t + " (" + a.s + ")")));
  for (const t of ["crossing", "camera", "lez", "curve"]) check("alert shown while guiding: " + t, types.has(t));
  const lz = al.find(a => a.type === "lez");
  check("zone alert is a warning with the sticker verdict", lz && lz.level === "warn" && /no entry/.test(lz.s), lz && lz.s);
  check("break reminder shown with a rest stop, dismissed by its button", brkSeen && brkClosed && al.some(a => a.type === "brk" && /Rest|rest|Service|Parkplatz|Rast|on the route|nearest/.test(a.s)),
    JSON.stringify(al.filter(a => a.type === "brk").map(a => a.s)));
  check("alert card sits under the maneuver banner", al.every(a => a.type === "brk" || a.top >= a.bannerBottom - 1));
  const ck = await p.evaluate(() => window.__saChimed);
  check("one chime per alert, never twice for the same one (chime on)", p.chimes >= 4 && p.chimes === ck.length && new Set(ck).size === ck.length, p.chimes + " chimes: " + ck.join(" "));
  check("no page errors", !p.errs.length, p.errs.join(" | "));
  await p.context().close();
}

// ---------- B: settings (toggles, opt-in camera text en + de), cameras off = none requested ----------
if (run("B")) {
  const p = await page({});
  await p.click("#dock [data-go=settings]"); await p.click("#st-nav button[data-cat=safety]"); await p.waitForTimeout(1200);
  const st = await p.evaluate(() => ({ cam: document.getElementById("sf-cameras").getAttribute("aria-checked"),
    curves: document.getElementById("sf-curves").getAttribute("aria-checked"), law: document.querySelector("#sf-camcard .sf-legal").textContent,
    cover: document.getElementById("sf-camcover").textContent, sticker: document.querySelector("#sf-sticker .on")?.dataset.st,
    sizes: [...document.querySelectorAll("#sf-card .switch, #sf-camcard .switch, #sf-lezcard .switch, #sf-brkmin button, #sf-sticker button")].map(e => e.getBoundingClientRect().height) }));
  check("cameras OFF by default, other alerts on, sticker green", st.cam === "false" && st.curves === "true" && st.sticker === "green");
  check("camera text says illegal in Germany and Switzerland", /Germany and Switzerland.*illegal/.test(st.law), st.law);
  check("camera coverage: the built region only (e.g. Germany only)", /\S only — \d+ fixed cameras/.test(st.cover), st.cover);
  check("touch targets >= 48 px (switches) / 56 px (buttons)", st.sizes.every(x => x >= 48), JSON.stringify(st.sizes));
  await p.evaluate(() => document.getElementById("sf-camcard").scrollIntoView()); await p.waitForTimeout(300); await p.shot("3-settings");
  await p.click("#sf-cameras"); await p.click('#sf-sticker [data-st="red"]'); await p.click('#sf-brkmin [data-min="180"]');
  const s = await p.evaluate(() => JSON.parse(localStorage.getItem("navpi.safety")));
  check("switches and choices are kept on the device", s.cameras === true && s.sticker === "red" && s.brkMin === 180, JSON.stringify(s));
  await p.evaluate(() => document.querySelector('#langs [data-lang="de"]').click()); await p.waitForTimeout(500);
  const de = await p.$eval("#sf-camcard .sf-legal", e => e.textContent);
  check("German text: verboten in Deutschland und der Schweiz", /Deutschland und der Schweiz.*verboten/.test(de), de);
  await p.evaluate(() => document.getElementById("sf-lezcard").scrollIntoView()); await p.waitForTimeout(300); await p.shot("4-settings-de");
  await p.evaluate(() => document.querySelector('#langs [data-lang="en"]').click());
  check("no page errors", !p.errs.length, p.errs.join(" | "));
  await p.context().close();
  // with the default settings the app never asks for cameras
  const q = await page({});
  const asked = []; q.on("request", r => r.url().endsWith("/api/safety/along") && asked.push(JSON.parse(r.postData()).types));
  await preview(q, MUNICH);
  await q.click("#s-sim"); await q.waitForTimeout(4000);
  check("cameras off: /api/safety/along never asks for cameras", asked.length > 0 && asked.every(t => !t.includes("cameras")), JSON.stringify(asked));
  await q.context().close();
}

// ---------- C: Avoid low-emission zones (Valhalla exclude_polygons) ----------
if (run("C")) {
  const p = await page({ ...ALL, lezAvoid: true });
  const answers = []; p.on("response", r => r.url().endsWith("/api/safety/route") && r.json().then(j => answers.push(j.safety)).catch(() => answers.push(null)));
  const DEST = { name: "Trudering", ctx: "test", lat: 48.1250, lon: 11.6600 };
  const t0 = Date.now();
  await preview(p, DEST, [11.4600, 48.1490], 590000);   // from Pasing: the fastest way crosses the zone
  const sec = (Date.now() - t0) / 1000;
  await p.waitForTimeout(500);
  check("routed by navd round the zone (/api/safety/route): Munich avoided", answers.length === 1 && answers[0] &&
    answers[0].avoided.some(n => /München/.test(n)), JSON.stringify(answers));
  const toasts = await p.evaluate(() => window.__toasts);
  check("the avoided route enters no zone (no zone note, no fallback)", !toasts.some(t => /low-emission/.test(t)), JSON.stringify(toasts));
  console.log("avoid route: " + await p.$eval("#s-dist", e => e.textContent) + ", " + await p.$eval("#s-time", e => e.textContent) + ", answered in " + sec.toFixed(1) + " s");
  await p.shot("5-avoid");
  check("no page errors", !p.errs.length, p.errs.join(" | "));
  await p.context().close();
}
await b.close();
console.log(fails ? fails + " FAIL" : "0 FAIL");
process.exit(fails ? 1 : 0);
