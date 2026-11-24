/* One UI scale for every screen (2026-11-22).
   The UI is drawn in CSS px for a 720 px short side (Touch Display 2). This script picks ONE number, --ui-s on <html>,
   and core.css applies it as `zoom` to the whole page (the map canvas is zoomed back to 1, MapLibre draws at native
   pixels). So every feature — rail, status bar, cards, keyboard, speed cluster, turn card, ETA bar, a new page — scales
   together without its own rules. Runs in <head>, before the first paint, and again on resize / rotation.
     auto  = short side / 720 (above 720 it grows at half the rate: 1920x1080 -> 1.25)
     phys  = if the kiosk passes the panel size (?mm=WxH from wlr-randr, pi/kiosk.sh): controls are never physically
             smaller than on the reference panel — the 5" Touch Display 2 (720x1280 on 62x110 mm,
             ~295 px/inch) at scale 1 — so only a DENSER panel is scaled up (ppi / 295). (A first "56 px = 9 mm" rule
             gave 1.87 on that very panel and laid 1280x720 out as "tiny": removed the same day after the device check.)
     user  = Settings > Screen > UI size: Smaller 0.85 / Normal 1 / Larger 1.2 (localStorage navpi.uiSize)
     final = clamp(max(auto, phys, 0.8) x user, 0.8, short side / 380): never below 0.8 (56 px -> 45 px, 72 px -> 58 px,
             always >= 44 px), never so big that less than 380 px of layout height remain.
     e.g. 800x480 0.8 (Larger 0.96) · 1024x600 0.83 · 1280x720 1 · 1280x800 1.06 · 1920x1080 1.25 · 1920x1200 1.33 ·
          480x320 0.8 (Larger 0.84) · 720x1280 1 · 600x1024 0.83 · 480x800 0.8
   Layout classes for the room that is left, in layout px (after the scale), on <html data-fit="…">:
     short  layout height < 640 (800x480, 1024x600 at Larger)       -> rail cells shrink, tighter headers
     tiny   layout height < 470 (480x320, 3.5")                    -> icons-only rail, compact status bar, map first
     narrow layout width  < 760 (portrait 480x800)                  -> Settings rail icons only
     wide   layout width  > 1400 (1920x1080 / 1920x1200)            -> nothing stretches past its max width
   Contract for features: docs/UI-RULES.md "Screen sizes". */
"use strict";
/* Settings stored under the project's earlier name ("pinav.*") are copied once to "navpi.*" (never overwriting).
   This file is the first script of the page, so every later reader already sees the new keys. */
(() => {
  try {
    for (let i = 0; i < localStorage.length; i++) {
      const k = localStorage.key(i);
      if (k && k.startsWith("pinav.") && localStorage.getItem("navpi." + k.slice(6)) === null)
        localStorage.setItem("navpi." + k.slice(6), localStorage.getItem(k));
    }
  } catch (e) { /* storage unavailable */ }
})();
window.UiScale = (() => {
  const BASE = 720, REF_PPI = 295, MIN = 0.8, SIZES = { small: 0.85, normal: 1, large: 1.2 };
  const de = document.documentElement;
  let cur = 1;
  function size() { try { const v = JSON.parse(localStorage.getItem("navpi.uiSize")); return SIZES[v] ? v : "normal"; } catch (e) { return "normal"; } }
  function cssPpi() {   // CSS px per inch of this screen, or 0 when the panel size is unknown / implausible
    const m = /(?:^|[?&])mm=(\d+)x(\d+)/.exec(location.search);
    if (!m) return 0;
    const diagIn = Math.hypot(+m[1], +m[2]) / 25.4;
    if (diagIn < 2.5 || diagIn > 40) return 0;   // EDIDs of TVs give 0x0 or an aspect ratio (16x9 "cm")
    return Math.hypot(screen.width, screen.height) / diagIn;
  }
  function compute(w, h, user, ppi) {
    const S = Math.min(w, h);
    let s = S <= BASE ? S / BASE : 1 + (S - BASE) / BASE * 0.5;
    if (ppi) s = Math.max(s, ppi / REF_PPI);
    s = Math.max(s, MIN) * (SIZES[user] || 1);   // the user's choice acts on the fitted size, so Larger helps on 800x480 too
    s = Math.max(Math.min(s, S / 380), MIN);
    return Math.round(s * 100) / 100;
  }
  function apply() {
    const w = innerWidth, h = innerHeight;
    if (!w || !h) return;
    cur = compute(w, h, size(), cssPpi());
    de.style.setProperty("--ui-s", cur);
    de.style.setProperty("--ui-inv", 1 / cur);
    const lw = w / cur, lh = h / cur, fit = [];
    if (lh < 640) fit.push("short");
    if (lh < 470) fit.push("tiny");
    if (lw < 760) fit.push("narrow");
    if (lw > 1400) fit.push("wide");
    de.dataset.fit = fit.join(" ");
  }
  function set(v) {
    try { localStorage.setItem("navpi.uiSize", JSON.stringify(SIZES[v] ? v : "normal")); } catch (e) { /* full */ }
    apply();
    window.dispatchEvent(new CustomEvent("navpi:uiscale", { detail: { scale: cur, size: size() } }));
    window.dispatchEvent(new Event("resize"));   // map + anything that measures itself
  }
  apply();
  window.addEventListener("resize", apply);
  return { value: () => cur, size, set, compute, SIZES };
})();
