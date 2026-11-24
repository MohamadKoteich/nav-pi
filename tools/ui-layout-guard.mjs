// Layout guard: nothing may be cut off, nothing may scroll the page, and the page can never be zoomed.
// Written 2026-11-12 after a pinch zoomed the kiosk 1.32x on the Pi and every edge (dock, status bar,
// sheet buttons) was off screen with no way back by touch. Run it after every UI change.
//   node tools/ui-layout-guard.mjs <base-url> [shots-dir]  local build, the screen matrix below (SIZES=800x480,… to narrow it)
//   node tools/ui-layout-guard.mjs --cdp [cdp-url]       the real Pi screen (ssh -N -L 19222:127.0.0.1:9222 nav@nav-pi.local)
// Checks on every screen (map, search panel, every Settings category top + bottom, every rail page, the filled Places page with its picker and edit panel, split screen):
//   - page scale 1 (visualViewport), viewport meta forbids zoom, html touch-action has no pinch-zoom
//   - the document does not scroll (scrollWidth/Height <= client size)
//   - no visible control (button, input, [role=button], .chip) is PARTLY outside the window: fully outside
//     is allowed (sheets parked off screen), partly outside = cut off = FAIL. A control inside a scrolling
//     list may be scrolled out of view; then the LIST itself must be fully inside the window.
//   - no control is covered by another control of the same layer (two buttons on one spot)
//   - (2026-11-22, any screen) every visible control >= 44 px on both sides, the keyboard's keys included; Settings and
//     Places controls >= max(44, 56 x UI scale);
//     status bar: nothing overflows it, no text in it is clipped, the clock stays >= 20 px; the UI scale (--ui-s) is set
// Screen matrix (local): 800x480 1024x600 1280x720 1280x800 1920x1080 480x320 720x1280 600x1024 (+ 1920x1200, 480x800);
// with a shots dir each size leaves <size>-map / -settings / -page / -guiding .png there.
// --cdp also pinches over the status bar and asserts the page scale stays 1.
import { createRequire } from "module";
const require = createRequire(import.meta.url);
const { chromium } = require(process.env.PLAYWRIGHT_DIR || "playwright");
const cdp = process.argv[2] === "--cdp";
const shots = !cdp && process.argv[3];
const SIZES = (process.env.SIZES || "800x480,1024x600,1280x720,1280x800,1920x1080,1920x1200,480x320,720x1280,600x1024,480x800").split(",").map(x => x.split("x").map(Number));
let fails = 0;
const check = (name, ok, info) => { if (!ok) fails++; console.log((ok ? "PASS " : "FAIL ") + name + (info ? "  (" + info + ")" : "")); };

