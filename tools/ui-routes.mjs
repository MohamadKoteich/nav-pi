// Route flows (Playwright): start choice + swap, route options (PN-33), Home/Work/favourites (PN-34), Go from a
// distant start with a (mocked) GPS fix; C: alternative routes (PN-35) + stops add/reorder/remove (PN-37);
// D: simulated drive through a stop, parked car + walk back (PN-39).
// Needs a local navd with real routing (see docs/TESTING.md).
//   node tools/ui-routes.mjs [base-url] [out-dir] [WxH]      ONLY=C,D runs some sections
// /api/display answers 409 on a PC without a backlight, /api/safety/* 404 without safety data: not counted as page errors.
import { createRequire } from "module";
const require = createRequire(import.meta.url);
const { chromium } = require(process.env.PLAYWRIGHT_DIR || "playwright");
const base = process.argv[2] || "http://127.0.0.1:18080";
const out = process.argv[3] || new URL("./shots", import.meta.url).pathname;
const [w, h] = (process.argv[4] || "720x1280").split("x").map(Number);
const tag = w > h ? "land" : "port";
const b = await chromium.launch({ args: ["--use-angle=swiftshader", "--enable-unsafe-swiftshader", "--ignore-gpu-blocklist"] });
let fails = 0;
const check = (name, ok) => { if (!ok) fails++; console.log((ok ? "PASS " : "FAIL ") + name); };
const run = s => !process.env.ONLY || process.env.ONLY.split(",").includes(s);

