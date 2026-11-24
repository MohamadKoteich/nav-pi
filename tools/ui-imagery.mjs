// Satellite imagery (features/imagery), Playwright, headless Chromium. Recipe (see docs/TESTING.md):
//   python3 tools/build_edition.py --edition audio --out /tmp/img/build
//   NAV_DATA=/tmp/img/navdata with imagery/munich.mbtiles (offline/data/imagery), fonts, europe/map/BUILD-INFO, current -> europe
//   STICK folder with a small pack: python3 tools/imagery_extract.py <munich.mbtiles> <stick>/marienplatz.mbtiles --bounds 11.56,48.13,11.59,48.145 --maxzoom 16 --name "Marienplatz (USB)"
//   FAKE_USB_STATE=<state.json naming that folder as a stick> LSBLK=tests/fake-lsblk UDISKSCTL=tests/fake-udisksctl USB_POLL=1
//   IMAGERY_FAKE_FETCH=0.01 (downloads get blank tiles, NO network) TILES_URL=<pmtiles serve> VALHALLA_URL=<Valhalla 3.5.1>
//   NAV_PORT=18930 APP_DIR=/tmp/img/build/app EDITION_FILE=/tmp/img/build/edition.json python3 /tmp/img/build/navd/navd.py
//   node tools/ui-imagery.mjs [base-url] [out-dir] [WxH]
// Checks: toggle over Munich -> raster tiles 200 (jpeg/webp) under the labels; outside the pack no imagery request + the button
// says "no photos here"; day/night (dimmed at night, survives the style switch); remembered after reload; guiding with
// satellite (route above the photos); map button; Settings card (pack, USB file); download: map view + choose on map,
// detail levels, provider list (Bavaria recommended, EOX non-commercial note), size estimate, progress, done, delete;
// refused while guiding; USB import; no page errors.
import { createRequire } from "module";
const require = createRequire(import.meta.url);
const { chromium } = require(process.env.PLAYWRIGHT_DIR || "playwright");
const base = process.argv[2] || "http://127.0.0.1:18930";
const out = process.argv[3] || new URL("./shots", import.meta.url).pathname;
const [w, h] = (process.argv[4] || "1280x720").split("x").map(Number);
const tag = w > h ? "land" : "port";
const b = await chromium.launch({ args: ["--use-gl=angle", "--use-angle=swiftshader", "--enable-unsafe-swiftshader", "--ignore-gpu-blocklist"] });
let fails = 0;
const check = (name, ok, info) => { if (!ok) fails++; console.log((ok ? "PASS " : "FAIL ") + tag + " " + name + (info !== undefined ? "  " + info : "")); };
const MUNICH = { lat: 48.1374, lng: 11.5755 };
const api = (p, path, body) => p.evaluate(([path, body]) => fetch(path, body ? { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) } : {}).then(r => r.json()), [path, body]);

// start clean: packs from an earlier run of this test are removed (only ours: ids not "munich")
const ctx = await b.newContext({ viewport: { width: w, height: h }, hasTouch: true });
const p = await ctx.newPage();
p.errs = []; p.sat = [];
p.on("pageerror", e => p.errs.push(e.message));
p.on("console", m => m.type() === "error" && !/\/api\/display|\/api\/gps/.test(m.location().url || "") && p.errs.push(m.text()));
p.on("response", r => { if (r.url().includes("/sat/")) p.sat.push({ url: r.url(), status: r.status(), type: r.headers()["content-type"] }); });
await p.addInitScript(pos => {
  if (!sessionStorage.getItem("init")) {   // first load only; the reload keeps what the app stored
    sessionStorage.setItem("init", "1");
    localStorage.clear();
    localStorage.setItem("navpi.lastPos", JSON.stringify(pos)); localStorage.setItem("navpi.uiTheme", JSON.stringify("light"));
    localStorage.setItem("navpi.satellite", "false");   // the app's default is on (features/imagery/imagery.js): start from off
  }
  const ES = window.EventSource;   // no GPS receiver here
  window.EventSource = function (url) { return String(url).includes("/api/gps") ? { close() {} } : new ES(url); };
}, MUNICH);
const shot = n => p.screenshot({ path: `${out}/${tag}-imagery-${n}.png`, timeout: 90000 }).catch(e => console.log("shot " + n + " skipped: " + e.message.split("\n")[0]));
const loaded = () => p.waitForFunction(() => window.__map && window.__map.loaded(), null, { timeout: 60000 });
await p.goto(base + "/"); await loaded(); await p.waitForTimeout(1500);
for (const x of (await api(p, "/api/imagery")).packs) if (x.id !== "munich") await api(p, "/api/imagery/delete", { id: x.id });
await p.evaluate(() => Imagery.reload()); await p.waitForTimeout(500);