const probe = p => p.evaluate(() => {
  const W = innerWidth, H = innerHeight, de = document.documentElement, cut = [], covered = [];
  for (const e of document.querySelectorAll("button, input, [role=button], .chip, .card")) {
    let hidden = false;
    for (let a = e; a; a = a.parentElement) { const cs = getComputedStyle(a); if (cs.display === "none" || cs.visibility === "hidden" || +cs.opacity === 0) { hidden = true; break; } }
    if (hidden) continue;
    let box = e;
    for (let a = e.parentElement; a && a !== document.body; a = a.parentElement) {
      const cs = getComputedStyle(a);
      if (/auto|scroll/.test(cs.overflowY + cs.overflowX) && (a.scrollHeight > a.clientHeight + 1 || a.scrollWidth > a.clientWidth + 1)) { box = a; break; }
    }
    const r = box.getBoundingClientRect(); if (r.width < 2 || r.height < 2) continue;
    if (box !== e) { const er = e.getBoundingClientRect(); if (er.bottom <= r.top || er.top >= r.bottom) { /* scrolled away inside the list */ } }
    const inside = r.left >= -1 && r.top >= -1 && r.right <= W + 1 && r.bottom <= H + 1;
    const outside = r.right <= 0 || r.bottom <= 0 || r.left >= W || r.top >= H;
    if (box === e && inside) {   // covered: another control of the same layer sits on this one's centre (2026-11-12: split-screen fab over the along fab)
      const hit = document.elementFromPoint((r.left + r.right) / 2, (r.top + r.bottom) / 2);
      const hb = hit && hit.closest("button, input, [role=button]");
      if (hb && hb !== e && !e.contains(hb) && !hb.contains(e) && (hb.parentElement === e.parentElement || (hb.classList.contains("fab") && e.classList.contains("fab"))))
        covered.push((e.id || e.className.toString().slice(0, 24)) + " under " + (hb.id || hb.className.toString().slice(0, 24)));
    }
    if (!inside && !outside) cut.push((box !== e ? "list " + (box.id || box.className.toString().slice(0, 20)) + ">" : "") + (e.id || e.className.toString().slice(0, 24) || e.tagName) + "@" + [r.left, r.top, r.right, r.bottom].map(Math.round));
  }
  // touch targets (2026-11-22): every visible control in the viewport >= 44 px; Settings ones >= max(44, 56 x UI scale)
  const ui = parseFloat(getComputedStyle(de).getPropertyValue("--ui-s")) || 1, small = [];
  for (const e of document.querySelectorAll("#app button, #app input, #app [role=button]")) {
    const r = e.getBoundingClientRect();
    if (r.width < 2 || r.height < 2 || r.right <= 0 || r.bottom <= 0 || r.left >= W || r.top >= H) continue;
    let hid = false;
    for (let a = e; a; a = a.parentElement) { const cs = getComputedStyle(a); if (cs.display === "none" || cs.visibility === "hidden" || +cs.opacity === 0) { hid = true; break; } }
    if (hid) continue;
    const min = e.closest("#settings") ? Math.max(44, 56 * ui) : 44;
    if (Math.min(r.width, r.height) < min - 0.5) small.push((e.id || e.className.toString().slice(0, 20) || e.tagName) + "=" + Math.round(r.width) + "x" + Math.round(r.height) + "<" + Math.round(min));
  }
  // status bar: no child outside it, no clipped text, clock readable
  const st = document.getElementById("status"), sr = st.getBoundingClientRect(), stbad = [];
  for (const c of st.querySelectorAll("*")) {
    const r = c.getBoundingClientRect(), cs = getComputedStyle(c);
    if (r.width < 1 || cs.display === "none" || c.closest("[hidden]")) continue;
    if (r.left < sr.left - 1 || r.right > sr.right + 1 || r.top < sr.top - 1 || r.bottom > sr.bottom + 1) stbad.push((c.id || (c.className.baseVal ?? c.className)) + " outside");
    if (c.matches(".clock") && c.scrollWidth > c.clientWidth + 1) stbad.push("clock clipped");
  }
  const clock = document.getElementById("clock"), clockPx = clock ? parseFloat(getComputedStyle(clock).fontSize) * (clock.getBoundingClientRect().height / (clock.offsetHeight || 1)) : 0;
  return {
    ui, small, stbad, clockPx: +clockPx.toFixed(1),
    scale: visualViewport ? +visualViewport.scale.toFixed(3) : 1,
    meta: document.querySelector("meta[name=viewport]")?.content || "",
    touch: getComputedStyle(de).touchAction,
    scroll: [de.scrollWidth - de.clientWidth, de.scrollHeight - de.clientHeight, document.body.scrollWidth - document.body.clientWidth],
    cut, covered,
  };
});

async function screen(p, tag, name) {
  const r = await probe(p);
  const t = tag + " " + name;
  check(t + ": page scale 1", r.scale === 1, "scale " + r.scale);
  check(t + ": no page scroll", r.scroll.every(v => v <= 0), r.scroll.join(","));
  check(t + ": nothing cut off", r.cut.length === 0, r.cut.slice(0, 6).join(" "));
  check(t + ": no control covered by another", r.covered.length === 0, r.covered.slice(0, 6).join(" "));
  check(t + ": touch targets >= 44 px (Settings >= 56 x " + r.ui + ")", r.small.length === 0, r.small.slice(0, 6).join(" "));
  check(t + ": status bar fits, clock >= 20 px", r.stbad.length === 0 && r.clockPx >= 20, r.stbad.slice(0, 4).join(" ") + " clock " + r.clockPx + "px");
  return r;
}
const tryClick = async (p, sel) => { if (await p.locator(sel).first().isVisible().catch(() => false)) { await p.locator(sel).first().click(); return true; } return false; };

