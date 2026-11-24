/* nav-pi speed limits (PN-42) and over-speed warning (PN-43). Offline: the limits come from the local Valhalla
   graph (OSM maxspeed) via POST /api/limits (navd_nav.py -> Valhalla /trace_attributes, edge_walk on the route shape).
   Pure logic first (testable in node: tools/test-speedlimit.mjs), the small DOM part at the bottom. */
"use strict";
const SpeedLimits = (() => {
  const UNLIMITED = 200;   // Valhalla gives 255 for "none" (motorway without limit): no sign

  // edges [[beginShapeIdx, endShapeIdx, kmh|0], ...] + cum (metres along the shape) -> [{from, to, kmh}] (kmh null = unknown)
  function build(edges, cum) {
    const out = [];
    for (const e of edges || []) {
      const a = cum[e[0]], b = cum[e[1]];
      if (a === undefined || b === undefined || b <= a) continue;
      const kmh = e[2] > 0 && e[2] < UNLIMITED ? e[2] : null;
      const last = out[out.length - 1];
      if (last && last.kmh === kmh && Math.abs(last.to - a) < 1) last.to = b;
      else out.push({ from: a, to: b, kmh });
    }
    return out;
  }
  // limit (km/h) at `along` metres, or null when unknown / no data
  function at(limits, along) {
    if (!limits || !limits.length) return null;
    let lo = 0, hi = limits.length - 1;
    while (lo < hi) { const m = (lo + hi + 1) >> 1; if (limits[m].from <= along) lo = m; else hi = m - 1; }
    const s = limits[lo];
    return along >= s.from && along <= s.to + 1 ? s.kmh : null;
  }

  // over-speed state machine: warn once per limit zone, re-arm after the driver is back under.
  // over needs 2 s of continuous speeding (GPS speed jitter); chime fires once when `over` begins.
  class Watch {
    constructor() { this.zone = null; this.since = 0; this.warned = false; }
    // returns {over, chime}
    step(limit, kmh, threshold, now) {
      if (limit == null) { this.zone = null; this.since = 0; this.warned = false; return { over: false, chime: false }; }
      if (limit !== this.zone) { this.zone = limit; this.since = 0; this.warned = false; }
      if (kmh <= limit + threshold) { this.since = 0; this.warned = false; return { over: false, chime: false }; }
      if (!this.since) this.since = now;
      const over = now - this.since >= 2000;
      const chime = over && !this.warned;
      if (chime) this.warned = true;
      return { over, chime };
    }
  }

  async function load(guide, polyline) {
    for (let t = 0; t < 3; t++) {
      try {
        const r = await U.api("/api/limits", { shape: polyline });
        guide.limits = build(r.edges, guide.cum);
        return;
      } catch (e) { await new Promise(res => setTimeout(res, 4000 * (t + 1))); }
    }
    guide.limits = [];
  }

  // ---------- DOM / settings (browser only) ----------
  const cfg = () => Object.assign({ mode: "visual", thr: 5 }, typeof U !== "undefined" && U.store.get("overspeed", {}));
  const watch = new Watch();
  let shown, cur = 0;
  // Current speed (km/h): read ONLY from the "navpi:speed" event {kmh, src} (maps.js sends GPS / simulated / estimated
  // speed; a future sensor plugs in by sending the same event). Drawn in the Waze-style speed cluster (#speedo).
  if (typeof window !== "undefined" && window.addEventListener) window.addEventListener("navpi:speed", e => {
    cur = (e.detail && e.detail.kmh) || 0;
    const el = document.getElementById("t-speed"); if (el) el.textContent = Math.round(cur);
  });
  function tick(limit, kmh = cur) {
    const sign = document.getElementById("t-limit"), sp = document.querySelector("#speedo .speed");
    if (!sign) return;
    if (limit !== shown) {
      shown = limit;
      sign.hidden = limit == null;
      if (limit != null) { sign.querySelector("b").textContent = limit; sign.classList.toggle("l3", limit >= 100); }
      sign.setAttribute("aria-label", limit == null ? "" : T("limit.aria", { n: limit }));
    }
    const c = cfg();
    const r = watch.step(limit, kmh, c.thr, Date.now());
    sp.classList.toggle("over", c.mode !== "off" && r.over);
    sign.classList.toggle("over", c.mode !== "off" && r.over);
    if (c.mode === "sound" && r.chime) U.api("/api/chime", {}).catch(() => {});
  }
  function reset() { watch.step(null, 0, 0, 0); shown = undefined; const s = document.getElementById("t-limit"); if (s) s.hidden = true; }

  function markSettings() {
    const c = cfg();
    document.querySelectorAll("#os-mode button").forEach(b => b.classList.toggle("on", b.dataset.os === c.mode));
    document.querySelectorAll("#os-thr button").forEach(b => b.classList.toggle("on", +b.dataset.thr === c.thr));
    const thr = document.getElementById("os-thr"); if (thr) thr.classList.toggle("dim", c.mode === "off");
  }
  let bound = false;
  function bind() {
    bound = true;
    document.querySelectorAll("#os-mode button").forEach(b => b.addEventListener("click", () => {
      U.store.set("overspeed", { ...cfg(), mode: b.dataset.os }); markSettings();
      if (b.dataset.os === "sound") U.api("/api/chime", {}).catch(() => {});   // let the driver hear it
    }));
    document.querySelectorAll("#os-thr button").forEach(b => b.addEventListener("click", () => {
      U.store.set("overspeed", { ...cfg(), thr: +b.dataset.thr }); markSettings();
    }));
  }
  if (typeof Settings !== "undefined") Settings.section({ open() { if (!bound) bind(); markSettings(); } });

  return { build, at, Watch, load, tick, reset };
})();
if (typeof module !== "undefined") module.exports = SpeedLimits;
