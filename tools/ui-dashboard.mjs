// Split-screen dashboard (PN-47) + service reminders (PN-51), Playwright.
//   node tools/ui-dashboard.mjs [audio-base-url] [basic-base-url] [out-dir]
// Needs two local navd (audio + basic builds of tools/build_edition.py) with VALHALLA_URL for a real route and a
// throw-away NAV_DATA (this test deletes every reminder it finds). Map tiles optional (tile errors are ignored).
// GPS is not mocked through gpsd: movement for the car notice is sent as "navpi:pos" events, guidance by a simulated drive.
import { createRequire } from "module";
const require = createRequire(import.meta.url);
const { chromium } = require(process.env.PLAYWRIGHT_DIR || "playwright");
const base = process.argv[2] || "http://127.0.0.1:18471";
const basic = process.argv[3] || "http://127.0.0.1:18472";
const out = process.argv[4] || new URL("./shots", import.meta.url).pathname;
const b = await chromium.launch({ args: ["--use-angle=swiftshader", "--enable-unsafe-swiftshader", "--ignore-gpu-blocklist"] });
let fails = 0;
const check = (name, ok, info) => { if (!ok) fails++; console.log((ok ? "PASS " : "FAIL ") + name + (info != null ? "  (" + info + ")" : "")); };
const IGN = /tiles|fonts|glyphs|api\/display|bluetooth|api\/bt|api\/wifi|api\/media\/phone/;

async function page(url, w, h, ctxIn) {
  const ctx = ctxIn || await b.newContext({ viewport: { width: w, height: h }, hasTouch: true });
  const p = await ctx.newPage();
  p.errs = [];
  p.on("pageerror", e => p.errs.push(e.message));
  p.on("console", m => m.type() === "error" && !IGN.test(m.text() + " " + (m.location().url || "")) && p.errs.push(m.text() + " @ " + m.location().url));
  await p.goto(url + "/"); await p.waitForTimeout(3000);
  p.ctx = ctx;
  return p;
}
const vis = (p, sel) => p.locator(sel).isVisible();
const geo = p => p.evaluate(() => ({ views: document.getElementById("views").clientWidth, map: document.getElementById("map").clientWidth,
  canvas: window.__map ? window.__map.getCanvas().clientWidth : -1, dash: document.getElementById("dash").getBoundingClientRect().width }));
const shot = (p, n) => p.screenshot({ path: `${out}/${n}.png` });