async function page(gps, fast) {
  const ctx = await b.newContext({ viewport: { width: w, height: h }, hasTouch: true });
  const p = await ctx.newPage();
  p.errs = []; p.routes = []; p.speaks = [];
  p.on("pageerror", e => p.errs.push(e.message));
  // /api/safety/* answers 404 when the region has no safety data (scripts/13-build-safety.sh is optional): not an error here
  p.on("console", m => m.type() === "error" && !/\/api\/display$|\/api\/safety\//.test(m.location().url || "") && p.errs.push(m.text()));
  p.on("request", r => { if (r.url().endsWith("/api/route")) p.routes.push(JSON.parse(r.postData()));
    if (r.url().endsWith("/api/speak")) p.speaks.push(JSON.parse(r.postData())); });
  // no GPS receiver here: a stand-in EventSource for /api/gps — silent (no GPS) or one fix per second
  await p.addInitScript(fix => {
    const ES = window.EventSource;
    window.EventSource = function (url) {
      if (!String(url).includes("/api/gps")) return new ES(url);
      const es = { close() {} };
      if (fix) setInterval(() => es.onmessage && es.onmessage({ data: JSON.stringify({ receiver: true, mode: 3, lat: fix[0], lon: fix[1], speed: 0, track: 0 }) }), 1000);
      return es;
    };
  }, gps);
  await p.addInitScript(() => { window.__dest = []; window.__parkSim = true;  /* test: simulated drives park like real ones */ addEventListener("navpi:dest", e => window.__dest.push(e.detail)); });
  await p.goto(base + "/");
  await p.waitForFunction(() => window.__map && window.__map.loaded(), null, { timeout: 30000 });
  await p.waitForTimeout(800);
  // a busy box can stall swiftshader: a slow screenshot is logged, not a failure
  p.shot = n => p.screenshot({ path: `${out}/${tag}-route-${n}.png`, timeout: 90000 }).catch(e => console.log("shot " + n + " skipped: " + e.message.split("\n")[0]));
  p.type = async text => { for (const ch of text) await p.click(`#kbd button:text-is("${ch === " " ? "Space" : ch}")`); };
  p.waitRoute = async (since) => {
    await p.waitForFunction(n => window.__rt >= n, since, { timeout: 30000 }).catch(() => {});
  };
  await p.evaluate(() => { window.__rt = 0; const f = window.fetch; window.fetch = async (...a) => {
    const r = await f(...a); if (String(a[0]).endsWith("/api/route")) { await r.clone().text(); setTimeout(() => window.__rt++, 900); } return r; }; });
  // fast: the simulated drive runs ~10x (its 250 ms tick every 50 ms, the clock 10x); patched after the map loaded
  if (fast) await p.evaluate(() => {
    const now = performance.now.bind(performance), t0 = now(), si = window.setInterval;
    performance.now = () => t0 + (now() - t0) * 10;
    window.setInterval = (f, ms, ...a) => si(f, ms === 250 ? 50 : ms, ...a);
  });
  return p;
}
const store = (p, k) => p.evaluate(k => JSON.parse(localStorage.getItem("navpi." + k)), k);
const txt = (p, sel) => p.$eval(sel, e => e.textContent);
const open = (p, sel) => p.$eval(sel, e => e.classList.contains("open"));
async function search(p, text) {
  await p.click("#q"); await p.waitForTimeout(300); await p.type(text); await p.waitForTimeout(1500);
  const n = await p.evaluate(() => window.__rt); await p.click("#search-results .row:has(.c.num) >> nth=0"); await p.waitRoute(n + 1);
}
async function longPress(p, x, y) { await p.mouse.move(x, y); await p.mouse.down(); await p.waitForTimeout(900); await p.mouse.up(); await p.waitForTimeout(300); }

// ---------- A: no GPS ----------
if (run("A")) {
  const p = await page(null);
  // no GPS: the route starts at the map centre; the Europe region view is centred in the North Sea (no road), so look at Munich first
  await p.evaluate(() => window.__map.jumpTo({ center: [11.575, 48.137], zoom: 11 }));
  await search(p, "munchen");
  check("preview open, start = map center (no GPS)", await open(p, "#sheet") && (await txt(p, "#s-from-name")) === "Map center (no GPS)");
  const c0 = p.routes.at(-1).locations[0];
  // options: avoid motorways -> re-route, flag shown, same origin (frozen map center)
  await p.click("#s-opts"); await p.waitForTimeout(300); await p.shot("1-options");
  check("options panel open with 4 switches", await open(p, "#ropts") && (await p.$$("#ro-list .tog")).length === 4);
  let n = await p.evaluate(() => window.__rt);
  await p.click('#ro-list [data-opt="highways"]'); await p.click("#ro-done"); await p.waitRoute(n + 1);
  const r1 = p.routes.at(-1);
  check("re-routed with use_highways=0", r1.costing_options && r1.costing_options.auto.use_highways === 0);
  check("re-route keeps the same no-GPS origin", Math.abs(r1.locations[0].lat - c0.lat) < 1e-9 && Math.abs(r1.locations[0].lon - c0.lon) < 1e-9);
  check("sheet says Avoiding: motorways, options button marked", (await txt(p, "#s-ctx")).includes("Avoiding: motorways") && await p.$eval("#s-opts", e => e.classList.contains("on")));
  check("options persisted", (await store(p, "routeOpts")).highways === true);
  await p.shot("2-preview-avoid");
  // save destination as Home, then as a named favourite
  await p.click("#s-save"); await p.waitForTimeout(300); await p.shot("3-save");
  check("save panel + keyboard open", await open(p, "#placeform") && await open(p, "#kbd"));
  await p.click("#pf-home"); await p.waitForTimeout(200);
  check("Home saved", (await store(p, "places")).home.name.startsWith("München"));
  check("star marked", await p.$eval("#s-save", e => e.classList.contains("on")));
  await p.click("#s-save"); await p.click("#pf-clear"); await p.type("friend"); await p.click("#pf-save"); await p.waitForTimeout(200);
  check("favourite 'friend' saved", (await store(p, "places")).favs[0].name === "friend");
  // long-press start point -> pick sheet -> Start here (re-route from it)
  n = await p.evaluate(() => window.__rt);
  await longPress(p, w > h ? w * 0.7 : w * 0.3, h * 0.35);  // landscape: right of the sheet (it grew with the route choices)
  check("pick sheet open, route sheet hidden", await open(p, "#pick") && !(await open(p, "#sheet"))); await p.shot("3b-pick");
  await p.click("#p-start"); await p.waitRoute(n + 1);
  check("start = Marked point", (await txt(p, "#s-from-name")) === "Marked point" && await open(p, "#sheet"));
  // swap twice: dest <-> start, back to the original
  const dname = await txt(p, "#s-dest");
  n = await p.evaluate(() => window.__rt); await p.click("#s-swap"); await p.waitRoute(n + 1);
  check("swap: dest = Marked point, start = " + dname, (await txt(p, "#s-dest")) === "Marked point" && (await txt(p, "#s-from-name")) === dname);
  n = await p.evaluate(() => window.__rt); await p.click("#s-swap"); await p.waitRoute(n + 1);
  check("swap back", (await txt(p, "#s-dest")) === dname && (await txt(p, "#s-from-name")) === "Marked point");
  // choose start from the saved list (Home) via the From row; language switch keeps the start placeholder
  await p.click("#s-from"); await p.waitForTimeout(400);
  check("start search: placeholder + Saved list", (await p.getAttribute("#q", "placeholder")) === "Choose start point" && (await p.$$("#search-results .row.saved")).length === 3);
  await p.evaluate(() => { setLang("de"); Shell.relang(); });
  check("language switch keeps start placeholder (de)", (await p.getAttribute("#q", "placeholder")) === "Startpunkt wählen");
  await p.evaluate(() => { setLang("en"); Shell.relang(); });
  await p.shot("4-start-saved");
  n = await p.evaluate(() => window.__rt); await p.click('#search-results .row.saved[data-kind="fav"]'); await p.waitRoute(n + 1);
  check("start = favourite friend", (await txt(p, "#s-from-name")) === "friend" && await open(p, "#sheet"));
  // cancel paths: From -> close search restores the sheet; pick Cancel restores the sheet
  await p.click("#s-from"); await p.waitForTimeout(300); await p.click("#q-clear"); await p.waitForTimeout(300);
  check("closing start search restores sheet + placeholder", await open(p, "#sheet") && (await p.getAttribute("#q", "placeholder")) === "Where to?");
  await longPress(p, w * 0.6, h * 0.3); await p.click("#p-cancel"); await p.waitForTimeout(200);
  check("pick Cancel restores sheet", await open(p, "#sheet") && !(await open(p, "#pick")));
  await p.click("#s-cancel"); await p.waitForTimeout(300);
  // destination search panel: Home / Work / favourite on top; one tap routes
  await p.click("#q"); await p.waitForTimeout(400); await p.shot("5-search-saved");
  const kinds = await p.$$eval("#search-results .row.saved", rs => rs.map(r => r.dataset.kind + ":" + r.querySelector(".n").textContent).join(","));
  check("search panel: " + kinds, kinds === "home:Home,work:Work,fav:friend");
  n = await p.evaluate(() => window.__rt); await p.click('#search-results .row.saved[data-kind="home"]'); await p.waitRoute(n + 1);
  check("one tap on Home routes", await open(p, "#sheet") && (await txt(p, "#s-dest")).startsWith("München"));
  await p.click("#s-cancel");
  // rename + delete a favourite, delete Home
  await p.click("#q"); await p.waitForTimeout(300);
  await p.click('#search-results .row.saved[data-kind="fav"] .edit'); await p.waitForTimeout(200);
  await p.click("#pf-clear"); await p.type("office"); await p.click("#pf-save"); await p.waitForTimeout(300);
  check("renamed to office", (await store(p, "places")).favs[0].name === "office" && (await txt(p, '#search-results .row.saved[data-kind="fav"] .n')) === "office");
  await p.click('#search-results .row.saved[data-kind="fav"] .edit'); await p.click("#pf-del"); await p.waitForTimeout(300);
  await p.click('#search-results .row.saved[data-kind="home"] .edit'); await p.waitForTimeout(200); await p.shot("6-edit-home");
  await p.click("#pf-del"); await p.waitForTimeout(300);
  const pl = await store(p, "places");
  check("favourite + Home deleted", !pl.favs.length && !pl.home && !(await p.$('#search-results .row.saved[data-kind="home"] .edit')));
  await p.click("#q-clear");
  // simulated drive with the options on: start, no page errors
  await search(p, "ingolstadt");
  await p.click("#s-sim"); await p.waitForTimeout(3000);
  check("simulated drive runs", await open(p, "#banner")); await p.shot("7-sim");
  await p.click("#btn-stop");
  console.log(p.errs.length ? "PAGE ERRORS (A):\n" + p.errs.join("\n") : "no page errors (A)");
  fails += p.errs.length;
}
// ---------- B: GPS fix at Marienplatz, Munich ----------
if (run("B")) {
  const p = await page([48.1371, 11.5754]);
  await p.waitForTimeout(1500);
  await search(p, "ingolstadt");
  check("start = Your location (GPS)", (await txt(p, "#s-from-name")) === "Your location");
  let n = await p.evaluate(() => window.__rt); await p.click("#s-swap"); await p.waitRoute(n + 1);
  check("swap from GPS: dest = Your location", (await txt(p, "#s-dest")) === "Your location");
  n = await p.evaluate(() => window.__rt); await p.click("#s-swap"); await p.waitRoute(n + 1);
  check("swap back: start = Your location", (await txt(p, "#s-from-name")) === "Your location" && (await txt(p, "#s-dest")).startsWith("Ingolstadt"));
  // a distant start (Freising), then Go: guidance re-routes from the car (GPS), with the options
  await p.click("#s-from"); await p.waitForTimeout(300); await p.type("freising"); await p.waitForTimeout(1500);
  n = await p.evaluate(() => window.__rt); await p.click("#search-results .row:has(.c.num) >> nth=0"); await p.waitRoute(n + 1);
  check("start = Freising", (await txt(p, "#s-from-name")).startsWith("Freising"));
  n = await p.evaluate(() => window.__rt);
  await p.click("#s-opts"); await p.click('#ro-list [data-opt="tolls"]'); await p.click("#ro-done"); await p.waitRoute(n + 1);
  check("start kept after an options change", (await txt(p, "#s-from-name")).startsWith("Freising") && p.routes.at(-1).costing_options.auto.use_tolls === 0);
  n = await p.evaluate(() => window.__rt); await p.click("#s-go"); await p.waitRoute(n + 1); await p.waitForTimeout(800);
  const r = p.routes.at(-1);
  check("Go re-routed from the GPS position with the options", Math.abs(r.locations[0].lat - 48.1371) < 1e-3 && r.costing_options.auto.use_tolls === 0);
  check("navigating", await open(p, "#banner")); await p.shot("8-go-from-here");
  await p.click("#btn-stop");
  console.log(p.errs.length ? "PAGE ERRORS (B):\n" + p.errs.join("\n") : "no page errors (B)");
  fails += p.errs.length;
}
// ---------- C: alternative routes (PN-35), stops (PN-37); GPS fix at Marienplatz, Munich ----------
const rt = p => p.evaluate(() => window.__rt);
const longY = Math.max(150, h * 0.2);   // a map point clear of the search bar and the sheet
if (run("C")) {
  const p = await page([48.1371, 11.5754]);
  await p.evaluate(() => localStorage.setItem("navpi.places", JSON.stringify({ home: null, work: null, favs: [{ name: "friend", ctx: "Test", lat: 48.2490, lon: 11.6510 }] })));
  await p.waitForTimeout(1500);
  await search(p, "ingolstadt"); await p.waitForTimeout(800);
  const r0 = p.routes.at(-1);
  check("preview asks for 2 alternates", r0.alternates === 2 && r0.locations.length === 2);
  const alts = await p.$$eval("#s-alts .alt", bs => bs.map(b => ({ t: b.querySelector("b").textContent, d: b.querySelector(".d").textContent, via: b.querySelector(".via").textContent, on: b.getAttribute("aria-checked") })));
  check("route choices: " + alts.map(a => `${a.t} ${a.d} ${a.via}`).join(" | "), alts.length >= 2 && alts[0].on === "true" && alts.every(a => a.via.startsWith("via ")));
  check("alternatives drawn grey on the map", await p.evaluate(() => __map.queryRenderedFeatures({ layers: ["route-alt-line"] }).length > 0));
  await p.shot("c1-alternatives");
  await p.click("#s-alts .alt >> nth=1"); await p.waitForTimeout(400);
  check("choice 2 selected, facts follow", (await p.$eval("#s-alts .alt:nth-child(2)", e => e.getAttribute("aria-checked"))) === "true" && (await txt(p, "#s-time")) === alts[1].t);
  // tap the grey line (now choice 1) on the map, at a point away from the blue route and the sheet
  const pt = await p.evaluate(() => {
    const m = __map, sh = document.getElementById("sheet").getBoundingClientRect(), c = m.getContainer().getBoundingClientRect();
    const pts = l => m.queryRenderedFeatures({ layers: [l] }).flatMap(f => f.geometry.type === "LineString" ? f.geometry.coordinates : f.geometry.coordinates.flat()).map(x => m.project(x));
    const main = pts("route-line");
    let best = null;   // the visible grey point farthest from the blue route (in portrait the two run close together)
    for (const q of pts("route-alt-line")) {
      const x = q.x + c.left, y = q.y + c.top;
      if (x < c.left + 30 || x > c.right - 30 || y < c.top + 120 || y > c.bottom - 30) continue;
      if (x >= sh.left - 20 && x <= sh.right + 20 && y >= sh.top - 20) continue;
      if (document.elementFromPoint(x, y) !== m.getCanvas()) continue;   // under a map button / card
      const d = Math.min(...main.map(r => Math.hypot(r.x - q.x, r.y - q.y)));
      if (d >= 14 && (!best || d > best.d)) best = { x, y, d };
    }
    return best;
  });
  if (pt) { await p.mouse.click(pt.x, pt.y); await p.waitForTimeout(400); }
  check("tap on the grey line selects it", !!pt && (await p.$eval("#s-alts .alt:nth-child(1)", e => e.getAttribute("aria-checked"))) === "true" && (await txt(p, "#s-time")) === alts[0].t);
  // stops: from search, from a long-press, from favourites
  await p.click("#s-addstop"); await p.waitForTimeout(300);
  check("add-stop search: placeholder, sheet hidden", (await p.getAttribute("#q", "placeholder")) === "Add a stop" && !(await open(p, "#sheet")));
  await p.type("hallbergmoos"); await p.waitForTimeout(1500);
  let n = await rt(p); await p.click("#search-results .row:has(.c.num) >> nth=0"); await p.waitRoute(n + 1);
  let r = p.routes.at(-1);
  check("stop from search: 3 locations, middle = break, no alternates asked", r.locations.length === 3 && r.locations[1].type === "break" && !r.alternates);
  check("sheet lists 1 stop, choices hidden", (await p.$$("#s-stops .stop")).length === 1 && await p.$eval("#s-alts", e => e.hidden));
  n = await rt(p); await longPress(p, w * 0.75, longY);
  check("pick sheet offers Add stop in a preview", await open(p, "#pick") && !(await p.$eval("#p-stop", e => e.hidden)));
  await p.shot("c2-pick-addstop");
  await p.click("#p-stop"); await p.waitRoute(n + 1);
  check("stop from long-press: 4 locations", p.routes.at(-1).locations.length === 4);
  await p.click("#s-addstop"); await p.waitForTimeout(400);
  n = await rt(p); await p.click('#search-results .row.saved[data-kind="fav"]'); await p.waitRoute(n + 1);
  const names = () => p.$$eval("#s-stops .stop .nm", es => es.map(e => e.textContent));
  let ns = await names();
  check("stop from favourites: " + ns.join(" > "), ns.length === 3 && ns[0].startsWith("Hallbergmoos") && ns[1] === "Marked point" && ns[2] === "friend");
  check("3 stops: Go button inside the screen", await p.$eval("#s-go", e => { const q = e.getBoundingClientRect(); return q.bottom <= innerHeight && q.top >= 0; }));
  check("stop buttons >= 56 px", await p.$$eval("#s-stops .ico", es => es.every(e => e.offsetWidth >= 56 && e.offsetHeight >= 56)));
  await p.shot("c3-three-stops");
  const tap = async (i, which) => { const k = await rt(p); await p.click(`#s-stops .stop:nth-child(${i + 1}) .ico >> nth=${which}`); await p.waitRoute(k + 1); };
  await tap(2, 0); await tap(1, 0);   // friend up twice
  ns = await names();
  check("reordered: " + ns.join(" > "), ns[0] === "friend" && ns[1].startsWith("Hallbergmoos") && Math.abs(p.routes.at(-1).locations[1].lat - 48.2490) < 1e-3);
  await tap(2, 2);                    // remove Marked point
  ns = await names(); check("removed: " + ns.join(" > "), ns.length === 2 && ns[1].startsWith("Hallbergmoos"));
  await tap(1, 1);                    // the last stop's down swaps it with the destination
  ns = await names();
  check("last stop down swaps with the destination", ns[1].startsWith("Ingolstadt") && (await txt(p, "#s-dest")).startsWith("Hallbergmoos"));
  await tap(1, 1);
  check("and back", (await txt(p, "#s-dest")).startsWith("Ingolstadt") && (await names())[1].startsWith("Hallbergmoos"));
  check("2 stop markers on the map", (await p.$$(".stoppin")).length === 2);
  await p.shot("c4-two-stops");
  n = await rt(p); await p.click("#s-swap"); await p.waitRoute(n + 1);
  ns = await names(); check("swap reverses the stops", ns[0].startsWith("Hallbergmoos") && ns[1] === "friend" && (await txt(p, "#s-dest")) === "Your location");
  await p.click("#s-cancel"); await p.waitForTimeout(300);
  check("cancel clears the stops and their markers", (await p.$$(".stoppin")).length === 0);
  await search(p, "freising");
  check("a new destination starts without stops", (await p.$$("#s-stops .stop")).length === 0 && p.routes.at(-1).locations.length === 2);
  await p.click("#s-cancel");
  console.log(p.errs.length ? "PAGE ERRORS (C):\n" + p.errs.join("\n") : "no page errors (C)");
  fails += p.errs.length;
}
// ---------- D: simulated drive through a stop (10x), parked car, walk back (PN-37, PN-39) ----------
if (run("D")) {
  const A = [48.1500, 11.5700], S = { name: "Stop S", ctx: "test", lat: 48.1470, lon: 11.5650 }, B = { name: "Dest B", ctx: "test", lat: 48.1440, lon: 11.5610 };
  const p = await page(A, true);
  await p.waitForTimeout(1500);
  let n = await rt(p);
  await p.evaluate(([d, s]) => Maps.preview(d, null, [s]), [B, S]); await p.waitRoute(n + 1);
  check("preview with one stop", (await p.$$("#s-stops .stop")).length === 1 && p.routes.at(-1).locations.length === 3);
  await p.click("#s-sim");
  const until = (fn, ms) => p.waitForFunction(fn, null, { timeout: ms }).then(() => true).catch(() => false);
  check("'Stop 1 reached' shown during the drive", await until(() => /Stop 1 reached/.test(document.getElementById("toast").textContent), 120000));
  await p.shot("d1-stop-reached");
  check("still navigating after the stop", await open(p, "#banner"));
  check("stop announced (stop_reached clip)", p.speaks.some(s => s.cue && s.cue[0] === "stop_reached"));
  check("reached stop marker dimmed", await p.$eval(".stoppin", e => e.classList.contains("done")));
  check("navpi:dest event for the trip log", JSON.stringify(await p.evaluate(() => window.__dest)) === JSON.stringify([{ from: "Your location", to: "Dest B" }]));
  check("banner says Arrived at the destination", await until(() => document.getElementById("b-dist").textContent === "Arrived", 120000));
  check("arrival announced (arrived clip)", p.speaks.some(s => s.cue && s.cue[0] === "arrived"));
  await p.waitForTimeout(7000);
  check("navigation ended by itself", !(await open(p, "#banner")));
  const pk = await store(p, "parked");
  check("parked car saved where the drive ended", !!pk && Math.abs(pk.lat - B.lat) < 0.002 && Math.abs(pk.lon - B.lon) < 0.003);
  check("parked-car marker on the map", (await p.$$(".parkpin")).length === 1);
  await p.click("#q"); await p.waitForTimeout(400); await p.shot("d2-parked-row");
  check("Parked car first in Saved places", (await p.$$eval("#search-results .row.saved", rs => rs[0] && rs[0].dataset.kind)) === "park");
  n = await rt(p); await p.click("#search-results .row.park .back"); await p.waitRoute(n + 1);
  const r = p.routes.at(-1);
  check("Navigate back = pedestrian route, no car options", r.costing === "pedestrian" && !r.costing_options);
  check("sheet: Parked car, Walking", (await txt(p, "#s-dest")) === "Parked car" && (await txt(p, "#s-ctx")).includes("Walking"));
  await p.shot("d3-walk-back");
  await p.click("#s-sim"); await p.waitForTimeout(1500);
  check("walk simulation runs", await open(p, "#banner"));
  await p.click("#btn-stop"); await p.waitForTimeout(400);
  check("ending a walk keeps the parked spot", (await store(p, "parked")).t === pk.t);
  await longPress(p, w * 0.75, longY);
  check("pick sheet: Park here, no Add stop outside a preview", await open(p, "#pick") && await p.$eval("#p-stop", e => e.hidden));
  await p.shot("d4-pick-park");
  await p.click("#p-park"); await p.waitForTimeout(300);
  const pk2 = await store(p, "parked");
  check("Park here saves the pressed point", !!pk2 && pk2.t > pk.t && (await p.$$(".parkpin")).length === 1);
  // the map follows the GPS fix, so the P marker can sit under the search bar: tap it by element
  n = await rt(p); await p.$eval(".parkpin", e => e.click()); await p.waitRoute(n + 1);
  check("tap on the P marker = walk back", p.routes.at(-1).costing === "pedestrian" && await open(p, "#sheet"));
  await p.click("#s-cancel"); await p.waitForTimeout(300);
  await p.click("#q"); await p.waitForTimeout(300);
  await p.click("#search-results .row.park .clear"); await p.waitForTimeout(300);
  check("forget: no parked car, marker or row", !(await store(p, "parked")) && !(await p.$(".parkpin")) && !(await p.$("#search-results .row.park")));
  await p.click("#q-clear");
  console.log(p.errs.length ? "PAGE ERRORS (D):\n" + p.errs.join("\n") : "no page errors (D)");
  fails += p.errs.length;
}
await b.close();
console.log(fails ? `${fails} FAILED` : "ALL PASS");
process.exit(fails ? 1 : 0);
