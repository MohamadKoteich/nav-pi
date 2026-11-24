/* nav-pi driver alerts while guiding (PN-44), speed cameras opt-in (PN-45), low-emission zones (PN-46).
   Offline: curves come from the route shape, the rest from <region>/safety/safety.json (tools/build_safety.py)
   through navd_safety.py. Listens to maps.js window events only:
     navpi:guide {guide, st}        every guidance update (a new guide object = a new route / reroute)
     navpi:navstop                  guidance ended
     navpi:pos {speed, ...}         every position (break reminder, also without a route)
     navpi:preview {trip}           a route preview is shown (low-emission zone note)
     navpi:routebody {body, url}    synchronous, before the route request: "Avoid low-emission zones" sets url to
                                    /api/safety/route (navd: plain route, then round the zones it enters)
     navpi:avoidfail                that request failed; maps.js routed without it
   Pure logic first (node: tools/test-safety.mjs), the DOM part at the bottom. */
"use strict";
const Safety = (() => {
  const A_LAT = 2.0;          // m/s² comfortable lateral acceleration: advisory speed v = sqrt(a·R)
  const STEP = 10, WIN = 6;   // resample every 10 m, curvature over a 60 m window
  const R_SHARP = 150;        // m: sections tighter than this are a curve candidate
  const MIN_TURN = 30;        // degrees: the whole curve must turn at least this much (kinks in the data are not curves)
  const TURN_TYPES = new Set([2, 3, 4, 5, 6, 9, 10, 11, 12, 13, 14, 15, 16, 18, 19, 20, 21, 23, 24, 25, 26, 27, 37, 38]);
  const deg = r => r * 180 / Math.PI, rad = d => d * Math.PI / 180;

  // sharp curves along a route: [{at, end, r, kmh, dir: 1 right | -1 left}] (at = metres along the shape)
  // man = guidance maneuvers with .at; curves at turns / in roundabouts are left to the turn instructions
  function curves(shape, cum, man = []) {
    const n = shape.length, total = cum[n - 1] || 0;
    if (n < 3 || total < STEP * WIN) return [];
    // resample every STEP metres
    const pts = [], al = [];
    let i = 0;
    for (let d = 0; d <= total; d += STEP) {
      while (i + 1 < n - 1 && cum[i + 1] < d) i++;
      const L = (cum[i + 1] - cum[i]) || 1, t = Math.min(1, Math.max(0, (d - cum[i]) / L));
      pts.push([shape[i][0] + (shape[i + 1][0] - shape[i][0]) * t, shape[i][1] + (shape[i + 1][1] - shape[i][1]) * t]);
      al.push(d);
    }
    // heading of each resampled step (local flat frame), change between steps (deg, +right)
    const hd = [];
    for (let k = 0; k + 1 < pts.length; k++) {
      const c = Math.cos(rad(pts[k][1]));
      hd.push(Math.atan2((pts[k + 1][0] - pts[k][0]) * c, pts[k + 1][1] - pts[k][1]));
    }
    const dh = [0];
    for (let k = 1; k < hd.length; k++) { let x = deg(hd[k] - hd[k - 1]); x = ((x + 540) % 360) - 180; dh.push(x); }
    // excluded stretches: around turn maneuvers, and inside roundabouts (enter 26 .. exit 27)
    const ex = [];
    man.forEach((m, k) => {
      if (!TURN_TYPES.has(m.type)) return;
      ex.push([m.at - 50, m.at + 60]);
      if (m.type === 26) { const out = man.slice(k + 1).find(x => x.type === 27); ex.push([m.at, (out ? out.at : m.at + 150) + 40]); }
    });
    const excluded = (a, b) => ex.some(e => a <= e[1] && b >= e[0]);
    // sliding window turn -> radius; runs of tight, same-direction samples
    const out = [];
    let run = null, win = 0;
    for (let k = 1; k < dh.length; k++) {
      win += dh[k]; if (k > WIN) win -= dh[k - WIN];
      const turn = Math.abs(win), r = turn > 0.5 ? (STEP * WIN) / rad(turn) : 1e9, dir = Math.sign(win);
      const tight = k >= WIN && r < R_SHARP;
      if (tight && run && dir === run.dir) { run.end = al[k]; run.r = Math.min(run.r, r); run.turn += dh[k]; }
      else {
        if (run) close(run);
        run = tight ? { at: al[Math.max(0, k - WIN)], end: al[k], r, dir, turn: dh.slice(Math.max(1, k - WIN + 1), k + 1).reduce((a, b) => a + b, 0) } : null;
      }
    }
    if (run) close(run);
    function close(c) {
      if (Math.abs(c.turn) < MIN_TURN || excluded(c.at, c.end)) return;
      out.push({ at: Math.round(c.at), end: Math.round(c.end), r: Math.round(c.r), dir: c.dir,
        kmh: Math.max(15, Math.round(Math.sqrt(A_LAT * c.r) * 3.6 / 5) * 5) });
    }
    return out;
  }

  // point in polygon ([lon,lat] point, ring [[lon,lat],...])
  function pip(p, ring) {
    let inside = false;
    for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
      const a = ring[i], b = ring[j];
      if ((a[1] > p[1]) !== (b[1] > p[1]) && p[0] < (b[0] - a[0]) * (p[1] - a[1]) / (b[1] - a[1]) + a[0]) inside = !inside;
    }
    return inside;
  }
  function inZone(p, z) {
    const b = z.bbox;
    if (p[0] < b[0] || p[0] > b[2] || p[1] < b[1] || p[1] > b[3]) return false;
    return z.rings.some(r => pip(p, r)) && !(z.holes || []).some(r => pip(p, r));
  }
  const active = (z, today) => !(z.tags && z.tags.end_date && z.tags.end_date < today) && !(z.tags && z.tags.start_date && z.tags.start_date > today);
  // where the route enters a zone: [{at, zone}] (a start inside a zone counts as entering at 0)
  function lezEntries(shape, cum, zones, today = new Date().toISOString().slice(0, 10)) {
    const out = [];
    for (const z of zones || []) {
      if (!active(z, today)) continue;
      const b = z.bbox;
      let was = false;
      for (let i = 0; i < shape.length; i++) {
        const p = shape[i];
        const inn = p[0] >= b[0] && p[0] <= b[2] && p[1] >= b[1] && p[1] <= b[3] && inZone(p, z);
        if (inn && !was) out.push({ at: cum[i], zone: z });
        was = inn;
      }
    }
    return out.sort((a, b) => a.at - b.at);
  }
  // break reminder: continuous driving time; a stop of `rest` ms resets it. Returns {due} once per `every` ms of driving
  class BreakWatch {
    constructor() { this.drive = 0; this.last = null; this.still = 0; this.next = 0; }
    step(speed, now, every, rest = 15 * 60000) {
      const dt = this.last !== null ? Math.max(0, Math.min(now - this.last, 60000)) : 0;   // a gap (app restarted, no fix) counts as at most 1 min
      this.last = now;
      if (speed > 2) { this.drive += dt; this.still = 0; }
      else { this.still += dt; if (this.still >= rest) { this.drive = 0; this.next = 0; } }
      if (!this.next) this.next = every;
      if (this.drive >= this.next && speed > 2) { this.next = this.drive + Math.min(every, 30 * 60000); return { due: true, drive: this.drive }; }
      return { due: false, drive: this.drive };
    }
  }

  // polyline6 encoder (the route shape for /api/safety/along)
  function encode6(shape) {
    let out = "", plat = 0, plon = 0;
    const enc = v => { v = v < 0 ? ~(v << 1) : v << 1; let s = ""; while (v >= 0x20) { s += String.fromCharCode((0x20 | (v & 0x1f)) + 63); v >>= 5; } return s + String.fromCharCode(v + 63); };
    for (const p of shape) {
      const lat = Math.round(p[1] * 1e6), lon = Math.round(p[0] * 1e6);
      out += enc(lat - plat) + enc(lon - plon); plat = lat; plon = lon;
    }
    return out;
  }

  // warn distances (metres before the hazard), from the speed in m/s
  const WARN = { curve: v => Math.max(150, v * 9), crossing: v => Math.max(200, v * 10), camera: v => Math.max(300, v * 12),
    lez: v => Math.max(800, v * 40) };
  // the alert to show now: nearest hazard ahead inside its warn distance. list: [{type, at, ...}] sorted by at
  function pick(list, along, v, kmh) {
    let best = null;
    for (const h of list) {
      const d = h.at - along;
      if (d < -20) continue;
      if (d > 3000) break;
      if (d > WARN[h.type](v)) continue;
      if (h.type === "curve" && !(kmh >= 40 && kmh > h.kmh + 10)) continue;   // only when the car is clearly too fast for it
      if (!best || d < best.d) best = { h, d: Math.max(0, d) };
    }
    return best;
  }

  // one alert per place: a double-track crossing or a camera pair (both directions) are several points a few metres apart
  function merge(list, gap = 60) {
    const last = {}, out = [];
    for (const h of list.slice().sort((a, b) => a.at - b.at)) {
      if (last[h.type] !== undefined && h.at - last[h.type] < gap) continue;
      last[h.type] = h.at; out.push(h);
    }
    return out;
  }

  const api = { merge, curves, pip, inZone, lezEntries, BreakWatch, encode6, pick, WARN };
  if (typeof document === "undefined") return api;

  // ---------- DOM / settings (browser only) ----------
  const $ = id => document.getElementById(id);
  const DEF = { curves: true, crossings: true, brk: true, brkMin: 120, chime: false, cameras: false, lezWarn: true, sticker: "green", lezAvoid: false };
  const cfg = () => Object.assign({}, DEF, U.store.get("safety", {}));
  const STICKERS = ["none", "red", "yellow", "green"];
  const ICON = {
    curve: "M6 20h2v-6.6c0-2.8 2.2-5.1 5-5.4V11l4-4-4-4v3a7.4 7.4 0 0 0-7 7.4z",
    crossing: "M12 2c-4 0-8 .5-8 4v9.5A3.5 3.5 0 0 0 7.5 19L6 20.5v.5h2.2l2-2h3.6l2 2H18v-.5L16.5 19a3.5 3.5 0 0 0 3.5-3.5V6c0-3.5-3.6-4-8-4zM7.5 17a1.5 1.5 0 1 1 0-3 1.5 1.5 0 0 1 0 3zm3.5-7H6V6h5v4zm2 0V6h5v4h-5zm3.5 7a1.5 1.5 0 1 1 0-3 1.5 1.5 0 0 1 0 3z",
    camera: "M12 15.2a3.2 3.2 0 1 0 0-6.4 3.2 3.2 0 0 0 0 6.4zM9 2 7.2 4H4a2 2 0 0 0-2 2v12a2 2 0 0 0 2 2h16a2 2 0 0 0 2-2V6a2 2 0 0 0-2-2h-3.2L15 2zm3 15a5 5 0 1 1 0-10 5 5 0 0 1 0 10z",
    lez: "M6 8a7 7 0 0 0 0 9.9c1.5-3.4 4.1-6.2 7.4-7.9a16 16 0 0 0-5.1 5.8c2.6 1.2 5.8.8 7.9-1.4C19.7 11 20 4 20 4s-7 .3-10.4 3.7z",
    brk: "M20 3H4v10a4 4 0 0 0 4 4h6a4 4 0 0 0 4-4v-3h2a2 2 0 0 0 2-2V5a2 2 0 0 0-2-2zm0 5h-2V5h2zM2 21h18v-2H2z",
  };
  let cur = null;            // {guide, list: hazards sorted by `at`, rest: [{at, name, kind}]}
  let zones = null;          // low-emission zones, loaded once
  let shownKey = null, chimed = new Set(), breakCard = null;
  const brk = new BreakWatch();

  function loadZones() {
    if (zones) return Promise.resolve(zones);
    return U.api("/api/safety/lez").then(r => (zones = r.zones || [])).catch(() => (zones = [], zones));
  }
  loadZones();   // small (a few dozen polygons, ~130 KB): every route and preview is checked against them

  function card() {
    let c = $("sa-card");
    if (!c) {
      c = document.createElement("div"); c.id = "sa-card"; c.setAttribute("role", "status"); c.setAttribute("aria-live", "polite");
      c.innerHTML = '<svg class="sa-i" viewBox="0 0 24 24"><path/></svg><div class="sa-m"><div class="sa-t"></div><div class="sa-s"></div></div>' +
        '<button class="sa-x" hidden><svg class="i"><use href="#i-close"/></svg></button>';
      c.querySelector(".sa-x").setAttribute("aria-label", T("sa.dismiss"));
      c.querySelector(".sa-x").addEventListener("click", () => { breakCard = null; render(null); });
      ($("maps") || document.body).appendChild(c);
    }
    return c;
  }
  // a = {key, type, title, sub, level: 'info'|'warn', closable}
  function render(a) {
    const c = card();
    if (!a) { c.classList.remove("open"); shownKey = null; return; }
    c.className = "open " + (a.level || "warn") + " t-" + a.type;
    c.querySelector(".sa-i path").setAttribute("d", ICON[a.type]);
    c.querySelector(".sa-i").style.transform = a.type === "curve" && a.dir < 0 ? "scaleX(-1)" : "";
    c.querySelector(".sa-t").textContent = a.title;
    c.querySelector(".sa-s").textContent = a.sub || "";
    c.querySelector(".sa-x").hidden = !a.closable;
    const b = $("banner");   // just under the maneuver banner while guiding, under the search bar otherwise
    c.style.top = b && b.classList.contains("open") ? (b.offsetTop + b.offsetHeight + 10) + "px" : "";
    if (a.key !== shownKey) {
      shownKey = a.key;
      if (cfg().chime && !chimed.has(a.key)) { chimed.add(a.key); U.api("/api/chime", {}).catch(() => {}); if (window.__saChimed) window.__saChimed.push(a.key); }
    }
  }
  // need: the German sticker a zone asks for (tools/build_safety.py: access=<colour>_sticker_germany, else green for an
  // "Umweltzone …"); "other" = a zone with other rules (e.g. a French ZFE): no verdict, only a note
  const zoneNeed = z => z.sticker || "green";
  const stickerOk = need => need === "other" || STICKERS.indexOf(cfg().sticker) >= STICKERS.indexOf(need);
  function alertOf(h, d) {
    const dist = U.fmtDist(d);
    if (h.type === "curve") return { key: "c" + h.at, type: "curve", dir: h.dir, title: T(h.dir > 0 ? "sa.curveR" : "sa.curveL"), sub: T("sa.curveSub", { d: dist, v: h.kmh }) };
    if (h.type === "crossing") return { key: "x" + h.at, type: "crossing", title: T("sa.crossing"), sub: T("sa.in", { d: dist }) };
    if (h.type === "camera") return { key: "k" + h.at, type: "camera", title: T("sa.camera"), sub: h.max ? T("sa.cameraSub", { d: dist, v: h.max }) : T("sa.in", { d: dist }) };
    const need = zoneNeed(h.zone), ok = stickerOk(need);
    return { key: "z" + h.at, type: "lez", level: ok ? "info" : "warn", title: T("sa.lez", { name: (h.zone.name || "").replace(/^Umweltzone\s+/i, "") }).trim(),
      sub: T(need === "other" ? "sa.lezOther" : ok ? "sa.lezOk" : "sa.lezNo", { d: dist, need: T("sa.st." + need), have: T("sa.st." + cfg().sticker) }) };
  }

  async function newRoute(g) {
    const c = cfg(), seq = cur = { guide: g, list: [], rest: [] };
    chimed = new Set();
    const list = [];
    if (c.curves) curves(g.shape, g.cum, g.man).forEach(x => list.push({ type: "curve", ...x }));
    if (c.lezWarn) lezEntries(g.shape, g.cum, await loadZones()).forEach(e => list.push({ type: "lez", at: e.at, zone: e.zone }));
    seq.list = list.slice().sort((a, b) => a.at - b.at);
    const types = [c.crossings && "crossings", c.cameras && "cameras", c.brk && "rest"].filter(Boolean);
    if (!types.length) return;
    try {
      const r = await U.api("/api/safety/along", { shape: encode6(g.shape), types });
      if (cur !== seq) return;
      const at = row => g.cum[row[0]] + ((g.cum[row[0] + 1] || g.cum[row[0]]) - g.cum[row[0]]) * row[1];
      (r.crossings || []).forEach(x => list.push({ type: "crossing", at: at(x) }));
      (r.cameras || []).forEach(x => list.push({ type: "camera", at: at(x), max: x[3] || 0 }));
      seq.rest = (r.rest || []).map(x => ({ at: at(x), kind: x[3], name: x[4] }));
      seq.list = merge(list);
    } catch (e) { /* no safety data for this region: curves (and zones) still work */ }
  }

  function onGuide(e) {
    const { guide: g, st } = e.detail || {};
    if (!g || !st || st.offRoute) return;
    if (!cur || cur.guide !== g) newRoute(g);
    const v = (window.__safetySpeed != null ? window.__safetySpeed : e.detail.speed) || 0;   // __safetySpeed: test harness
    const p = pick(cur.list, st.along, v, v * 3.6);
    render(p ? alertOf(p.h, p.d) : breakCard);   // a hazard ahead wins over the break reminder, which comes back after it
  }
  function onStop() { cur = null; if (!breakCard) render(null); }

  async function onPos(e) {
    const c = cfg(), p = e.detail || {};
    if (!c.brk) return;
    const r = brk.step(p.speed || 0, Date.now(), c.brkMin * 60000);
    if (!r.due) return;
    let sub = T("sa.breakSub", { t: U.fmtDur(r.drive / 1000) });
    const g = cur && cur.guide, along = g && g.update ? cur.lastAlong : null;
    try {
      let rest = null;
      if (cur && cur.rest.length && along != null) {
        const ahead = cur.rest.filter(x => x.at > along + 500 && x.at < along + 80000);
        if (ahead.length) rest = { name: ahead[0].name, kind: ahead[0].kind, d: ahead[0].at - along, route: true };
      }
      if (!rest && p.lat != null) {
        const n = await U.api("/api/safety/near?lat=" + p.lat + "&lon=" + p.lng);
        if (n && n.name !== undefined) rest = { name: n.name, kind: n.kind, d: n.km * 1000, route: false };
      }
      if (rest) sub += " · " + T(rest.route ? "sa.restRoute" : "sa.restNear", { name: rest.name || T(rest.kind ? "sa.services" : "sa.restArea"), d: U.fmtDist(rest.d) });
    } catch (x) { /* no data: the reminder alone */ }
    breakCard = { key: "b" + Date.now(), type: "brk", level: "info", title: T("sa.break"), sub, closable: true };
    render(breakCard);
    setTimeout(() => { if (breakCard && breakCard.key && shownKey === breakCard.key) { breakCard = null; render(null); } }, 60000);
  }

  // route preview: say when the route enters a low-emission zone
  async function onPreview(e) {
    const c = cfg(), trip = e.detail && e.detail.trip;
    if (!c.lezWarn || !trip || typeof tripShape === "undefined") return;
    const { shape } = tripShape(trip), cum = [0];
    for (let i = 1; i < shape.length; i++) cum.push(cum[i - 1] + U.dist(shape[i - 1], shape[i]));
    const ent = lezEntries(shape, cum, await loadZones());
    if (!ent.length) return;
    const names = [...new Set(ent.map(x => x.zone.name || "?"))].slice(0, 3).join(", ");
    const bad = ent.some(x => !stickerOk(zoneNeed(x.zone)));
    U.toast(T(bad ? "sa.lezRouteNo" : "sa.lezRoute", { names, have: T("sa.st." + c.sticker) }), 6000);
  }

  // "Avoid low-emission zones": navd routes round the zones the plain route would enter (navd_safety.route_avoid)
  function onRouteBody(e) {
    const rq = e.detail;
    if (cfg().lezAvoid && rq && rq.body && rq.body.costing === "auto") rq.url = "/api/safety/route";
  }

  addEventListener("navpi:guide", e => { if (cur) cur.lastAlong = e.detail && e.detail.st && e.detail.st.along; onGuide(e); });
  addEventListener("navpi:navstop", onStop);
  addEventListener("navpi:pos", onPos);
  addEventListener("navpi:preview", onPreview);
  addEventListener("navpi:routebody", onRouteBody);
  addEventListener("navpi:avoidfail", () => U.toast(T("sa.avoidFail"), 5000));

  // ---------- settings ----------
  const SW = ["curves", "crossings", "brk", "chime", "cameras", "lezWarn", "lezAvoid"];
  function mark() {
    const c = cfg();
    SW.forEach(k => { const b = $("sf-" + k); if (b) b.setAttribute("aria-checked", !!c[k]); });
    document.querySelectorAll("#sf-brkmin button").forEach(b => b.classList.toggle("on", +b.dataset.min === c.brkMin));
    document.querySelectorAll("#sf-sticker button").forEach(b => b.classList.toggle("on", b.dataset.st === c.sticker));
    const bm = $("sf-brkmin"); if (bm) bm.classList.toggle("dim", !c.brk);
  }
  async function info() {
    const el = $("sf-cover"), cam = $("sf-camcover"), z = $("sf-lezcover");
    try {
      const r = await U.api("/api/safety/info");
      if (!r.available) { [el, cam, z].forEach(x => x && (x.textContent = T("sa.noData"))); return; }
      const cov = r.coverage || "?", date = (r.osm_date || r.built || "").slice(0, 10), n = r.counts || {};
      if (el) el.textContent = T("sa.cover", { cov, date, x: n.crossings || 0, r: n.rest || 0 });
      if (cam) cam.textContent = T("sa.camCover", { cov, n: n.cameras || 0 });
      if (z) z.textContent = T("sa.lezCover", { cov, n: n.lez || 0 });
    } catch (e) { /* navd restarting */ }
  }
  let bound = false;
  function bind() {
    bound = true;
    SW.forEach(k => { const b = $("sf-" + k); if (b) b.addEventListener("click", () => {
      const c = cfg(); c[k] = !c[k]; U.store.set("safety", c); mark();
      if (k === "chime" && c.chime) U.api("/api/chime", {}).catch(() => {});   // let the driver hear it
      if (k !== "lezAvoid" && k !== "chime") cur = null;   // re-read the hazards of the route at the next update
    }); });
    document.querySelectorAll("#sf-brkmin button").forEach(b => b.addEventListener("click", () => { U.store.set("safety", { ...cfg(), brkMin: +b.dataset.min }); mark(); }));
    document.querySelectorAll("#sf-sticker button").forEach(b => b.addEventListener("click", () => { U.store.set("safety", { ...cfg(), sticker: b.dataset.st }); mark(); }));
  }
  if (typeof Settings !== "undefined") Settings.section({ open() { if (!bound) bind(); mark(); info(); }, relang() { info(); } });

  return Object.assign(api, { cfg, render });
})();
if (typeof module !== "undefined") module.exports = Safety;