// ---------------- PN-47 dashboard, audio edition, landscape ----------------
if (!process.env.ONLY || process.env.ONLY.includes("dash")) {
  const p = await page(base, 1280, 720);
  await p.evaluate(() => localStorage.removeItem("navpi.dash")); await p.reload(); await p.waitForTimeout(3000);
  check("map button visible in landscape", await vis(p, "#btn-dash"));
  check("dashboard off by default", !(await vis(p, "#dash")));
  await p.click("#btn-dash"); await p.waitForTimeout(600);
  let g = await geo(p);
  check("split on: dashboard visible", await vis(p, "#dash"));
  check("map ~62 % wide and canvas resized", Math.abs(g.map / g.views - 0.62) < 0.02 && Math.abs(g.canvas - g.map) <= 1, JSON.stringify(g));
  check("clock shown", /\d\d?[:.]\d\d/.test(await p.textContent("#d-time")));
  check("media card: nothing playing + Open Media", await vis(p, "#d-np") && await vis(p, "#d-np-open") && !(await vis(p, "#d-np-play")));
  await p.evaluate(() => Shell.nowPlaying({ title: "Test song — Test artist", playing: true, toggle: () => { window.__tog = (window.__tog || 0) + 1; } }));
  await p.waitForTimeout(200);
  check("now playing title", (await p.textContent("#d-np-title")).includes("Test song"));
  check("pause icon while playing", (await p.getAttribute("#d-np-play use", "href")) === "#i-pause");
  await p.click("#d-np-play"); await p.waitForTimeout(100);
  check("play/pause button calls the media toggle", await p.evaluate(() => window.__tog === 1));
  check("next is wired to Media.next", await p.evaluate(() => typeof window.Media.next === "function"));
  await p.evaluate(() => window.__map.jumpTo({ center: [11.6000, 48.1200], zoom: 14 }));
  await p.evaluate(() => Maps.preview({ name: "Test", ctx: "Simulated", lat: 48.0770, lon: 11.9700 }));
  await p.waitForTimeout(3500);
  await p.click("#s-sim"); await p.waitForTimeout(6000);
  check("guiding: maneuver card", await vis(p, "#d-man") && (await p.textContent("#d-dist")).trim().length > 0, await p.textContent("#d-dist"));
  check("guiding: arrival + distance left", /\d[:.]\d\d/.test(await p.textContent("#d-arrive")) && /km|m/.test(await p.textContent("#d-left")),
    (await p.textContent("#d-arrive")) + " / " + (await p.textContent("#d-left")));
  check("guiding: speed shown", /^\d+$/.test((await p.textContent("#d-speed")).trim()), await p.textContent("#d-speed"));
  // frame rate while the simulated drive moves the camera (software GL here: informative, the Pi is measured separately)
  const fps = await p.evaluate(() => new Promise(r => { let n = 0; const t0 = performance.now();
    const f = () => { n++; if (performance.now() - t0 < 3000) requestAnimationFrame(f); else r(Math.round(n / 3)); }; requestAnimationFrame(f); }));
  const textWrites = await p.evaluate(() => new Promise(r => { let n = 0; const mo = new MutationObserver(m => { n += m.length; });
    mo.observe(document.getElementById("dash"), { subtree: true, childList: true, characterData: true }); setTimeout(() => { mo.disconnect(); r(n); }, 3000); }));
  console.log("info: rAF " + fps + " fps (swiftshader), dashboard DOM mutations in 3 s: " + textWrites);
  check("dashboard updates at most ~1 Hz", textWrites <= 3 * 8, textWrites);
  await shot(p, "land-dash-1-guiding");
  await p.click("#btn-stop"); await p.waitForTimeout(1500);
  check("after stop: trip A row, no maneuver", !(await vis(p, "#d-man")) && await vis(p, "#d-tripa"));
  await shot(p, "land-dash-2-browse");
  await p.click("#dock [data-go=settings]"); await p.click("#st-nav button[data-cat=display]"); await p.waitForTimeout(500);
  check("Settings > Screen switch says On", (await p.getAttribute("#q-dash", "aria-checked")) === "true");
  await shot(p, "land-dash-3-settings");
  await p.click("#q-dash"); await p.waitForTimeout(300);
  await p.click("#dock [data-go=maps]"); await p.waitForTimeout(600);
  g = await geo(p);
  check("off from Settings: full-width map, canvas resized", !(await vis(p, "#dash")) && g.map === g.views && Math.abs(g.canvas - g.map) <= 1, JSON.stringify(g));
  await p.reload(); await p.waitForTimeout(3000);
  check("off remembered", !(await vis(p, "#dash")));
  await p.click("#btn-dash"); await p.reload(); await p.waitForTimeout(3000);
  check("on remembered", await vis(p, "#dash"));
  await p.click("#dock [data-go=media]"); await p.waitForTimeout(500);
  check("only on the Maps screen", !(await vis(p, "#dash")));
  await p.click("#dock [data-go=maps]"); await p.waitForTimeout(500);
  check("page errors (landscape)", p.errs.length === 0, p.errs.join(" | "));
  await p.ctx.close();
}
// ---------------- portrait: off ----------------
if (!process.env.ONLY || process.env.ONLY.includes("dash")) {
  const ctx = await b.newContext({ viewport: { width: 720, height: 1280 }, hasTouch: true });
  await ctx.addInitScript(() => localStorage.setItem("navpi.dash", "true"));
  const p = await page(base, 0, 0, ctx);
  const g = await geo(p);
  check("portrait: no split even when on", !(await vis(p, "#dash")) && !(await vis(p, "#btn-dash")) && g.map === g.views, JSON.stringify(g));
  await p.click("#dock [data-go=settings]"); await p.click("#st-nav button[data-cat=display]"); await p.waitForTimeout(500);
  check("portrait: switch disabled with hint", await p.isDisabled("#q-dash") && await vis(p, "#q-dash-hint"));
  await shot(p, "port-dash-settings");
  check("page errors (portrait)", p.errs.length === 0, p.errs.join(" | "));
  await ctx.close();
}
// ---------------- basic edition: no media card ----------------
if (!process.env.ONLY || process.env.ONLY.includes("dash")) {
  const p = await page(basic, 1280, 720);
  await p.click("#btn-dash"); await p.waitForTimeout(700);
  const g = await geo(p);
  check("basic: split works", await vis(p, "#dash") && Math.abs(g.canvas - g.map) <= 1, JSON.stringify(g));
  check("basic: no media card", !(await vis(p, "#d-np")));
  check("basic: trip A row", await vis(p, "#d-tripa"));
  await shot(p, "land-dash-basic");
  check("page errors (basic)", p.errs.length === 0, p.errs.join(" | "));
  await p.ctx.close();
}

