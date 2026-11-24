// Places rail page (like a car navigator's "My Places"): Home / Work tiles, favourites, parked car, recents.
// Needs a local navd with search + routing (recipe: docs/TESTING.md):
//   python3 tools/build_edition.py --edition advanced --hardware 30-rpi4-8gb --out /tmp/places-b
//   APP_DIR=/tmp/places-b/app EDITION_FILE=/tmp/places-b/edition.json NAV_DATA=<dir with current -> oberbayern (or germany), fonts>
//   NAV_PORT=18080 NMCLI=tests/fake-nmcli NAV_SYSTEMCTL=tests/fake-systemctl TILES_URL=<pmtiles serve> VALHALLA_URL=<Valhalla>
//   python3 /tmp/places-b/navd/navd.py
//   node tools/ui-places.mjs [base-url] [out-dir] [WxH]
// /api/display answers 409 on a PC without a backlight, /api/safety/* 404 without safety data: not counted as page errors.
import { createRequire } from "module";
import { mkdirSync } from "fs";
const require = createRequire(import.meta.url);
const { chromium } = require(process.env.PLAYWRIGHT_DIR || "playwright");
const base = process.argv[2] || "http://127.0.0.1:18080";
const out = process.argv[3] || "/tmp/places-shots";
const [w, h] = (process.argv[4] || "1280x720").split("x").map(Number);
const tag = w > h ? "land" : "port";
mkdirSync(out, { recursive: true });
let fails = 0;
const check = (name, ok, info) => { if (!ok) fails++; console.log((ok ? "PASS " : "FAIL ") + name + (info ? "  (" + info + ")" : "")); };

const b = await chromium.launch({ args: ["--use-angle=swiftshader", "--enable-unsafe-swiftshader", "--ignore-gpu-blocklist"] });
const ctx = await b.newContext({ viewport: { width: w, height: h }, hasTouch: true });
const p = await ctx.newPage();
const errs = [], routes = [];
p.on("pageerror", e => errs.push(e.message));
p.on("console", m => m.type() === "error" && !envMiss(m.location().url) && errs.push(m.text()));
// a region without safety data (scripts/13-build-safety.sh is optional): /api/safety/along answers 404 during the simulated drive
const envMiss = u => /\/api\/display$|\/api\/safety\//.test(u || "");
p.on("response", r => { if (r.status() === 404 && !envMiss(r.url())) errs.push("404 " + r.url()); });
p.on("request", r => { if (r.url().endsWith("/api/route")) routes.push(JSON.parse(r.postData())); });
// GPS stand-in: one fix per second at Marienplatz, Munich (no receiver on the build box)
await p.addInitScript(() => {
  const ES = window.EventSource;
  window.EventSource = function (url) {
    if (!String(url).includes("/api/gps")) return new ES(url);
    const es = { close() {} };
    setInterval(() => es.onmessage && es.onmessage({ data: JSON.stringify({ receiver: true, mode: 3, lat: 48.1371, lon: 11.5754, speed: 0, track: 0 }) }), 1000);
    return es;
  };
});
await p.goto(base + "/");
await p.waitForFunction(() => window.__map && window.__map.loaded(), null, { timeout: 30000 });
await p.waitForTimeout(1500);
const shot = async n => { await p.waitForTimeout(700); return p.screenshot({ path: `${out}/${tag}-places-${n}.png`, timeout: 90000 }).catch(e => console.log("shot " + n + " skipped: " + e.message.split("\n")[0])); };
const kbType = async text => { for (const ch of text) await p.click(`#kbd button:text-is("${ch === " " ? "Space" : ch}")`); };
const store = k => p.evaluate(k => JSON.parse(localStorage.getItem("navpi." + k)), k);
const vis = sel => p.locator(sel).first().isVisible().catch(() => false);
const isOpen = sel => p.$eval(sel, e => e.classList.contains("open")).catch(() => false);
const state = () => p.evaluate(() => Maps.ctx().state);
const goPlaces = async () => { await p.click("#dock [data-go=places]"); await p.waitForTimeout(500); };
async function waitSheet() { await p.waitForSelector("#sheet.open", { timeout: 30000 }).catch(() => {}); await p.waitForTimeout(600); return isOpen("#sheet"); }
async function cancelPreview() { if (await isOpen("#sheet")) await p.click("#s-cancel"); await p.waitForTimeout(300); }
async function pickBySearch(text) {
  await p.waitForSelector("#pl-pick.open"); await p.waitForTimeout(300);
  await kbType(text);
  await p.waitForSelector("#pl-results .row .pl-d:not(:empty)", { timeout: 10000 }).catch(() => {});
  const name = await p.locator("#pl-results .row:has(.pl-d:not(:empty)) .n").first().textContent().catch(() => "");
  await p.click("#pl-results .row:has(.pl-d:not(:empty)) >> nth=0");
  await p.waitForTimeout(400);
  return name;
}
// designed at 56 UI px, measured on the glass: >= max(44, 56 x UI scale) (the Settings rule, docs/UI-RULES.md "Screen sizes")
const bigEnough = () => p.evaluate(() => { const min = Math.max(44, 56 * UiScale.value()) - 0.5;
  return [...document.querySelectorAll("#places button")].filter(e => {
    const r = e.getBoundingClientRect(); return r.width > 2 && r.height > 2 && getComputedStyle(e).visibility !== "hidden" && Math.min(r.width, r.height) < min;
  }).map(e => (e.id || e.className) + "=" + Math.round(e.getBoundingClientRect().height)); });

