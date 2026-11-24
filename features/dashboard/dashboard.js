/* dashboard feature (PN-47): split screen in landscape — map left, a column right with the clock, trip info
   (next maneuver, arrival, distance and time left while guiding; otherwise speed + Trip A) and what is playing.
   Portrait: off (the column needs width). Toggle: map button + switch in Settings > Screen; remembered on the device
   (U.store "dash"). Data arrives by events and is drawn by ONE 1 Hz timer that runs only while the split is
   visible, so the map keeps its frame budget:
     navpi:pos  {speed}            (maps.js)      navpi:nav  {type, toNext, street, remainTime, remain} | null (maps.js)
     navpi:np   {title, playing, toggle} | null (shell.js, filled by media)    window.Media.next() (media.js)
   Basic edition has no media: the now-playing card stays hidden. */
"use strict";
(() => {
  const $ = id => document.getElementById(id);
  const feats = (window.EDITION && EDITION.features) || [];
  const HAS_MEDIA = feats.includes("media"), HAS_TRIP = feats.includes("trip");
  const land = window.matchMedia("(orientation: landscape)");
  let on = !!U.store.get("dash", false), timer = null, tick = 0;
  let speed = null, speedAt = 0, nav = null, np = null, tripA = null;

  const set = (id, txt) => { const e = $(id); if (e && e.textContent !== txt) e.textContent = txt; };
  const visible = () => on && land.matches && $("maps") && $("maps").classList.contains("active") && !document.hidden;

  function apply() {
    $("app").classList.toggle("dash-on", on);
    const b = $("btn-dash"); if (b) { b.classList.toggle("on", on); b.setAttribute("aria-pressed", String(on)); }
    markTile();
    clearInterval(timer); timer = null;
    if (on && land.matches) { timer = setInterval(render, 1000); render(); }
    // the map container changed width: tell MapLibre once the new layout is in place
    requestAnimationFrame(() => { if (window.Maps) Maps.resize(); });
  }
  function toggle(v) { on = v == null ? !on : !!v; U.store.set("dash", on); apply(); }

  function render() {
    if (!visible()) return;
    const now = new Date();
    set("d-time", U.fmtClock(now));
    set("d-date", now.toLocaleDateString(LANGS[LANG].locale, { weekday: "short", day: "numeric", month: "short" }));
    const fresh = speed != null && Date.now() - speedAt < 5000;
    set("d-speed", fresh ? String(Math.round(speed * 3.6)) : "–");
    const guiding = !!nav;
    $("d-man").hidden = $("d-navfacts").hidden = !guiding;
    $("d-tripa").hidden = guiding || !HAS_TRIP;
    if (guiding) {
      const a = $("d-arrow"), key = nav.type + "";
      if (a.dataset.k !== key) { a.innerHTML = maneuverSvg(nav.type); a.dataset.k = key; }
      set("d-dist", nav.arrived ? T("arrived") : U.fmtDist(nav.toNext));
      set("d-street", nav.street || "");
      set("d-arrive", U.fmtClock(new Date(Date.now() + nav.remainTime * 1000)));
      set("d-left", U.fmtDist(nav.remain));
      set("d-rest", U.fmtDur(nav.remainTime));
    } else if (HAS_TRIP) {
      if (tick++ % 10 === 0) loadTrip();          // Trip A every 10 s (navd counts it; nothing to compute here)
      const c = tripA;
      set("d-a-dist", c && (c.dist || c.drive) ? (c.dist / 1000).toFixed(c.dist < 100000 ? 1 : 0) + " km" : "–");
      set("d-a-time", c && c.drive ? U.fmtDur(c.drive) : "–");
      set("d-a-avg", c && c.avg ? Math.round(c.avg) + " km/h" : "–");
    }
  }
  async function loadTrip() {
    try { tripA = (await U.api("/api/trip")).a; } catch (e) { /* navd restarting */ }
  }
  function renderNp() {
    if (!HAS_MEDIA) return;
    $("d-np").hidden = false;
    const t = $("d-np-title");
    t.textContent = np ? (np.title || "") : T("dash.nothing");
    t.classList.toggle("none", !np);
    $("d-np-play").hidden = $("d-np-next").hidden = !np;
    $("d-np-open").hidden = !!np;
    if (np) $("d-np-play").querySelector("use").setAttribute("href", np.playing ? "#i-pause" : "#i-play");
  }
  function markTile() {
    const b = $("q-dash"); if (!b) return;   // Settings > Screen switch (the map button is the other way)
    b.setAttribute("aria-checked", String(on));
    b.disabled = !land.matches;
    $("q-dash-hint").hidden = land.matches;
  }

  // ---------- wiring ----------
  window.addEventListener("navpi:pos", e => { const p = e.detail; if (p) { speed = p.speed || 0; speedAt = Date.now(); } });
  window.addEventListener("navpi:nav", e => { nav = e.detail || null; });
  window.addEventListener("navpi:np", e => { np = e.detail || null; renderNp(); });
  land.addEventListener("change", apply);
  document.addEventListener("visibilitychange", render);
  const btn = document.createElement("button");
  btn.className = "fab"; btn.id = "btn-dash"; btn.dataset.i18nLabel = "dash.title";
  btn.innerHTML = '<svg class="i"><use href="#i-split"/></svg>';
  btn.addEventListener("click", () => toggle());
  ($("fabs") || $("maps")).appendChild(btn);
  $("q-dash").addEventListener("click", () => toggle());
  $("d-np-play").addEventListener("click", () => { if (np && np.toggle) np.toggle(); });
  $("d-np-next").addEventListener("click", () => { if (window.Media && Media.next) Media.next(); });
  $("d-np-open").addEventListener("click", () => Shell.go("media"));
  if (typeof Settings !== "undefined") Settings.section({ open: markTile });
  Shell.onLang(() => { markTile(); renderNp(); $("d-arrow").dataset.k = ""; render(); });
  window.Dashboard = { toggle, isOn: () => on };
  renderNp(); apply();
})();