const layerInfo = () => p.evaluate(() => {
  const ls = window.__map.getStyle().layers.map(l => l.id), sat = ls.indexOf("sat-munich");
  const sym = window.__map.getStyle().layers.findIndex(l => l.type === "symbol");
  return { sat, sym, route: ls.indexOf("route-line"), n: ls.length,
    bright: sat >= 0 ? window.__map.getPaintProperty("sat-munich", "raster-brightness-max") : null,
    attrib: document.querySelector(".maplibregl-ctrl-attrib-inner")?.textContent || "" };
});

// A: the button + toggle over Munich
await p.evaluate(c => window.__map.jumpTo({ center: [c.lng, c.lat], zoom: 15 }), MUNICH);
check("A satellite button in the map-button stack", await p.$eval("#btn-sat", e => !e.hidden && e.parentElement.id === "fabs"));
check("A off at first: no imagery layer", (await layerInfo()).sat === -1);
await p.click("#btn-sat"); await p.waitForTimeout(2500);
let L = await layerInfo();
check("A on: raster layer under the first label layer", L.sat >= 0 && L.sat < L.sym, JSON.stringify(L));
check("A route layers above the photos", L.route > L.sat);
const ok = p.sat.filter(r => r.status === 200 && /^image\/(jpeg|webp|png)$/.test(r.type));   // tools/build_imagery.py stores jpg
check("A raster tiles served 200 (image)", ok.length >= 4, ok.length + " of " + p.sat.length);
check("A attribution shown (plain text)", /Bayerische Vermessungsverwaltung/.test(L.attrib) && !(await p.$(".maplibregl-ctrl-attrib-inner a[href*='bayern']")), L.attrib.slice(0, 80));
check("A button pressed", await p.$eval("#btn-sat", e => e.classList.contains("on") && e.getAttribute("aria-pressed") === "true"));
check("A remembered", await p.evaluate(() => localStorage.getItem("navpi.satellite")) === "true");
await shot("a-munich");

// C: outside the pack (Rosenheim): no imagery requests, the normal map shows, the button says so
let n0 = p.sat.length;
await p.evaluate(() => window.__map.jumpTo({ center: [12.1273, 47.8558], zoom: 14 })); await p.waitForTimeout(2000);
check("C outside the pack: no imagery requests", p.sat.length === n0, (p.sat.length - n0) + " requests");
check("C button shows 'no photos here'", await p.$eval("#btn-sat", e => e.classList.contains("nocov")));
await p.evaluate(c => window.__map.jumpTo({ center: [c.lng, c.lat], zoom: 15 }), MUNICH); await p.waitForTimeout(1500);
check("C back over Munich: covered again", await p.$eval("#btn-sat", e => !e.classList.contains("nocov")));

// B: night (dark UI -> night map style): the layer survives the style switch, dimmed
await p.evaluate(() => Theme.set("dark")); await p.waitForTimeout(3000);
L = await layerInfo();
check("B night: layer re-added after the style switch, dimmed", L.sat >= 0 && L.sat < L.sym && L.bright === 0.7, JSON.stringify(L));
await shot("b-night");
await p.evaluate(() => Theme.set("light")); await p.waitForTimeout(2500);
check("B day: full brightness", (await layerInfo()).bright === 1);

// D: remembered on the device
await p.reload(); await loaded(); await p.waitForTimeout(2500);
check("D after reload: still on", (await layerInfo()).sat >= 0);