// ---------- rail entry ----------
const dock = await p.$$eval("#dock [data-go]", bs => bs.map(x => x.dataset.go));
check("rail entry Places visible", await vis("#dock [data-go=places]"));
check("rail order: Places right after Maps, Settings last", dock[0] === "maps" && dock[1] === "places" && dock.at(-1) === "settings", dock.join(" "));
await goPlaces();
check("Places page shows", await p.$eval("#places", e => e.classList.contains("active")));

// ---------- empty state ----------
check("empty: Home + Work tiles say Set …", (await p.locator("#pl-tiles .pl-tile.unset").count()) === 2 &&
  /Set Home/.test(await p.textContent("#pl-tiles")) && /Set Work/.test(await p.textContent("#pl-tiles")));
check("empty: favourites hint, no parked car, no recents", await vis("#pl-favs .pl-empty") && !(await vis("#pl-park-card")) && await vis("#pl-recent .pl-empty"));
await shot("empty");

// ---------- set Home by search (on-screen keyboard) ----------
await p.click("#pl-tiles [data-kind=home] .pl-tmain");
check("Set Home opens the picker with My position + Map centre", await isOpen("#pl-pick") && (await p.locator("#pl-results .row").count()) >= 2);
check("keyboard open for the search", await isOpen("#kbd"));
await shot("pick-home");
const homeName = await pickBySearch("garching");
const home = (await store("places") || {}).home;
check("Home stored in navpi.places.home", !!home && home.name === homeName, homeName);
check("Home tile shows the address + straight-line distance", !(await p.locator("#pl-tiles [data-kind=home].unset").count()) &&
  (await p.textContent("#pl-tiles [data-kind=home]")).includes(homeName) && /km/.test(await p.textContent("#pl-tiles [data-kind=home] .d")));
// the real drive time from the local route planner replaces it ("18 min · 16 km")
await p.waitForFunction(() => /min/.test(document.querySelector("#pl-tiles [data-kind=home] .d").textContent), null, { timeout: 15000 }).catch(() => {});
check("Home tile shows the real drive time", /min .* km/.test(await p.textContent("#pl-tiles [data-kind=home] .d")), await p.textContent("#pl-tiles [data-kind=home] .d"));
check("picker closed, keyboard hidden", !(await isOpen("#pl-pick")) && !(await isOpen("#kbd")));

// ---------- Home tile -> route preview (never guidance) ----------
let n0 = routes.length;
await p.click("#pl-tiles [data-kind=home] .pl-tmain");
check("Home tile -> Maps route preview", await waitSheet() && await p.$eval("#maps", e => e.classList.contains("active")) && (await p.textContent("#s-dest")) === homeName);
check("Home: state preview, not guiding", (await state()) === "preview");
const r0 = routes[n0];
check("Home: route from the GPS position to Home", !!r0 && Math.abs(r0.locations[0].lat - 48.1371) < 1e-3 && Math.abs(r0.locations.at(-1).lat - home.lat) < 1e-6 && r0.costing === "auto");
await shot("home-preview");
await cancelPreview();

