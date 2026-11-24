/* nav-pi shell: status bar, dock, views. Knows no app by name: features register themselves
   (Shell.view / Shell.onLang) and the edition build includes only theirs.
   Layout (2026-11-22): no Home; starts on the first dock app (Maps); the dock (left rail in landscape,
   bottom bar in portrait) = the apps + Settings (gear, last). The status bar is information only (clock, now
   playing, Wi-Fi, GPS): the pull-down quick panel was removed, its controls live in Settings or on the map. */
"use strict";
const Shell = (() => {
  const $ = id => document.getElementById(id);
  const views = {}, langHooks = [];
  let current = null, previous = null;
  function view(id, hooks) { views[id] = hooks; }            // hooks: {show(), hide()}
  function onQuick() { /* the quick panel was removed (2026-11-22); kept so an older feature does not break */ }
  function onLang(fn) { langHooks.push(fn); }                  // fn() re-renders script-built text
  function onHome() { /* Home was removed (2026-11-11); kept so older features do not break */ }
  function go(id) {
    if (id === current || !document.getElementById(id)) return;
    previous = current; current = id;
    document.querySelectorAll(".view").forEach(v => v.classList.toggle("active", v.id === id));
    document.querySelectorAll("#dock button").forEach(b => { const on = b.dataset.go === id; b.classList.toggle("active", on); b.setAttribute("aria-current", on ? "page" : "false"); });
    if (previous && views[previous] && views[previous].hide) views[previous].hide();
    if (views[id] && views[id].show) views[id].show();
  }
  function back() { go(previous && previous !== current ? previous : firstApp()); }
  function firstApp() { const b = document.querySelector("#dock [data-go]"); return b ? b.dataset.go : "settings"; }
  function tick() { $("clock").textContent = U.fmtClock(new Date()); }

  const GPS = { none: ["off", "i-gps-off"], search: ["warn", "i-gps"], fix: ["ok", "i-gps"], sim: ["sim", "i-sim"], est: ["warn", "i-gps-off"] };
  let gpsNow = "none";
  function gpsStatus(s) {
    gpsNow = GPS[s] ? s : "none";
    const [cls, icon] = GPS[gpsNow];
    const c = $("gps-chip"); c.className = "chip " + cls;
    c.querySelector("use").setAttribute("href", "#" + icon);
    $("gps-text").textContent = T("gps." + gpsNow);
  }
  // now-playing chip in the status bar (filled by the media feature): tap = play/pause
  function nowPlaying(info) {
    const c = $("np-chip");
    window.dispatchEvent(new CustomEvent("navpi:np", { detail: info || null }));   // dashboard card (PN-47)
    if (!info) { c.hidden = true; return; }
    c.hidden = false;
    c.innerHTML = `<svg class="i"><use href="#${info.playing ? "i-pause" : "i-play"}"/></svg><span></span>`;
    c.querySelector("span").textContent = info.title || "";
    c.onclick = info.toggle;
  }

  function relang() { applyI18n(); tick(); gpsStatus(gpsNow); langHooks.forEach(f => f()); }
  // rail order: Maps, Places, Media, Trip, GPS, then any other app, Settings always last
  const ORDER = ["maps", "places", "media", "trip", "gps"];
  function sortDock() {
    const d = $("dock"), rank = b => b.dataset.go === "settings" ? 99 : (ORDER.indexOf(b.dataset.go) + 1 || 50);
    [...d.querySelectorAll("button[data-go]")].sort((a, b) => rank(a) - rank(b)).forEach(b => d.appendChild(b));
  }
  function start() {   // called once, after every feature script has loaded
    sortDock();
    document.querySelectorAll("[data-go]").forEach(b => b.addEventListener("click", () => go(b.dataset.go)));
    document.addEventListener("contextmenu", e => e.preventDefault());
    // #views clips (overflow hidden) yet a focus or scrollIntoView can still scroll it: the screen then sits shifted up
    $("views").addEventListener("scroll", e => { if (e.target.scrollTop) e.target.scrollTop = 0; });
    if (new URLSearchParams(location.search).has("kiosk")) document.documentElement.classList.add("kiosk");
    $("gps-chip").hidden = !(window.EDITION && EDITION.features.includes("gps"));
    $("settings-back").addEventListener("click", back);
    applyI18n(); tick(); setInterval(tick, 5000); gpsStatus("none");
    go(firstApp());
  }
  return { view, onHome, onQuick, onLang, go, back, gpsStatus, nowPlaying, relang, start };
})();