// ---------------- PN-51 service reminders ----------------
// the floating keyboard (features/core/keyboard.js) types a letter on pointer up (a hold opens variants): real clicks
async function typeKeys(p, s) { for (const ch of s) await p.click(`#kbd .kb-keys button:text-is(${JSON.stringify(ch)})`); }
const kbDone = p => p.click("#kbd button.w.ok");
async function saveEd(p, tag, what) {
  await p.click("#ce-save"); await p.waitForTimeout(500);
  const open = await vis(p, "#car-edit");
  check(tag + ": saved " + what, !open, open ? await p.textContent("#ce-err") : null);
  if (open) await p.click("#ce-cancel");
}
for (const [w, h, tag] of (process.env.ONLY && !process.env.ONLY.includes("car")) ? [] : [[1280, 720, "land"], [720, 1280, "port"]]) {
  const p = await page(base, w, h);
  const all = await p.evaluate(() => fetch("/api/car").then(r => r.json()));
  for (const it of all.items) await p.evaluate(id => fetch("/api/car/delete", { method: "POST", body: JSON.stringify({ id }) }), it.id);
  await p.click("#dock [data-go=settings]"); await p.click("#st-nav button[data-cat=car]"); await p.waitForTimeout(800);
  await p.evaluate(() => document.getElementById("car-card").scrollIntoView());
  // odometer by keyboard
  await p.click("#car-odo-btn"); await p.waitForTimeout(300);
  check(tag + ": odometer editor + keyboard", await vis(p, "#ce-odo") && await vis(p, "#kbd"));
  await typeKeys(p, "50000"); await kbDone(p);
  await saveEd(p, tag, "odometer");
  check(tag + ": km shown", /50.000/.test(await p.textContent("#car-km")), await p.textContent("#car-km"));
  // inspection due this month (12 steps back from the default +12)
  await p.click("#car-add"); await p.waitForTimeout(300);
  await p.click('#ce-kinds [data-kind="inspection"]');
  for (let i = 0; i < 12; i++) await p.click("#ce-m-minus");
  await shot(p, tag + "-car-1-editor");
  await saveEd(p, tag, "inspection");
  // custom by km, already passed
  await p.click("#car-add"); await p.waitForTimeout(300);
  await p.click('#ce-kinds [data-kind="custom"]');
  await p.click("#ce-name"); await typeKeys(p, "brakes"); await kbDone(p);
  await p.click("#ce-date-on");
  await p.click("#ce-km"); await typeKeys(p, "49000"); await kbDone(p);
  await saveEd(p, tag, "custom");
  // oil with defaults (in 15 000 km / 12 months)
  await p.click("#car-add"); await p.waitForTimeout(300); await saveEd(p, tag, "oil");
  const rows = await p.locator("#car-list .car-item").allTextContents();
  check(tag + ": three reminders, two due", rows.length === 3 && rows.filter(r => /Due/.test(r)).length === 2, rows.join(" | "));
  await shot(p, tag + "-car-2-list");
  await p.evaluate(() => window.dispatchEvent(new CustomEvent("navpi:pos", { detail: { lat: 48, lng: 8, speed: 20, src: "gps" } })));
  await p.click("#car-add"); await p.waitForTimeout(300);
  check(tag + ": editor refused while moving", !(await vis(p, "#car-edit")) && /stopped/.test(await p.textContent("#toast")));
  // notice at start (stopped)
  await p.reload(); await p.waitForTimeout(11500);
  check(tag + ": due notice at start", await vis(p, "#car-notice") && /Service due/.test(await p.textContent("#car-notice")), await p.textContent("#car-notice"));
  await shot(p, tag + "-car-3-notice");
  await p.evaluate(() => window.dispatchEvent(new CustomEvent("navpi:pos", { detail: { lat: 48, lng: 8, speed: 15, src: "gps" } })));
  await p.waitForTimeout(500);
  check(tag + ": notice gone when moving", !(await p.evaluate(() => document.getElementById("car-notice").classList.contains("open"))));
  await p.evaluate(() => window.dispatchEvent(new CustomEvent("navpi:nav", { detail: { type: 1 } })));
  await p.waitForTimeout(5500);
  await p.evaluate(() => Car.check()); await p.waitForTimeout(500);
  check(tag + ": no notice while guiding", !(await p.evaluate(() => document.getElementById("car-notice").classList.contains("open"))));
  await p.evaluate(() => window.dispatchEvent(new CustomEvent("navpi:nav", { detail: null })));
  await p.evaluate(() => Car.check()); await p.waitForTimeout(500);
  const first = await p.textContent("#car-notice .t");
  await p.click("#cn-done"); await p.waitForTimeout(500);
  await p.evaluate(() => Car.check()); await p.waitForTimeout(500);
  const second = await p.textContent("#car-notice .t");
  check(tag + ": Done rolls on, next due shown", first !== second, first + " -> " + second);
  await p.click("#cn-later"); await p.waitForTimeout(500);
  await p.reload(); await p.waitForTimeout(11500);
  check(tag + ": Tomorrow = no notice now", !(await p.evaluate(() => { const n = document.getElementById("car-notice"); return !!n && n.classList.contains("open"); })));
  const st = await p.evaluate(() => fetch("/api/car").then(r => r.json()));
  check(tag + ": stored on the Pi (navd file)", st.items.length === 3 && st.items.filter(i => i.state === "due" && !i.snoozed).length === 0, JSON.stringify(st.items.map(i => [i.kind, i.state, i.snoozed])));
  await p.evaluate(() => { setLang("de"); Shell.relang(); });
  await p.click("#dock [data-go=settings]"); await p.click("#st-nav button[data-cat=car]"); await p.waitForTimeout(800);
  check(tag + ": German card", /Wartungserinnerungen/.test(await p.textContent("#car-card")));
  await p.evaluate(() => { setLang("en"); Shell.relang(); });
  check(tag + ": page errors (car)", p.errs.length === 0, p.errs.join(" | "));
  await p.ctx.close();
}
await b.close();
console.log(fails ? fails + " FAIL" : "ALL PASS");
process.exit(fails ? 1 : 0);