// ---------- Work from the map centre ----------
await p.evaluate(() => window.__map.jumpTo({ center: [11.5504, 48.1687], zoom: 14 }));
await goPlaces();
await p.click("#pl-tiles [data-kind=work] .pl-tmain");
await p.waitForSelector("#pl-pick.open");
await p.click("#pl-results .row >> nth=1");   // Map centre
await p.waitForTimeout(300);
const work = (await store("places") || {}).work;
check("Work set from the map centre", !!work && Math.abs(work.lat - 48.1687) < 1e-3 && Math.abs(work.lon - 11.5504) < 1e-3);
n0 = routes.length;
await p.click("#pl-tiles [data-kind=work] .pl-tmain");
check("Work tile -> route preview", await waitSheet() && (await state()) === "preview" && !!routes[n0] && Math.abs(routes[n0].locations.at(-1).lon - work.lon) < 1e-6);
await cancelPreview();

// ---------- favourites: add, rename, move, delete with confirm ----------
await goPlaces();
await p.click("#pl-add");
const f1 = await pickBySearch("erding");
check("new favourite: name dialog prefilled", await isOpen("#pl-edit") && (await p.inputValue("#pl-name")) === f1, f1);
await p.fill("#pl-name", "Supermarket");
await p.click("#pl-save"); await p.waitForTimeout(300);
await p.click("#pl-add");
const f2 = await pickBySearch("dachau");
await p.click("#pl-save"); await p.waitForTimeout(300);
let favs = (await store("places")).favs;
check("two favourites stored, newest first", favs.length === 2 && favs[0].name === f2 && favs[1].name === "Supermarket", favs.map(f => f.name).join(","));
check("favourite rows shown", (await p.locator("#pl-favs .pl-row").count()) === 2);
await p.click("#pl-favs .pl-row >> nth=1 >> .pl-edit");
check("edit dialog: name, Up/Down, delete", await isOpen("#pl-edit") && await vis("#pl-up") && await vis("#pl-del"));
await shot("edit-fav");
await p.fill("#pl-name", "Supermarket 2"); await p.click("#pl-save"); await p.waitForTimeout(300);
favs = (await store("places")).favs;
check("rename stored", favs[1].name === "Supermarket 2" && (await p.textContent("#pl-favs .pl-row >> nth=1")).includes("Supermarket 2"));
await p.click("#pl-favs .pl-row >> nth=1 >> .pl-edit"); await p.click("#pl-up"); await p.click("#pl-edit-x"); await p.waitForTimeout(200);
favs = (await store("places")).favs;
check("move up reorders", favs[0].name === "Supermarket 2" && favs[1].name === f2);
await p.click("#pl-favs .pl-row >> nth=0 >> .pl-edit"); await p.click("#pl-del");
check("delete asks first", await vis("#pl-confirm"));
await shot("confirm-delete");
await p.click("#pl-cf-no"); await p.waitForTimeout(200);
check("cancel keeps it", (await store("places")).favs.length === 2);
if (await isOpen("#pl-edit")) await p.click("#pl-del"); else { await p.click("#pl-favs .pl-row >> nth=0 >> .pl-edit"); await p.click("#pl-del"); }
await p.click("#pl-cf-yes"); await p.waitForTimeout(300);
favs = (await store("places")).favs;
check("confirmed delete removes it", favs.length === 1 && favs[0].name === f2 && (await p.locator("#pl-favs .pl-row").count()) === 1);
// long-press a favourite row = edit
const fb = await p.locator("#pl-favs .pl-row .pl-rmain").first().boundingBox();
await p.mouse.move(fb.x + 60, fb.y + fb.height / 2); await p.mouse.down(); await p.waitForTimeout(900); await p.mouse.up(); await p.waitForTimeout(300);
check("long-press a row opens edit (no route)", await isOpen("#pl-edit") && !(await isOpen("#sheet")));
await p.click("#pl-edit-x");
n0 = routes.length;
await p.click("#pl-favs .pl-row .pl-rmain");
check("favourite row -> route preview", await waitSheet() && (await p.textContent("#s-dest")) === f2 && routes.length > n0);
await cancelPreview();

// ---------- same data as the search panel's Saved places, both ways ----------
await p.click("#q"); await p.waitForTimeout(500);
const saved = await p.$$eval("#search-results .row.saved", rs => rs.map(r => r.dataset.kind + ":" + r.querySelector(".n").textContent + "|" + r.querySelector(".c").textContent));
check("search panel Saved places = Places page (Home, Work, favourite)", saved.some(s => s.startsWith("home:") && s.includes(homeName)) &&
  saved.some(s => s.startsWith("work:") && !s.includes("Not set")) && saved.some(s => s === "fav:" + f2 + "|" + (favs[0].ctx || "")), saved.join(" ; "));