// E: guiding with satellite (simulated drive Marienplatz -> Olympiapark, inside the pack)
await p.evaluate(c => window.__map.jumpTo({ center: [c.lng, c.lat], zoom: 14 }), MUNICH);
await p.evaluate(() => Maps.preview({ name: "Olympiapark", ctx: "test", lat: 48.1731, lon: 11.5520 }, { name: "Marienplatz", ctx: "test", lat: 48.1374, lon: 11.5755 }, []));
await p.waitForFunction(() => document.getElementById("sheet").classList.contains("open") && !document.getElementById("sheet").classList.contains("busy"), null, { timeout: 60000 }).catch(() => {});
await p.waitForTimeout(1500);
const routed = await p.$eval("#sheet", e => e.classList.contains("open"));
check("E route preview over the photos", routed);
if (routed) {
  await p.click("#s-sim"); await p.waitForTimeout(5000);
  L = await layerInfo();
  const st = await p.evaluate(() => Maps.ctx().state);
  check("E guiding: satellite on, route on top", st === "nav" && L.sat >= 0 && L.route > L.sat, st + " " + JSON.stringify(L));
  await shot("e-guiding");
  await p.evaluate(() => Theme.set("dark")); await p.waitForTimeout(3000);
  L = await layerInfo();
  check("E guiding at night: photos dimmed, route still on top", L.sat >= 0 && L.route > L.sat && L.bright === 0.7, JSON.stringify(L));
  await shot("e-guiding-night");
  await p.evaluate(() => Theme.set("light")); await p.waitForTimeout(2500);
  // I: download refused while guiding
  await p.click("#dock [data-go=settings]"); await p.click("#st-nav button[data-cat=sat]"); await p.waitForTimeout(1500);
  const est = await p.textContent("#sat-est"), dis = await p.$eval("#sat-start", e => e.disabled);
  check("I settings while guiding: Download disabled + notice", dis && /Not while driving/.test(est), dis + " " + est + " " + await p.evaluate(() => Maps.ctx().state));  await p.click("#settings-back"); await p.waitForTimeout(600);
  await p.click("#btn-stop").catch(() => {}); await p.waitForTimeout(1000);
}

// F: the map button is the only Map/Satellite switch (the quick tile was removed 2026-11-22)
check("F map button shows Satellite on", (await p.getAttribute("#btn-sat", "aria-pressed")) === "true");
await p.click("#btn-sat"); await p.waitForTimeout(800);
check("F map button -> layer removed", (await layerInfo()).sat === -1 && (await p.getAttribute("#btn-sat", "aria-pressed")) === "false");
await shot("f-map-button");
await p.click("#btn-sat"); await p.waitForTimeout(800);
check("F map button -> layer back", (await layerInfo()).sat >= 0);

// G: Settings card
await p.click("#dock [data-go=settings]"); await p.click("#st-nav button[data-cat=sat]"); await p.waitForTimeout(2500);
const card = await p.textContent("#sat-card");
check("G card lists Munich with size", /Munich/.test(card) && /\d(\.\d)? [GM]B(?! free)/.test(card), card.replace(/\s+/g, " ").slice(0, 200));   // size of the local pack (1.2 GB here)
check("G USB stick file listed", /Marienplatz \(USB\)/.test(await p.textContent("#sat-usb")) && !(await p.$eval("#sat-usb", e => e.hidden)));
await p.$eval("#sat-card", e => e.scrollIntoView({ block: "start" })); await p.waitForTimeout(300);
await shot("g-card");

