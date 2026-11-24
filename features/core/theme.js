/* nav-pi appearance (PN-31/PN-32): Light / Dark / Auto for the whole UI; the map follows (day map with the light UI,
   night map with the dark UI) and display.js dims at night. Auto = sunrise/sunset from the last position (or the map
   centre) and the date, computed offline by solar.js, re-evaluated every minute. Setting: localStorage "uiTheme".
   Buttons: any [data-ui-mode="light|dark|auto"]. Event "navpi:theme" fires whenever the resolved day/night changes. */
"use strict";
const Theme = (() => {
  const MODES = ["light", "dark", "auto"], DEFAULT_POS = { lat: 51.16, lng: 10.45 };
  let mode = U.store.get("uiTheme", "auto"), cur = null;
  if (!MODES.includes(mode)) mode = "auto";
  function position() {   // last GPS position, else the map centre, else the middle of Germany
    const p = U.store.get("lastPos", null);
    if (p && isFinite(p.lat) && isFinite(p.lng)) return p;
    try { const c = window.__map && window.__map.getCenter(); if (c) return { lat: c.lat, lng: c.lng }; } catch (e) { /* no map yet */ }
    return DEFAULT_POS;
  }
  function resolve(now = new Date()) {
    if (mode === "light") return "day";
    if (mode === "dark") return "night";
    const p = position();
    return Solar.isDay(p.lat, p.lng, now) ? "day" : "night";
  }
  function sunText() {   // "Sunrise 06:12 - Sunset 20:41" for the Settings hint (polar day/night at the poles)
    const p = position(), t = Solar.times(p.lat, p.lng, new Date());
    return t.polar ? T(t.polar === "day" ? "ui.polarDay" : "ui.polarNight")
      : T("ui.sun", { rise: U.fmtClock(t.rise), set: U.fmtClock(t.set) });
  }
  function mark() {
    document.querySelectorAll("[data-ui-mode]").forEach(b => b.classList.toggle("on", b.dataset.uiMode === mode));
    document.querySelectorAll(".ui-sun").forEach(e => { e.textContent = mode === "auto" ? sunText() : ""; });
  }
  function apply(force) {
    const n = resolve();
    document.documentElement.dataset.ui = n === "day" ? "light" : "dark";
    if (force || n !== cur) { cur = n; window.dispatchEvent(new CustomEvent("navpi:theme")); }
    mark();
  }
  function set(m) { if (MODES.includes(m)) { mode = m; U.store.set("uiTheme", m); apply(true); } }
  document.addEventListener("click", e => { const b = e.target.closest && e.target.closest("[data-ui-mode]"); if (b) set(b.dataset.uiMode); });
  setInterval(() => { if (mode === "auto") apply(false); }, 60000);
  apply(false);
  Shell.onLang(mark);
  return { current: () => cur || resolve(), mode: () => mode, set, refresh: () => apply(false) };
})();