async function run(p, tag) {
  const r = await screen(p, tag, "map");
  check(tag + ": viewport meta forbids zoom", /user-scalable=no/.test(r.meta) && /maximum-scale=1\b/.test(r.meta), r.meta);
  check(tag + ": html touch-action has no pinch-zoom", !/manipulation|auto|pinch-zoom/.test(r.touch), r.touch);
  if (await tryClick(p, "#q")) { await p.waitForTimeout(500); await screen(p, tag, "search panel"); await p.evaluate(() => document.getElementById("q-clear")?.click()); await p.waitForTimeout(400); }   // on a 3.5" screen the keyboard covers it
  // Settings (2026-11-22): a dock entry, category rail + pane. Every category, top and bottom of its pane.
  check(tag + ": no quick panel / chevron left", !(await p.locator("#qs, #qs-btn").count()));
  if (await tryClick(p, "#dock [data-go=settings]")) {
    await p.waitForTimeout(800);
    const cats = await p.$$eval("#st-nav button", bs => bs.map(b => b.dataset.cat));
    check(tag + ": settings has categories", cats.length > 0, cats.join(" "));
    const empty = await p.evaluate(() => [...document.querySelectorAll("#st-nav button")].filter(b => !document.querySelector(`#st-pane > [data-cat="${b.dataset.cat}"]`)).map(b => b.dataset.cat));
    check(tag + ": no empty category", empty.length === 0, empty.join(" "));
    for (const c of cats) {
      await p.click(`#st-nav button[data-cat=${c}]`); await p.waitForTimeout(500);
      await screen(p, tag, "settings " + c + " top");
      if (shots && c === "display") await p.screenshot({ path: `${shots}/${tag}-settings.png` });
      await p.evaluate(() => { const e = document.getElementById("st-pane"); e.scrollTop = e.scrollHeight; });
      await p.waitForTimeout(300); await screen(p, tag, "settings " + c + " bottom");
      await p.evaluate(() => { document.getElementById("st-pane").scrollTop = 0; });
    }
  }
  // every other rail page (Media, Trips, GPS — whatever the edition has), top and bottom
  for (const g of await p.$$eval("#dock [data-go]", bs => bs.map(b => b.dataset.go).filter(x => x !== "maps" && x !== "settings"))) {
    await p.click(`#dock [data-go=${g}]`); await p.waitForTimeout(600); await screen(p, tag, g);
    if (shots && g === "trip") await p.screenshot({ path: `${shots}/${tag}-page.png` });
    await p.evaluate(id => { for (const e of document.querySelectorAll("#" + id + " *")) if (e.scrollHeight > e.clientHeight + 4) e.scrollTop = e.scrollHeight; }, g);
    await p.waitForTimeout(300); await screen(p, tag, g + " bottom");
  }
  // Places (2026-11-22): filled page (seeded here, never on the device), its picker and edit panel with the keyboard, touch targets
  if (await p.locator("#dock [data-go=places]").count()) {
    if (!cdp) await p.evaluate(() => {
      const pl = (n, lat, lon) => ({ name: n, ctx: "Layout guard, a rather long address line to test wrapping", lat, lon });
      localStorage.setItem("navpi.places", JSON.stringify({ home: pl("Marienplatz", 48.1371, 11.5754), work: pl("Olympiapark", 48.1687, 11.5504),
        favs: [pl("Supermarket", 48.1500, 11.5700), pl("Allianz Arena", 48.2188, 11.6236), pl("Airport", 48.3538, 11.7861)] }));
      localStorage.setItem("navpi.recents", JSON.stringify([pl("München Hbf", 48.1402, 11.5600), pl("Garching", 48.2490, 11.6510)]));
      localStorage.setItem("navpi.parked", JSON.stringify({ lat: 48.1390, lon: 11.5790, t: Date.now() }));
    });
    await tryClick(p, "#dock [data-go=maps]"); await p.click("#dock [data-go=places]"); await p.waitForTimeout(600);
    await screen(p, tag, "places filled");
    // the Settings rule (2026-11-22 integration): designed at 56 UI px, so >= max(44, 56 x UI scale) on the glass
    const small = await p.evaluate(() => { const ui = UiScale.value(), min = Math.max(44, 56 * ui) - 0.5;
      return [...document.querySelectorAll("#places button")].filter(e => {
        const r = e.getBoundingClientRect(); return r.width > 2 && r.height > 2 && getComputedStyle(e).visibility !== "hidden" && Math.min(r.width, r.height) < min;
      }).map(e => { const r = e.getBoundingClientRect(); return (e.id || e.className.toString().slice(0, 20)) + "=" + Math.round(r.width) + "x" + Math.round(r.height) + "<" + Math.round(min); }); });
    check(tag + " places: touch targets >= max(44, 56 x UI scale) px", small.length === 0, small.slice(0, 6).join(" "));
    await p.evaluate(() => { const e = document.getElementById("pl-body"); e.scrollTop = e.scrollHeight; }); await p.waitForTimeout(300);
    await screen(p, tag, "places bottom");
    if (await tryClick(p, "#pl-add")) { await p.waitForTimeout(500); await screen(p, tag, "places picker + keyboard"); await tryClick(p, "#pl-pick-x"); await p.waitForTimeout(300); }
    if (await tryClick(p, "#pl-favs .pl-edit")) { await p.waitForTimeout(500); await screen(p, tag, "places edit + keyboard"); await tryClick(p, "#pl-edit-x"); await p.waitForTimeout(300); }
  }
  await tryClick(p, "#dock [data-go=maps]"); await p.waitForTimeout(500);
  if (shots) { await p.waitForTimeout(1500); await p.screenshot({ path: `${shots}/${tag}-map.png` }); }
  // route sheet + simulated drive (Munich Hauptbahnhof -> Garching): the guiding screen has the most controls
  const routed = await p.evaluate(async () => {
    if (typeof Maps === "undefined" || !Maps.preview) return false;   // a top-level const, not window.Maps
    await Maps.preview({ name: "Garching", ctx: "", lat: 48.2490, lon: 11.6510 }, { name: "München Hbf", ctx: "", lat: 48.1402, lon: 11.5600 }, []);
    return true;
  }).catch(() => false);
  check(tag + ": route preview reachable (Maps.preview)", routed);
  if (routed) {
    await p.waitForTimeout(3500);
    if (await p.locator("#sheet.open").count()) {
      await screen(p, tag, "route sheet"); if (shots) await p.screenshot({ path: `${shots}/${tag}-sheet.png` });
      if (await tryClick(p, "#s-sim")) { await p.waitForTimeout(4000); await screen(p, tag, "guiding"); if (shots) await p.screenshot({ path: `${shots}/${tag}-guiding.png` }); await tryClick(p, "#btn-stop"); await p.waitForTimeout(800); }
    } else check(tag + ": route sheet opened", false, "no route (routing down?)");
  }
  if (await tryClick(p, "#btn-dash")) { await p.waitForTimeout(800); await screen(p, tag, "split screen"); await tryClick(p, "#btn-dash"); await p.waitForTimeout(500); }
}

