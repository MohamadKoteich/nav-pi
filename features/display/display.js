/* display feature: screen orientation (0/90/180/270) and backlight brightness (navd /api/display).
   Brightness slider in Settings > Screen; "Dim at night": while the map theme is night, navd uses the
   night level. Theme source = core/theme.js (Light / Dark / Auto);
   its window event "navpi:theme" gives an instant switch (also polled every 15 s). */
"use strict";
(() => {
  let bound = false, night = null, tmr = null;
  const BTN = "#rot button", $ = id => document.getElementById(id);
  const isNight = () => Theme.current() === "night";   // core/theme.js: Light / Dark / Auto (sunrise-sunset)
  function paint(b) {
    const ok = !!(b && b.available);
    document.querySelectorAll(".br-ui").forEach(e => { e.hidden = !ok; });
    if (!ok) return;
    document.querySelectorAll(".br-range").forEach(r => { r.min = b.min; r.value = b.level; });
    document.querySelectorAll(".br-pct").forEach(e => { e.textContent = b.level + " %"; });
    document.querySelectorAll(".dim-sw").forEach(s => s.setAttribute("aria-checked", String(b.dim)));
  }
  async function load() {
    try { const d = await U.api("/api/display");
      document.querySelectorAll(BTN).forEach(b => b.classList.toggle("on", b.dataset.rot === d.rotation));
      paint(d.brightness); } catch (e) { /* ignore */ }
  }
  async function send(body) {
    try { const d = await U.api("/api/display", body); paint(d.brightness); return d; } catch (e) { U.toast(T("br.fail")); load(); }
  }
  function reportNight(force) {   // tell navd which theme is showing; it applies the day or night level
    const n = isNight();
    if (force || n !== night) { night = n; send({ night: n }); }
  }
  function paintSize() {   // UI size (core/scale.js): Smaller / Normal / Larger on top of the automatic screen scale
    const sz = UiScale.size();
    document.querySelectorAll("#uisize button").forEach(b => b.classList.toggle("on", b.dataset.uisize === sz));
    const h = $("uisize-hint"); if (h) h.textContent = T("uisize.hint", { pct: Math.round(UiScale.value() * 100) });
  }
  function bind() {
    bound = true;
    document.querySelectorAll("#uisize button").forEach(b => b.addEventListener("click", () => UiScale.set(b.dataset.uisize)));
    window.addEventListener("navpi:uiscale", paintSize);
    window.addEventListener("resize", paintSize);
    document.querySelectorAll(BTN).forEach(b => b.addEventListener("click", async () => {
      try { await U.api("/api/display", { rotation: b.dataset.rot }); } catch (e) { U.toast(T("rot.fail")); }
      load(); setTimeout(() => window.dispatchEvent(new Event("resize")), 600);
    }));
    document.querySelectorAll(".br-range").forEach(r => {
      r.addEventListener("input", () => {
        document.querySelectorAll(".br-range").forEach(o => { o.value = r.value; });
        document.querySelectorAll(".br-pct").forEach(e => { e.textContent = r.value + " %"; });
        clearTimeout(tmr); tmr = setTimeout(() => send({ level: +r.value }), 120);   // one write per pause, not per pixel
      });
    });
    document.querySelectorAll(".dim-sw").forEach(s => s.addEventListener("click", () => send({ dim: s.getAttribute("aria-checked") !== "true" })));
  }
  Settings.section({ open() { if (!bound) bind(); load(); paintSize(); }, relang: paintSize });
  window.addEventListener("navpi:theme", () => reportNight(false));
  window.addEventListener("load", () => { if (!bound) bind(); reportNight(true); setInterval(() => reportNight(false), 15000); });
})();
