/* nav-pi helpers: geometry, formatting (German), local storage, server calls. */
"use strict";
const U = (() => {
  const R = 6371008.8, rad = d => d * Math.PI / 180, deg = r => r * 180 / Math.PI;

  // Valhalla polyline6 -> [[lon, lat], ...]
  function decodePolyline(str, precision = 6) {
    const f = Math.pow(10, precision), out = [];
    let i = 0, lat = 0, lon = 0;
    while (i < str.length) {
      for (const k of [0, 1]) {
        let b, shift = 0, res = 0;
        do { b = str.charCodeAt(i++) - 63; res |= (b & 0x1f) << shift; shift += 5; } while (b >= 0x20);
        const d = (res & 1) ? ~(res >> 1) : (res >> 1);
        if (k === 0) lat += d; else lon += d;
      }
      out.push([lon / f, lat / f]);
    }
    return out;
  }
  function dist(a, b) { // [lon,lat] metres
    const dLat = rad(b[1] - a[1]), dLon = rad(b[0] - a[0]);
    const h = Math.sin(dLat / 2) ** 2 + Math.cos(rad(a[1])) * Math.cos(rad(b[1])) * Math.sin(dLon / 2) ** 2;
    return 2 * R * Math.asin(Math.sqrt(h));
  }
  function bearing(a, b) {
    const y = Math.sin(rad(b[0] - a[0])) * Math.cos(rad(b[1]));
    const x = Math.cos(rad(a[1])) * Math.sin(rad(b[1])) - Math.sin(rad(a[1])) * Math.cos(rad(b[1])) * Math.cos(rad(b[0] - a[0]));
    return (deg(Math.atan2(y, x)) + 360) % 360;
  }
  // project p onto segment a-b in a local flat frame; returns {t (0..1), d (metres), pt}
  function project(p, a, b) {
    const k = Math.cos(rad(p[1])), ax = a[0] * k, bx = b[0] * k, px = p[0] * k;
    const dx = bx - ax, dy = b[1] - a[1];
    const L = dx * dx + dy * dy;
    let t = L ? ((px - ax) * dx + (p[1] - a[1]) * dy) / L : 0;
    t = Math.max(0, Math.min(1, t));
    const pt = [a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t];
    return { t, d: dist(p, pt), pt };
  }
  function along(a, b, t) { return [a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t]; }

  const nf1 = () => new Intl.NumberFormat(LANGS[LANG].locale, { maximumFractionDigits: 1, minimumFractionDigits: 1 });
  function fmtDist(m) {
    if (m < 0) m = 0;
    if (m < 100) return Math.round(m / 10) * 10 + " m";
    if (m < 1000) return Math.round(m / 50) * 50 + " m";
    if (m < 10000) return nf1().format(m / 1000) + " km";
    return Math.round(m / 1000) + " km";
  }
  function spokenDist(m) {  // "In <this> ..." in the current language
    const km = Math.round(m / 500) / 2;
    if (LANG === "de") {
      if (m < 1000) return (Math.round(m / 50) * 50) + " Metern";
      return (km === 1 ? "einem" : String(km).replace(".", ",")) + " Kilometer" + (km === 1 ? "" : "n");
    }
    if (m < 1000) return (Math.round(m / 50) * 50) + " meters";
    return (km === 1 ? "1 kilometer" : km + " kilometers");
  }
  function fmtDur(s) {
    const m = Math.max(1, Math.round(s / 60));
    if (m < 60) return m + " " + T("min");
    return Math.floor(m / 60) + " " + T("hr") + " " + (m % 60) + " " + T("min");
  }
  function fmtClock(d) { return d.toLocaleTimeString(LANGS[LANG].locale, { hour: "2-digit", minute: "2-digit" }); }

  const store = {
    get(k, d) { try { const v = localStorage.getItem("navpi." + k); return v === null ? d : JSON.parse(v); } catch (e) { return d; } },
    set(k, v) { try { localStorage.setItem("navpi." + k, JSON.stringify(v)); } catch (e) { /* full */ } },
  };
  async function api(path, body) {
    const r = await fetch(path, body ? { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) } : {});
    const j = await r.json().catch(() => ({}));
    if (!r.ok) throw new Error(j.error || (j.error_code ? "Valhalla " + j.error_code + ": " + j.error : "HTTP " + r.status));
    return j;
  }
  let lastSpoken = "";
  function speak(text, cue) {   // cue: recorded clip keys (voice pack), text: fallback for espeak-ng
    if (!text || text === lastSpoken) return;
    lastSpoken = text;
    window.dispatchEvent(new CustomEvent("navpi:speak", { detail: text }));   // media ducks while the voice speaks
    api("/api/speak", { text, lang: LANG, cue: cue || null }).catch(() => {});
    setTimeout(() => { if (lastSpoken === text) lastSpoken = ""; }, 4000);
  }
  let toastT;
  function toast(msg, ms = 2600) {
    const t = document.getElementById("toast");
    t.textContent = msg; t.classList.add("open");
    clearTimeout(toastT); toastT = setTimeout(() => t.classList.remove("open"), ms);
  }
  return { decodePolyline, dist, bearing, project, along, fmtDist, spokenDist, fmtDur, fmtClock, store, api, speak, toast };
})();