// Settings > Screen > UI size (PN-73 part): applied at once, kept over a reload, layout still clean, then back to Normal
async function uiSize(p, tag) {
  const scale = () => p.evaluate(() => +getComputedStyle(document.documentElement).getPropertyValue("--ui-s"));
  const base = await scale();
  await p.evaluate(() => document.querySelector("#dock [data-go=settings]").click()); await p.waitForTimeout(500);
  await p.click("#st-nav button[data-cat=display]"); await p.waitForTimeout(400);
  await p.evaluate(() => document.getElementById("uisize-card").scrollIntoView({ block: "center" }));
  await p.click("#uisize [data-uisize=large]"); await p.waitForTimeout(400);
  const big = await scale();
  check(tag + ": UI size Larger applies at once", big > base, base + " -> " + big);
  await p.reload(); await p.waitForTimeout(2000);
  check(tag + ": UI size kept after reload", (await scale()) === big && (await p.evaluate(() => localStorage.getItem("navpi.uiSize"))) === '"large"');
  await p.evaluate(() => document.querySelector("#dock [data-go=settings]").click()); await p.waitForTimeout(500);
  await p.click("#st-nav button[data-cat=display]"); await p.waitForTimeout(400);
  await screen(p, tag + " Larger", "settings display");
  await p.evaluate(() => document.querySelector("#dock [data-go=maps]").click()); await p.waitForTimeout(800);
  await screen(p, tag + " Larger", "map");
  if (shots) await p.screenshot({ path: `${shots}/${tag}-larger-map.png` });
  await p.evaluate(() => document.querySelector("#dock [data-go=settings]").click()); await p.waitForTimeout(500);
  await p.evaluate(() => document.querySelector("#uisize [data-uisize=small]").click()); await p.waitForTimeout(400);
  check(tag + ": UI size Smaller never below 0.8", (await scale()) >= 0.8 && (await scale()) <= base, String(await scale()));
  await p.evaluate(() => document.querySelector("#uisize [data-uisize=normal]").click()); await p.waitForTimeout(400);
  check(tag + ": UI size Normal restores the fitted scale", (await scale()) === base);
}