await p.click("#q-clear"); await p.waitForTimeout(300);
await p.evaluate(() => Maps.preview({ name: "Allianz Arena", ctx: "Test", lat: 48.2188, lon: 11.6236 }, null, []));
await waitSheet();
await p.click("#s-save"); await p.fill("#pf-name", "From maps"); await p.click("#pf-save"); await p.waitForTimeout(300);
await cancelPreview();
await goPlaces();
check("a favourite saved on the map shows on Places", (await p.textContent("#pl-favs")).includes("From maps"));

// ---------- recents ----------
await p.evaluate(() => localStorage.setItem("navpi.recents", JSON.stringify([{ name: "München Hbf", ctx: "München", lat: 48.1402, lon: 11.5600 }, { name: "Allianz Arena", ctx: "Test", lat: 48.2188, lon: 11.6236 }])));
await p.click("#dock [data-go=maps]"); await goPlaces();
check("recents rows shown", (await p.locator("#pl-recent .pl-row").count()) === 2 && (await p.textContent("#pl-recent")).includes("München Hbf"));
check("a recent that is already saved has no star", (await p.locator("#pl-recent .pl-row >> nth=1 >> .pl-edit").count()) === 0);
await p.click("#pl-recent .pl-row >> nth=0 >> .pl-edit");
check("star on a recent = save as favourite", await isOpen("#pl-edit") && (await p.inputValue("#pl-name")) === "München Hbf");
await p.click("#pl-edit-x");
n0 = routes.length;
await p.click("#pl-recent .pl-row >> nth=0 >> .pl-rmain");
check("recent row -> route preview", await waitSheet() && (await p.textContent("#s-dest")) === "München Hbf" && routes.length > n0);
await cancelPreview();

// ---------- parked car ----------
await p.evaluate(() => localStorage.setItem("navpi.parked", JSON.stringify({ lat: 48.1390, lon: 11.5790, t: Date.now() - 3600e3 })));
await goPlaces();
check("parked car row shown", await vis("#pl-park-card") && (await p.locator("#pl-park .pl-row").count()) === 1);
await shot("filled");
n0 = routes.length;
await p.click("#pl-park .pl-rmain");
check("parked car -> walking preview", await waitSheet() && !!routes[n0] && routes[n0].costing === "pedestrian" && /Walking/.test(await p.textContent("#s-ctx")));
await cancelPreview();

// ---------- while driving: a tap asks before replacing the route ----------
await goPlaces();
await p.click("#pl-tiles [data-kind=home] .pl-tmain"); await waitSheet();
await p.click("#s-sim"); await p.waitForTimeout(1500);
check("simulated drive started (by the user's Simulate tap)", (await state()) === "nav");
await goPlaces();
n0 = routes.length;
await p.click("#pl-tiles [data-kind=work] .pl-tmain"); await p.waitForTimeout(300);
check("while driving: confirm before changing the destination", await vis("#pl-confirm") && (await p.textContent("#pl-cf-t")).includes("Work"));
await p.click("#pl-cf-no"); await p.waitForTimeout(300);
check("cancel keeps the drive and routes nothing", (await state()) === "nav" && routes.length === n0);
await p.click("#dock [data-go=maps]"); await p.waitForTimeout(300);
await p.click("#btn-stop").catch(() => {}); await p.waitForTimeout(800);

// ---------- touch targets, theme, German strings ----------
await goPlaces();
const small = await bigEnough();
check("Places: every button >= max(44, 56 x UI scale) px", small.length === 0, small.slice(0, 6).join(" "));
const missing = await p.evaluate(() => Object.keys(I18N.en).filter(k => (k.startsWith("pl.") || k === "app.places") && !(k in I18N.de)));
check("every Places string has German", missing.length === 0, missing.join(" "));
await p.evaluate(() => document.documentElement.setAttribute("data-ui", "light")); await p.waitForTimeout(200);
await shot("filled-light");
await p.evaluate(() => document.documentElement.setAttribute("data-ui", "dark")); await p.waitForTimeout(200);
await shot("filled-dark");
await p.click("#pl-tiles [data-kind=home] .pl-edit");
check("Home edit: change + delete, no name field", await isOpen("#pl-edit") && await vis("#pl-change") && !(await vis("#pl-name")));
await p.click("#pl-edit-x");
check("no page errors", errs.length === 0, errs.slice(0, 3).join(" | "));
await b.close();
console.log(fails ? `RESULT: ${fails} FAIL` : "RESULT: ALL PASS");
process.exit(fails ? 1 : 0);