// H: download: map view -> plan; Bavarian aerial recommended; levels; EOX non-commercial; choose on map; estimate; run
await p.click("#sat-view"); await p.waitForTimeout(1500);
const provs = await p.$$eval("#sat-provs .sat-prov", es => es.map(e => e.textContent));
check("H Bavarian DOP20 recommended first, EOX second", provs.length === 2 && /Bavarian DOP20 · Recommended/.test(provs[0]) && /EOX/.test(provs[1]), provs.join(" | "));
check("H EOX says non-commercial", /Non-commercial/.test(provs[1] || ""));
check("H estimate shown before starting", /About .*(kB|MB|GB) · .* tiles · .* free/.test(await p.textContent("#sat-est")), await p.textContent("#sat-est"));
await p.click("#sat-level [data-level=high]"); await p.waitForTimeout(1200);
const estHigh = await p.textContent("#sat-est");
await p.click("#sat-level [data-level=overview]"); await p.waitForTimeout(1200);
const estOv = await p.textContent("#sat-est");
check("H detail level changes the estimate", estHigh !== estOv, estHigh + " / " + estOv);
await p.click("#sat-pick"); await p.waitForTimeout(1200);
check("H choose on map: frame + bar on the map", await p.$eval("#maps", e => e.classList.contains("active") && e.classList.contains("sat-picking")) && await p.$eval("#sat-pickbar", e => e.classList.contains("open")));
await p.evaluate(() => window.__map.jumpTo({ center: [11.58, 48.14], zoom: 15 })); await p.waitForTimeout(800);
check("H the bar shows the framed area", /Area: .* km around 48\.1/.test(await p.textContent("#sp-est")), await p.textContent("#sp-est"));
await shot("h-pick");
await p.click("#sp-use"); await p.waitForTimeout(1800);
check("H back in Settings with that area", await p.$eval("#settings", e => e.classList.contains("active")) && /around 48\.14/.test(await p.textContent("#sat-area")), await p.textContent("#sat-area"));
await p.click("#sat-provs .sat-prov >> nth=1"); await p.waitForTimeout(400);   // EOX (small at overview: fast with the fake fetcher)
await shot("h-dialog");
const before = (await api(p, "/api/imagery")).packs.length;
await p.click("#sat-start"); await p.waitForTimeout(700);
check("H progress shown", !(await p.$eval("#sat-job", e => e.hidden)) && /Downloading/.test(await p.textContent("#sat-job-t")));
await shot("h-progress");
await p.waitForFunction(n => window.Imagery && Imagery.packs().length > n, before, { timeout: 60000 }).catch(() => {});
await p.waitForTimeout(800);
const after = (await api(p, "/api/imagery")).packs;
check("H download done: new pack listed", after.length === before + 1 && /EOX|Sentinel/.test(await p.textContent("#sat-packs")), after.map(x => x.id).join(","));

// J: USB import
await p.click("#sat-usb-list .btn.primary"); await p.waitForTimeout(400);
await p.waitForFunction(() => Imagery.packs().some(x => /Marienplatz/.test(x.name)), null, { timeout: 30000 }).catch(() => {});
check("J USB import -> pack listed", (await api(p, "/api/imagery")).packs.some(x => /Marienplatz/.test(x.name)));
await p.waitForTimeout(600);
await shot("j-imported");

// delete the test packs through the UI (two taps)
for (const id of (await api(p, "/api/imagery")).packs.map(x => x.id).filter(x => x !== "munich")) {
  const row = p.locator("#sat-packs .row", { hasText: (await api(p, "/api/imagery")).packs.find(x => x.id === id).name });
  await row.locator(".btn.danger").click(); await p.waitForTimeout(200); await row.locator(".btn.danger").click(); await p.waitForTimeout(1200);
}
check("delete (two taps) removes the test packs", (await api(p, "/api/imagery")).packs.map(x => x.id).join() === "munich");

// German strings present
await p.evaluate(() => { setLang("de"); Shell.relang(); }); await p.waitForTimeout(500);
check("de: card title + button label", /Satellitengebiete/.test(await p.textContent("#sat-card")) && await p.$eval("#btn-sat", e => e.getAttribute("aria-label")) === "Satelliten-Fotokarte");
await p.evaluate(() => { setLang("en"); Shell.relang(); });
check("no page errors", p.errs.length === 0, p.errs.slice(0, 3).join(" | "));
await b.close();
console.log(fails ? `RESULT: ${fails} FAIL` : "RESULT: ALL PASS");
process.exit(fails ? 1 : 0);