if (cdp) {
  const b = await chromium.connectOverCDP(process.argv[3] || "http://127.0.0.1:19222");
  const p = b.contexts()[0].pages().find(x => /:8080\//.test(x.url()));
  const s = await b.contexts()[0].newCDPSession(p);
  const before = await probe(p);
  check("device: page scale 1 at start", before.scale === 1, "scale " + before.scale + " — a zoomed kiosk: restart the browser");
  // pinch over a list area (pan-y, not the map, which zooms itself): a browser-level zoom must not happen
  await p.click("#dock [data-go=settings]"); await p.waitForTimeout(800);
  const vw = await p.evaluate(() => [innerWidth, innerHeight]);
  const x = Math.round(vw[0] / 2), y = Math.round(vw[1] / 2);
  await s.send("Input.synthesizePinchGesture", { x, y, scaleFactor: 2, relativeSpeed: 800, gestureSourceType: "touch" }).catch(e => console.log("pinch not synthesised:", e.message));
  await p.waitForTimeout(800);
  const after = await probe(p);
  if (after.scale !== 1) await s.send("Emulation.setPageScaleFactor", { pageScaleFactor: 1 }).catch(() => {});
  await tryClick(p, "#dock [data-go=maps]"); await p.waitForTimeout(500);
  check("device: pinch does not zoom the page", after.scale === 1, "scale " + after.scale);
  const vp = await p.evaluate(() => innerWidth + "x" + innerHeight);
  const saved = await p.evaluate(() => JSON.stringify(localStorage));   // the device's own settings (split screen, satellite …)
  await run(p, "device " + vp);
  // put the screen back as the user left it (a missed toggle once left split screen on), then reload
  await p.evaluate(s => { localStorage.clear(); for (const [k, v] of Object.entries(JSON.parse(s))) localStorage.setItem(k, v); }, saved);
  await p.reload(); await p.waitForTimeout(3000);
  await b.close();
} else {
  const url = process.argv[2] || "http://127.0.0.1:18471";
  const b = await chromium.launch({ args: ["--use-angle=swiftshader", "--enable-unsafe-swiftshader", "--ignore-gpu-blocklist"] });
  if (shots) (await import("fs")).mkdirSync(shots, { recursive: true });
  for (const [w, h] of SIZES) {
    const ctx = await b.newContext({ viewport: { width: w, height: h }, hasTouch: true });
    const p = await ctx.newPage();
    const errs = []; p.on("pageerror", e => errs.push(e.message));
    await p.goto(url + "/"); await p.waitForTimeout(2500);
    try { await run(p, w + "x" + h); } catch (e) { check(w + "x" + h + ": run completed (a control could not be pressed)", false, e.message.split("\n").filter(l => /Timeout|locator\(|intercepts/.test(l)).slice(0, 3).join(" | ")); await p.screenshot({ path: "/tmp/ui-layout-guard-" + w + "x" + h + "-stuck.png" }).catch(() => {}); }
    if ((w === 1280 && h === 720) || (w === 800 && h === 480)) await uiSize(p, w + "x" + h);
    check(w + "x" + h + ": no page errors", errs.length === 0, errs.slice(0, 2).join(" | "));
    await ctx.close();
  }
  await b.close();
}
console.log(fails ? `RESULT: ${fails} FAIL` : "RESULT: ALL PASS");
process.exit(fails ? 1 : 0);
