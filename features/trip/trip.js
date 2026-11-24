/* trip feature: counters A/B (rail page "Trip"), trip log with replay on the map (own maplibre layers via
   window.__map) and GPX export (navd /api/trip*, /api/trips*). Listens to the window event "navpi:pos" (maps.js) only to
   forward SIMULATED positions when navd runs with NAV_TRIP_SIM=1 (test flag); real GPS is read by navd itself.
   Optional hook: window event "navpi:dest" {from, to} (names) is passed on so the log can show from -> to. */
"use strict";
(() => {
  const $ = id => document.getElementById(id);
  let timer = null, st = null, simFeed = false, lastSim = 0, trips = [], rp = null;
  const km = m => (m / 1000).toFixed(m < 100000 ? 1 : 0) + " km";
  const brief = c => km(c.dist) + " · " + U.fmtDur(c.drive);
  const dt = s => new Date(s * 1000).toLocaleString(LANGS[LANG].locale, { weekday: "short", day: "numeric", month: "short", hour: "2-digit", minute: "2-digit" });
  const el = (tag, cls, txt) => { const e = document.createElement(tag); if (cls) e.className = cls; if (txt != null) e.textContent = txt; return e; };

  function renderCounters() {
    if (!st) return;
    document.querySelectorAll(".trip-ctr").forEach(box => {
      const k = box.dataset.c, c = st[k];
      box.replaceChildren();
      const h = el("h3", "", T("trip." + k)); if (k === "a") h.append(el("small", "", T("trip.autoReset")));
      const b = el("button", "btn", T("trip.reset")); b.addEventListener("click", async () => { await U.api("/api/trip/reset", { which: k }); load(); });
      const v = el("div", "vals");
      [[km(c.dist), "trip.dist"], [U.fmtDur(c.drive), "trip.time"], [Math.round(c.avg) + " km/h", "trip.avg"], [Math.round(c.vmax) + " km/h", "trip.max"]].forEach(([x, l]) => {
        const d = el("div", "", x); d.append(el("small", "", T(l))); v.append(d);
      });
      box.append(h, b, v);
    });
  }
  async function load() {
    try { st = await U.api("/api/trip"); simFeed = !!st.simFeed; renderCounters(); } catch (e) { /* navd restarting */ }
  }
  async function loadTrips() {
    try { trips = (await U.api("/api/trips")).trips; renderTrips(); } catch (e) { /* navd restarting */ }
  }
  function where(t) {
    const f = t.from, to = t.to;
    return f || to ? (f || "…") + " → " + (to || "…") : "";
  }
  function renderTrips() {
    const box = $("trips-list"); box.replaceChildren();
    if (!trips.length) { box.append(el("div", "trip-none", T("trip.none"))); return; }
    const dirs = (st && st.media) || [];
    trips.forEach(t => {
      const r = el("div", "trip-row");
      r.append(el("div", "n", dt(t.start) + (t.sim ? " · " + T("trip.sim") : "")));
      r.append(el("div", "st", [km(t.dist), U.fmtDur(t.dur), Math.round(t.avg) + " / " + Math.round(t.vmax) + " km/h", where(t)].filter(Boolean).join(" · ")));
      const a = el("div", "acts");
      const play = el("button", "btn primary", T("trip.replay")); play.addEventListener("click", () => replay(t));
      const g = el("a", "btn", "GPX"); g.href = "/api/trips/" + t.id + ".gpx"; g.setAttribute("download", t.id + ".gpx");
      a.append(play, g);
      if (dirs.length) {
        const sel = el("select"); dirs.forEach(d => { const o = el("option", "", d.replace(/^\/media\/(?:[^/]+\/)?/, "") || d); o.value = d; sel.append(o); });
        sel.hidden = dirs.length < 2;
        const u = el("button", "btn", T("trip.usb")); u.addEventListener("click", async () => {
          try { const x = await U.api("/api/trips/export", { id: t.id, dir: sel.value }); U.toast(T("trip.usbDone", { path: x.path })); }
          catch (e) { U.toast(T("failed", { msg: e.message })); }
        });
        a.append(...(dirs.length > 1 ? [sel] : []), u);
      }
      const x = el("button", "btn", T("trip.del")); x.addEventListener("click", async () => {
        if (x.dataset.sure !== "1") { x.dataset.sure = "1"; x.textContent = T("trip.delSure"); setTimeout(() => { x.dataset.sure = ""; x.textContent = T("trip.del"); }, 3000); return; }
        await U.api("/api/trips/delete", { id: t.id }); loadTrips();
      });
      a.append(x); r.append(a); box.append(r);
    });
  }

  // ---------- replay: a line + a playback marker on the map, own layers ----------
  function layers() {
    const m = window.__map; if (!m || !rp) return;
    const line = { type: "Feature", geometry: { type: "LineString", coordinates: rp.pts.map(p => [p[2], p[1]]) } };
    if (!m.getSource("trip-line")) {
      m.addSource("trip-line", { type: "geojson", data: line });
      m.addSource("trip-done", { type: "geojson", data: { type: "Feature", geometry: { type: "LineString", coordinates: [] } } });
      m.addSource("trip-dot", { type: "geojson", data: { type: "Feature", geometry: { type: "Point", coordinates: [rp.pts[0][2], rp.pts[0][1]] } } });
      m.addLayer({ id: "trip-line", type: "line", source: "trip-line", layout: { "line-cap": "round", "line-join": "round" }, paint: { "line-color": "#ffb020", "line-width": 6, "line-opacity": .55 } });
      m.addLayer({ id: "trip-done", type: "line", source: "trip-done", layout: { "line-cap": "round", "line-join": "round" }, paint: { "line-color": "#ffb020", "line-width": 6 } });
      m.addLayer({ id: "trip-dot", type: "circle", source: "trip-dot", paint: { "circle-radius": 10, "circle-color": "#ffffff", "circle-stroke-color": "#ff8a00", "circle-stroke-width": 5 } });
    }
  }
  function at(f) {            // f 0..1 along the recorded time -> [lng, lat, index]
    const p = rp.pts, t0 = p[0][0], T1 = p[p.length - 1][0], t = t0 + f * (T1 - t0);
    let i = 0; while (i + 1 < p.length - 1 && p[i + 1][0] < t) i++;
    const a = p[i], b = p[Math.min(i + 1, p.length - 1)], k = b[0] > a[0] ? Math.min(1, Math.max(0, (t - a[0]) / (b[0] - a[0]))) : 0;
    return { xy: [a[2] + (b[2] - a[2]) * k, a[1] + (b[1] - a[1]) * k], i };
  }
  function draw(f) {
    const m = window.__map; if (!m || !rp || !m.getSource("trip-dot")) return;
    const c = at(f);
    m.getSource("trip-dot").setData({ type: "Feature", geometry: { type: "Point", coordinates: c.xy } });
    m.getSource("trip-done").setData({ type: "Feature", geometry: { type: "LineString", coordinates: rp.pts.slice(0, c.i + 1).map(p => [p[2], p[1]]).concat([c.xy]) } });
    const sec = Math.round(f * (rp.pts[rp.pts.length - 1][0] - rp.pts[0][0]));
    $("tr-lbl").textContent = Math.floor(sec / 60) + ":" + String(sec % 60).padStart(2, "0");
    $("tr-seek").value = Math.round(f * 1000);
  }
  function frame(now) {
    if (!rp) return;
    if (rp.playing) {
      rp.f = Math.min(1, rp.f + (now - rp.last) / 1000 * rp.rate / rp.dur);
      if (rp.f >= 1) setPlaying(false);
      draw(rp.f);
    }
    rp.last = now; rp.raf = requestAnimationFrame(frame);
  }
  function setPlaying(on) {
    rp.playing = on;
    $("tr-play").innerHTML = `<svg class="i"><use href="#i-${on ? "pause" : "play"}"/></svg>`;
  }
  function bar() {
    if ($("trip-replay")) return;
    const b = el("div"); b.id = "trip-replay";
    b.innerHTML = `<button class="btn" id="tr-play"></button><input type="range" id="tr-seek" min="0" max="1000" step="1"><span class="lbl" id="tr-lbl"></span>
      <button class="btn" id="tr-close"><svg class="i"><use href="#i-close"/></svg></button>`;
    $("maps").appendChild(b);
    $("tr-play").addEventListener("click", () => { if (rp.f >= 1) rp.f = 0; setPlaying(!rp.playing); });
    $("tr-seek").addEventListener("input", e => { rp.f = e.target.value / 1000; draw(rp.f); });
    $("tr-close").addEventListener("click", stopReplay);
    $("tr-play").setAttribute("aria-label", T("trip.replay")); $("tr-close").setAttribute("aria-label", T("trip.close"));
  }
  function stopReplay() {
    const m = window.__map;
    if (rp) cancelAnimationFrame(rp.raf);
    rp = null;
    if (m) ["trip-dot", "trip-done", "trip-line"].forEach(id => { if (m.getLayer(id)) m.removeLayer(id); if (m.getSource(id)) m.removeSource(id); });
    const b = $("trip-replay"); if (b) b.classList.remove("open");
  }
  async function replay(t) {
    const m = window.__map;
    if (!m) { U.toast(T("trip.noMap")); return; }
    let d; try { d = await U.api("/api/trips/" + t.id + ".json"); } catch (e) { U.toast(T("failed", { msg: e.message })); return; }
    if (!d.points || d.points.length < 2) return;
    stopReplay();
    const dur = Math.max(1, d.points[d.points.length - 1][0] - d.points[0][0]);
    rp = { pts: d.points, f: 0, dur, rate: Math.max(5, dur / 40), playing: false, last: performance.now() };   // 5x, or the whole drive in 40 s
    Shell.go("maps"); bar();
    $("trip-replay").classList.add("open");
    layers();
    const bb = rp.pts.reduce((a, p) => [Math.min(a[0], p[2]), Math.min(a[1], p[1]), Math.max(a[2], p[2]), Math.max(a[3], p[1])], [180, 90, -180, -90]);
    m.fitBounds([[bb[0], bb[1]], [bb[2], bb[3]]], { padding: 70, duration: 600, bearing: 0, pitch: 0 });
    draw(0); setPlaying(true);
    rp.raf = requestAnimationFrame(frame);
  }

  window.addEventListener("navpi:pos", e => {          // simulated drive -> navd, only in the test mode
    const p = e.detail;
    if (!simFeed || !p || p.src !== "sim" || performance.now() - lastSim < 900) return;
    lastSim = performance.now();
    U.api("/api/trip/feed", { lat: p.lat, lng: p.lng, speed: p.speed || 0 }).catch(() => {});
  });
  window.addEventListener("navpi:dest", e => {
    const d = e.detail || {};
    U.api("/api/trip/dest", { from: d.from || null, to: d.to || null }).catch(() => {});
  });
  window.Trip = { replay, stopReplay, refresh: load };
  load();                                               // learn simFeed at start

  Shell.view("trip", {   // rail page "Trip" (2026-11-22; was a Settings card)
    show() { load().then(loadTrips); clearInterval(timer); timer = setInterval(load, 2000); },
    hide() { clearInterval(timer); timer = null; },
  });
  Shell.onLang(() => { renderCounters(); renderTrips(); });
})();
