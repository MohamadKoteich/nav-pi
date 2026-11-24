/* nav-pi Maps app: map, search, route preview, turn-by-turn guidance, simulated drive. */
"use strict";
const Maps = (() => {
  const $ = id => document.getElementById(id);
  const ORIGIN = location.origin;
  const REGION = (window.EDITION && EDITION.region) || "europe";  // runtime: navd /edition.js (/srv/navdata/current)
  const START = { center: [11.5755, 48.1374], zoom: 13 };   // Munich, Marienplatz: the view when the app opens (a GPS fix then takes over)
  // per-board tuning from the hardware profile (edition.js); defaults = Pi 5
  const TUNE = Object.assign({ pixelRatio: 1.5, maxPitch: 60, mapMaxZoom: 15 }, (window.EDITION && EDITION.tuning) || {});
  let map, puck, puckEl, styles = {}, theme = null;
  let state = "browse";             // browse | preview | nav
  let following = true;
  let pos = null;                   // {lng, lat, speed m/s, track deg, src: 'gps'|'sim'}
  let gpsFix = false, gpsReceiver = false;
  let puckOn = false;
  let dest = null, trip = null, guide = null, sim = null, rerouteAt = 0, arrivedAt = 0;
  let startPt = null, startMk = null;  // chosen route start {name, ctx, lat, lon}; null = your position
  let searchFor = "dest";              // the search panel picks a destination, a start or a stop
  let previewSeq = 0;                  // newest route request; older answers are dropped
  let centerFrom = null;               // no position: the map center at the first preview, kept for re-routes
  let stops = [], stopMks = [];        // PN-37 places between start and dest, in driving order
  let alts = [], altSel = 0;           // PN-35 route choices of the preview; trip = alts[altSel]
  let parkMk = null;                   // PN-39 parked-car marker
  let navAlong = 0;                    // metres driven along the guided shape (PN-38 places ahead)

  // ---------- styles (day/night, pointed at the local tile + glyph server) ----------
  // the source's maxzoom = the board's MAP_MAXZOOM (hardware/*.conf): above it MapLibre enlarges the last level's
  // tiles instead of loading more detailed ones (fewer tiles to decode on small boards; the files are cut at 15)
  async function loadStyle(name) {
    if (!styles[name]) {
      const s = await (await fetch("nav/styles/" + name + ".json")).json();
      s.sources = { protomaps: { type: "vector", tiles: [ORIGIN + "/tiles/" + REGION + "/{z}/{x}/{y}.mvt"],
        minzoom: 0, maxzoom: Math.min(15, TUNE.mapMaxZoom || 15), attribution: "© OpenStreetMap · Protomaps" } };
      s.glyphs = ORIGIN + "/fonts/{fontstack}/{range}.pbf";
      styles[name] = s;
    }
    return styles[name];
  }
  function autoTheme() { return Theme.current(); }   // PN-31/32: day/night comes from the global Light/Dark/Auto setting (core/theme.js)
  async function setTheme(name, apply = true) {
    theme = name;
    markTheme();
    // diff:false = a full style load, so "style.load" fires and the route (+ satellite) layers are added again; with
    // the default diff the switch dropped them silently (route gone at sunset while guiding, found 2026-11-12)
    if (map && apply) map.setStyle(await loadStyle(name), { diff: false });
    window.dispatchEvent(new CustomEvent("navpi:theme"));  // display: dim at night
  }
  window.addEventListener("navpi:theme", () => { const t = autoTheme(); if (map && t !== theme) setTheme(t); });   // map follows the UI

  function addRouteLayers() {
    if (!map.getSource("route")) map.addSource("route", { type: "geojson", data: emptyFC() });
    if (!map.getSource("route-alt")) map.addSource("route-alt", { type: "geojson", data: emptyFC() });
    if (!map.getLayer("route-alt-line")) {  // PN-35 the other choices, grey, under the chosen route; a wide invisible line takes the tap
      map.addLayer({ id: "route-alt-casing", type: "line", source: "route-alt", layout: { "line-cap": "round", "line-join": "round" },
        paint: { "line-color": "#4b5560", "line-width": ["interpolate", ["linear"], ["zoom"], 8, 6, 14, 12, 18, 26] } });
      map.addLayer({ id: "route-alt-line", type: "line", source: "route-alt", layout: { "line-cap": "round", "line-join": "round" },
        paint: { "line-color": "#9aa6b2", "line-width": ["interpolate", ["linear"], ["zoom"], 8, 3.5, 14, 8, 18, 19] } });
      map.addLayer({ id: "route-alt-hit", type: "line", source: "route-alt", paint: { "line-color": "rgba(0,0,0,0)", "line-width": 36 } });
    }
    if (!map.getLayer("route-casing")) {
      map.addLayer({ id: "route-casing", type: "line", source: "route", layout: { "line-cap": "round", "line-join": "round" },
        paint: { "line-color": "#0b3b78", "line-width": ["interpolate", ["linear"], ["zoom"], 8, 7, 14, 14, 18, 30] } });
      map.addLayer({ id: "route-line", type: "line", source: "route", layout: { "line-cap": "round", "line-join": "round" },
        paint: { "line-color": "#4c9dff", "line-width": ["interpolate", ["linear"], ["zoom"], 8, 4, 14, 9, 18, 22] } });
    }
    if (trip) map.getSource("route").setData(routeFC());
    if (alts.length) map.getSource("route-alt").setData(altFC());
  }
  const emptyFC = () => ({ type: "FeatureCollection", features: [] });
  const line = (coordinates, properties = {}) => ({ type: "Feature", properties, geometry: { type: "LineString", coordinates } });
  const routeFC = () => ({ type: "FeatureCollection", features: [line(guide ? guide.shape : tripShape(trip).shape)] });
  const altFC = () => ({ type: "FeatureCollection", features: state !== "preview" ? []
    : alts.map((t, i) => i === altSel ? null : line(tripShape(t).shape, { i })).filter(Boolean) });

  // ---------- init ----------
  let ready = null;
  function init() { if (!ready) ready = initImpl(); return ready; }
  async function initImpl() {
    const t = autoTheme();
    map = new maplibregl.Map({
      container: "map", style: await loadStyle(t), center: START.center,   // opens on Munich until a GPS fix arrives
      zoom: START.zoom, maxPitch: TUNE.maxPitch, attributionControl: { compact: true }, fadeDuration: 0,
      pixelRatio: Math.min(window.devicePixelRatio || 1, TUNE.pixelRatio), dragRotate: true, touchPitch: false,
    });
    window.__map = map;  // for on-device probes (tools/device-probe.mjs)
    map.on("style.load", addRouteLayers);
    await new Promise(r => map.once("load", r));
    addRouteLayers();
    await setTheme(t, false);
    map.on("dragstart", () => setFollowing(false));
    map.on("zoomstart", e => { if (e.originalEvent) setFollowing(false); });
    longPress();
    map.on("click", "route-alt-hit", e => { if (state === "preview" && e.features.length && !longFired) pickAlt(e.features[0].properties.i); });
    puckEl = document.createElement("div"); puckEl.className = "puck";
    puckEl.innerHTML = '<svg viewBox="0 0 48 48"><circle cx="24" cy="24" r="21" fill="#fff"/><circle cx="24" cy="24" r="17" fill="#4c9dff"/><path d="M24 9 33 35 24 30 15 35z" fill="#fff"/></svg>';
    puck = new maplibregl.Marker({ element: puckEl, rotationAlignment: "map", pitchAlignment: "map" });

    // search
    const q = $("q");
    q.addEventListener("focus", () => { Keyboard.show(q, onQuery, onQuery); $("q-clear").hidden = false; if (!q.value) showRecents(); });
    $("q-clear").addEventListener("click", () => closeSearch());
    $("btn-recenter").addEventListener("click", () => { setFollowing(true); camera(true); });
    document.querySelectorAll("[data-theme]").forEach(b => b.addEventListener("click", () => setTheme(b.dataset.theme)));
    $("s-cancel").addEventListener("click", cancelPreview);
    $("s-go").addEventListener("click", () => start(false));
    $("s-sim").addEventListener("click", () => start(true));
    $("btn-stop").addEventListener("click", () => stop(true));
    const pickedPlace = () => ({ name: T("marked"), ctx: picked.lat.toFixed(5) + ", " + picked.lng.toFixed(5), lat: picked.lat, lon: picked.lng });
    $("p-cancel").addEventListener("click", () => { $("pick").classList.remove("open"); if (state === "preview") $("sheet").classList.add("open"); });
    $("p-dest").addEventListener("click", () => { $("pick").classList.remove("open"); if (state === "nav") navigateTo(pickedPlace()); else preview(pickedPlace(), startPt, []); });
    $("p-stop").addEventListener("click", () => { $("pick").classList.remove("open"); const pl = pickedPlace(); if (state === "nav") insertStop(pl, alongOf(pl)); else addStop(pl); });
    $("p-park").addEventListener("click", () => { $("pick").classList.remove("open"); park(picked.lat, picked.lng); if (state === "preview") $("sheet").classList.add("open"); });
    $("s-addstop").addEventListener("click", chooseStop);
    $("p-start").addEventListener("click", () => { $("pick").classList.remove("open"); setStart(pickedPlace()); });
    $("s-from").addEventListener("click", chooseStart);
    $("s-swap").addEventListener("click", swap);
    $("s-opts").addEventListener("click", openOpts);
    $("ro-done").addEventListener("click", closeOpts);
    $("s-save").addEventListener("click", () => { if (dest) openPlace({ place: dest, kind: "new" }); });
    $("p-save").addEventListener("click", () => openPlace({ place: pickedPlace(), kind: "new" }));
    $("pf-home").addEventListener("click", () => savePlace("home"));
    $("pf-work").addEventListener("click", () => savePlace("work"));
    $("pf-save").addEventListener("click", () => savePlace("fav"));
    $("pf-del").addEventListener("click", deletePlace);
    $("pf-cancel").addEventListener("click", closePlace);
    $("pf-clear").addEventListener("click", () => { $("pf-name").value = ""; focusName(); });
    $("pf-name").addEventListener("focus", focusName);
    markOpts();
    parkMarker();
    gps();
    if (window.DeadReckon) DeadReckon.attach({ guide: () => (state === "nav" ? guide : null), emit: p => { if (!sim) onPosition(p); } });   // gps/deadreckon.js: tunnel estimate along the route
  }
  function resize() { if (map) map.resize(); }

  // ---------- positions ----------
  function gps() {
    const es = new EventSource("/api/gps");
    es.onmessage = e => {
      const g = JSON.parse(e.data);
      gpsReceiver = !!g.receiver; gpsFix = g.mode >= 2 && g.lat != null;
      gpsChip();
      if (gpsFix && !sim) onPosition({ lng: g.lon, lat: g.lat, speed: g.speed || 0, track: g.track, src: "gps" });
      if (window.DeadReckon && !sim) DeadReckon.update(gpsFix ? { lng: g.lon, lat: g.lat, speed: g.speed || 0, track: g.track } : null);
    };
    es.onerror = () => { gpsFix = false; Shell.gpsStatus(sim ? "sim" : "none"); if (window.DeadReckon && !sim) DeadReckon.update(null); };
  }
  function gpsChip() { Shell.gpsStatus(sim ? "sim" : gpsFix ? "fix" : window.DeadReckon && DeadReckon.on() ? "est" : gpsReceiver ? "search" : "none"); }
  window.addEventListener("navpi:gps-est", gpsChip);
  function onPosition(p) {
    if (p.track == null && pos) p.track = U.bearing([pos.lng, pos.lat], [p.lng, p.lat]);
    pos = p; window.dispatchEvent(new CustomEvent("navpi:pos", { detail: p }));
    // the ONE current-speed source of the app (GPS, simulation or the tunnel estimate today; a later sensor, e.g. an
    // IMU, only has to dispatch the same event). The speed display and the over-speed check read nothing else.
    window.dispatchEvent(new CustomEvent("navpi:speed", { detail: { kmh: (p.speed || 0) * 3.6, src: p.src || "gps" } }));
    puck.setLngLat([p.lng, p.lat]).setRotation(p.track || 0);
    puckEl.classList.toggle("est", p.src === "est");   // grey arrow = estimated position (gps/deadreckon.js)
    if (!puckOn) { puck.addTo(map); puckOn = true; }
    if (Math.random() < .05) U.store.set("lastPos", { lng: p.lng, lat: p.lat });
    if (state === "nav") navTick();
    if (following && state !== "preview") camera(false);
  }
  function camera(force) {
    if (!pos) { if (force) U.toast(T("toast.noPos")); return; }
    const navigating = state === "nav";
    const v = pos.speed || 0;
    const zoom = navigating ? (v > 25 ? 15.2 : v > 14 ? 16 : 16.8) : Math.max(map.getZoom(), 15);
    const h = map.getContainer().clientHeight;
    map.easeTo({ center: [pos.lng, pos.lat], zoom, bearing: navigating ? (pos.track || 0) : map.getBearing(),
      pitch: navigating ? Math.min(52, TUNE.maxPitch) : 0, padding: { top: navigating ? h * 0.42 : 0, bottom: 0, left: 0, right: 0 },
      duration: force ? 600 : (pos.src === "sim" ? 280 : 900), easing: t => t });
  }
  function setFollowing(on) {
    following = on;
    $("btn-recenter").style.display = on && state === "nav" ? "none" : "";
  }

  // ---------- search ----------
  let qt;
  function onQuery(text) {
    clearTimeout(qt);
    qt = setTimeout(async () => {
      const box = $("search-results");
      if (!text.trim()) { showRecents(); return; }
      const c = pos ? [pos.lng, pos.lat] : map.getCenter().toArray();
      let res = [];
      try { res = await U.api(`/api/search?q=${encodeURIComponent(text)}&lat=${c[1]}&lon=${c[0]}`); } catch (e) { /* offline index missing */ }
      box.innerHTML = "";
      if (!res.length) { const e = document.createElement("div"); e.className = "empty"; e.textContent = T("search.none"); box.appendChild(e); }
      for (const r of res) box.appendChild(resultRow(r, c));
      box.classList.add("open");
    }, 180);
  }
  const KINDMAP = { isolated_dwelling: "hamlet", quarter: "suburb", macrohood: "suburb" };
  const kindLabel = k => { const key = "kind." + (KINDMAP[k] || k); const t = T(key); return t === key ? "" : t; };
  function resultRow(r, c) {
    const b = document.createElement("button"); b.className = "row";
    const d = U.dist(c, [r.lon, r.lat]);
    b.innerHTML = `<svg class="i"><use href="#i-pin"/></svg><div class="main"><div class="n"></div><div class="c"></div></div><div class="c num">${U.fmtDist(d)}</div>`;
    b.querySelector(".n").textContent = r.name;
    b.querySelector(".main .c").textContent = [kindLabel(r.kind), r.context].filter(Boolean).join(" · ");
    b.addEventListener("click", () => choose({ name: r.name, ctx: r.context || kindLabel(r.kind), lat: r.lat, lon: r.lon }));
    return b;
  }
  function choose(place) {
    const mode = searchFor;
    closeSearch(false);
    if (mode === "start") setStart(place);
    else if (mode === "stop") addStop(place);
    else preview(place, startPt, []);  // a new destination starts a new trip (no stops)
  }
  function closeSearch(restore = true) {
    Keyboard.hide(); $("q").value = ""; $("q").blur(); $("q-clear").hidden = true;
    $("search-results").classList.remove("open");
    if (searchFor !== "dest") {
      searchFor = "dest"; searchPh("search.ph");
      if (restore && state === "preview") $("sheet").classList.add("open");
    }
  }
  let picked = null;
  // ---------- route start: your position (default), an address, a recent place or a point on the map ----------
  // via data-i18n-ph so a language switch keeps the right placeholder
  function searchPh(key) { const q = $("q"); q.dataset.i18nPh = key; q.placeholder = T(key); }
  function chooseStart() {
    searchFor = "start"; searchPh("from.ph");
    $("sheet").classList.remove("open");
    $("q").focus();
  }
  function setStart(place) {
    if (place) remember(place);
    if (dest && state === "preview") preview(dest, place);
    else { startPt = place; if (place) U.toast(T("toast.startSet")); }
  }
  function swap() {
    if (!dest || !trip) return;
    let back = startPt;
    if (!back) {
      if (!pos) { U.toast(T("toast.noPos")); return; }
      back = { name: T("from.here"), ctx: pos.lat.toFixed(5) + ", " + pos.lng.toFixed(5), lat: pos.lat, lon: pos.lng, here: true };
    }
    preview(back, dest.here ? null : dest, stops.slice().reverse());
  }
  // ---------- PN-37 stops: added from search, saved places or a long-press; reordered with up/down ----------
  const MAX_STOPS = 8;
  function chooseStop() {
    if (stops.length >= MAX_STOPS) { U.toast(T("stop.max", { n: MAX_STOPS })); return; }
    searchFor = "stop"; searchPh("stop.ph");
    $("sheet").classList.remove("open");
    $("q").focus();
  }
  function addStop(place) {
    if (!dest || state !== "preview") return;
    if (stops.length >= MAX_STOPS) { U.toast(T("stop.max", { n: MAX_STOPS })); $("sheet").classList.add("open"); return; }
    remember(place);
    preview(dest, startPt, stops.concat([place]));  // a new stop goes last, before the destination
  }
  // move stop i by d (-1 up, +1 down); the destination takes part as the last place
  function moveStop(i, d) {
    const all = stops.concat([dest]), j = i + d;
    if (j < 0 || j >= all.length) return;
    [all[i], all[j]] = [all[j], all[i]];
    preview(all.pop(), startPt, all);
  }
  const removeStop = i => preview(dest, startPt, stops.filter((s, k) => k !== i));
  function stopMarkers() {
    stopMks.forEach(m => m.remove()); stopMks = [];
    if (state === "browse") return;
    const from = guide ? guide.passed : 0;
    stops.forEach((s, i) => {
      const el = document.createElement("div"); el.className = "stoppin" + (i < from ? " done" : ""); el.textContent = i + 1;
      stopMks.push(new maplibregl.Marker({ element: el }).setLngLat([s.lon, s.lat]).addTo(map));
    });
  }
  function fillStops() {
    const box = $("s-stops"); box.innerHTML = "";
    stops.forEach((s, i) => {
      const r = document.createElement("div"); r.className = "stop";
      r.innerHTML = `<span class="no">${i + 1}</span><span class="nm"></span>`;
      r.querySelector(".nm").textContent = s.name;
      const btn = (icon, label, fn, off) => {
        const b = document.createElement("button"); b.className = "ico"; b.setAttribute("aria-label", label); b.disabled = !!off;
        b.innerHTML = `<svg class="i"><use href="#${icon}"/></svg>`; b.addEventListener("click", fn); r.appendChild(b);
      };
      btn("i-up", T("stop.up"), () => moveStop(i, -1), i === 0);
      btn("i-down", T("stop.down"), () => moveStop(i, 1));
      btn("i-close", T("stop.remove"), () => removeStop(i));
      box.appendChild(r);
    });
    box.hidden = !stops.length;
  }
  function startMarker() {
    if (startMk) { startMk.remove(); startMk = null; }
    if (!startPt || state !== "preview") return;
    const el = document.createElement("div"); el.className = "startpin";
    el.innerHTML = '<svg viewBox="0 0 24 24"><circle cx="12" cy="12" r="9" fill="#fff"/><circle cx="12" cy="12" r="6" fill="#2fbf71"/></svg>';
    startMk = new maplibregl.Marker({ element: el }).setLngLat([startPt.lon, startPt.lat]).addTo(map);
  }
  // Map gestures (PN-MAPTAP-01: "it should only appear if I long press, when I am just browsing the
  // map there should be nothing bothering me"): a short tap on the map does NOTHING (no sheet, no marker), in browsing,
  // preview and while driving. Only a long press opens the place sheet: one finger (or the left mouse button) held
  // LONG_MS without moving more than 10 px. A second finger (pinch), a pan/zoom/rotate by the user, lifting the finger
  // anywhere, a pointer cancel or a hidden page all cancel it, and one timer only ever exists (a second pointerdown
  // can no longer leave an old timer running = the old "tap opens Drive here" leak). Taps that stay deliberate: the
  // grey alternative route lines (preview), the parked-car P marker, stop/start markers (their own elements).
  const LONG_MS = 500, SLOP = 10;
  let longFired = false;   // the last press became a long press: the click MapLibre sends on its release is not a tap
  function longPress() {
    const el = map.getCanvasContainer();
    let t = null, down = null;
    const clear = () => { clearTimeout(t); t = null; down = null; };
    const fire = d => { clear(); longFired = true; openPick(d.x, d.y); };
    el.addEventListener("pointerdown", e => {
      if (down) {
        // the same finger reported twice (touch + emulated pointer) is ignored; any other pointer = a pinch: no press
        if (!(e.isPrimary && Math.hypot(e.clientX - down.x, e.clientY - down.y) < SLOP)) clear();
        return;
      }
      if (!e.isPrimary || e.button > 0) return;
      longFired = false;
      const d = down = { id: e.pointerId, x: e.clientX, y: e.clientY, t0: e.timeStamp };
      // fire on the next frame: a lift queued behind a busy frame (Pi 4 rendering) is handled first and still cancels
      t = setTimeout(() => requestAnimationFrame(() => { if (down === d) fire(d); }), LONG_MS);
    });
    window.addEventListener("pointermove", e => { if (down && Math.hypot(e.clientX - down.x, e.clientY - down.y) > SLOP) clear(); }, true);
    window.addEventListener("pointerup", e => {
      const d = down; if (!d) return;
      if (e.pointerId === d.id && e.timeStamp - d.t0 >= LONG_MS) fire(d);   // held long enough, the timer was late
      else clear();
    }, true);
    window.addEventListener("pointercancel", clear, true);
    window.addEventListener("blur", clear);
    document.addEventListener("visibilitychange", clear);
    map.on("movestart", e => { if (e.originalEvent) clear(); });   // the user pans / zooms / rotates (not camera follow)
  }
  // the place sheet for a long-pressed point. Browse: Drive here, Start here, Park here, save. Preview: + Add stop.
  // Driving: Add stop (inserted where the point lies along the route) and Drive here (guidance switches to it).
  function openPick(x, y) {
    if (!$("pick") || $("placeform").classList.contains("open")) return;
    const el = map.getCanvasContainer(), r = el.getBoundingClientRect();
    const ll = map.unproject([x - r.left, y - r.top]);
    picked = ll;
    $("sheet").classList.remove("open");
    $("p-ctx").textContent = T("pick.point", { lat: ll.lat.toFixed(5), lon: ll.lng.toFixed(5) });
    $("p-stop").hidden = state !== "preview" && state !== "nav";
    $("p-start").hidden = $("p-park").hidden = state === "nav";
    $("pick").classList.add("open");
  }
  // metres along the guided route where a point lies (nearest shape point), for a stop added while driving
  function alongOf(place) {
    if (!guide || !guide.shape) return navAlong;
    let best = Infinity, at = navAlong;
    guide.shape.forEach((p, i) => { const d = U.dist(p, [place.lon, place.lat]); if (d < best) { best = d; at = guide.cum[i]; } });
    return Math.max(at, navAlong);
  }

  // ---------- routing ----------
  function origin(sp) {
    if (sp) return { lng: sp.lon, lat: sp.lat, real: false };
    if (pos) return { lng: pos.lng, lat: pos.lat, track: pos.track, real: pos.src === "gps" };
    if (!centerFrom) { const c = map.getCenter(); centerFrom = { lng: c.lng, lat: c.lat, real: false }; }
    return centerFrom;
  }
  // from -> via stops (PN-37, Valhalla "break" locations) -> to; to.walk = on foot (PN-39, back to the car).
  // alt > 0 asks for that many alternatives (PN-35; Valhalla 3.5 gives them for two locations only). -> [trip, ...alternatives]
  async function routes(from, to, via = [], alt = 0) {
    const walk = !!to.walk, loc0 = { lat: from.lat, lon: from.lng };
    if (!walk && from.track != null && from.real !== false) { loc0.heading = Math.round(from.track); loc0.heading_tolerance = 60; }
    // PN-41 a round trip's own points (to.via) are "through" points: no leg, no stop, no announcement
    const thru = (to.via || []).map(s => ({ lat: s.lat, lon: s.lon, type: "through", search_filter: { min_road_class: "tertiary" } }));
    const body = { locations: [loc0, ...via.map(s => ({ lat: s.lat, lon: s.lon, type: "break" })), ...thru, { lat: to.lat, lon: to.lon }],
      costing: walk ? "pedestrian" : "auto", directions_options: { language: LANGS[LANG].valhalla, units: "kilometers" } };
    if (!walk) body.costing_options = { auto: costing() };
    if (alt && !via.length) body.alternates = alt;
    const rq = { body, url: "/api/route" };
    window.dispatchEvent(new CustomEvent("navpi:routebody", { detail: rq }));   // safety: "avoid low-emission zones" routes via its own URL
    let r;
    try { r = await U.api(rq.url, body); } catch (e) {   // that route failed: the plain one
      if (rq.url === "/api/route") throw e;
      r = await U.api("/api/route", body); window.dispatchEvent(new CustomEvent("navpi:avoidfail"));
    }
    return [r.trip].concat((r.alternates || []).map(a => a.trip).filter(Boolean));
  }
  const route = async (from, to, via = stops) => (await routes(from, to, via))[0];
  // route to d from sp (default: the current start); dest/start/trip change only when the route arrives,
  // so a failed re-route (swap, new start) keeps the previous preview usable
  async function preview(d, sp = startPt, via = stops) {
    Shell.go("maps");
    await init();
    const seq = ++previewSeq;
    state = "preview"; setFollowing(false);
    $("sheet").classList.add("busy");  // stop buttons wait for this answer (a second tap would act on the old list)
    U.toast(T("toast.routing"), 15000);
    let all;
    try { all = await routes(origin(sp), d, via, 2); } catch (e) {
      if (seq !== previewSeq) return;
      $("sheet").classList.remove("busy");
      U.toast(T("toast.noRoute", { msg: e.message }), 4000);
      if (!trip) { state = "browse"; centerFrom = null; } else $("sheet").classList.add("open");
      return;
    }
    if (seq !== previewSeq) return;
    $("sheet").classList.remove("busy");
    dest = d; startPt = sp; stops = via.slice(); alts = all; altSel = 0; trip = all[0];
    $("toast").classList.remove("open");
    guide = null;
    startMarker(); stopMarkers();
    $("s-from-name").textContent = startPt ? startPt.name : pos ? T("from.here") : T("from.center");
    $("s-dest").textContent = d.name;
    const av = d.walk ? [] : avoiding();
    $("s-ctx").textContent = [d.ctx, d.walk ? T("park.walk") : "", stops.length ? T("stop.count", { n: stops.length }) : "",
      av.length ? T("ro.avoiding", { list: av.join(", ") }) : ""].filter(Boolean).join(" · ");
    markSaved(); markOpts(); fillStops(); fillAlts();
    $("s-go").disabled = false;
    $("sheet").classList.add("open");
    window.dispatchEvent(new CustomEvent("navpi:preview", { detail: { trip } }));   // safety: low-emission zone note
    // fit every choice beside the sheet: below it (portrait) or right of it (landscape)
    const pts = alts.flatMap(t => tripShape(t).shape).concat(stops.map(s => [s.lon, s.lat]));
    const b = pts.reduce((bb, p) => bb.extend(p), new maplibregl.LngLatBounds(pts[0], pts[0]));
    const c = map.getContainer(), sh = $("sheet"), land = c.clientWidth > c.clientHeight;
    const k = window.UiScale ? UiScale.value() : 1;   // the sheet is in UI px, the map in screen px (core/scale.js)
    const pad = land ? { top: 120 * k, bottom: 40 * k, left: Math.min((sh.offsetWidth + 40) * k, c.clientWidth * 0.6), right: 40 * k }
      : { top: 110 * k, bottom: Math.min((sh.offsetHeight + 30) * k, c.clientHeight * 0.6), left: 40 * k, right: 40 * k };
    map.fitBounds(b, { padding: pad, bearing: 0, pitch: 0, duration: 700 });
    window.dispatchEvent(new CustomEvent("navpi:preview", { detail: { dest } }));   // PN-38/41: along.js, roundtrip.js, qr.js
  }
  // PN-35: the route choices; i = index in alts
  function pickAlt(i) {
    if (!alts[i] || i === altSel) return;
    altSel = i; trip = alts[i];
    showRoute(); fillAlts();
  }
  function showRoute() {
    map.getSource("route").setData(routeFC());
    map.getSource("route-alt").setData(altFC());
    $("s-time").textContent = U.fmtDur(trip.summary.time);
    $("s-dist").textContent = U.fmtDist(trip.summary.length * 1000);
    $("s-arrive").textContent = T("arriveAt", { t: U.fmtClock(new Date(Date.now() + trip.summary.time * 1000)) });
  }
  // "via <main road>": the longest-driven street of each choice that the other choices barely use
  function viaRoads(trips) {
    const ranked = trips.map(t => {
      const len = new Map();
      for (const l of t.legs) for (const m of l.maneuvers) { const n = (m.street_names || [])[0]; if (n) len.set(n, (len.get(n) || 0) + m.length); }
      return [...len].sort((a, b) => b[1] - a[1]).map(e => e[0]);
    });
    return ranked.map((names, i) => names.find(n => ranked.every((o, j) => j === i || !o.slice(0, 5).includes(n))) || names[0] || "");
  }
  function fillAlts() {
    const box = $("s-alts"); box.innerHTML = "";
    box.hidden = alts.length < 2;
    if (box.hidden) { showRoute(); return; }
    const via = viaRoads(alts);
    alts.forEach((t, i) => {
      const b = document.createElement("button"); b.className = "alt"; b.dataset.i = i;
      b.setAttribute("role", "radio"); b.setAttribute("aria-checked", i === altSel); b.setAttribute("aria-label", T("alt.n", { n: i + 1 }));
      b.innerHTML = '<b class="num"></b><span class="num d"></span><span class="via"></span>';
      b.querySelector("b").textContent = U.fmtDur(t.summary.time);
      b.querySelector(".d").textContent = U.fmtDist(t.summary.length * 1000);
      b.querySelector(".via").textContent = via[i] ? T("alt.via", { road: via[i] }) : "";
      b.addEventListener("click", () => pickAlt(i));
      box.appendChild(b);
    });
    showRoute();
  }
  function cancelPreview() {
    $("sheet").classList.remove("open"); trip = null; dest = null; state = "browse";
    startPt = null; centerFrom = null; stops = []; alts = []; previewSeq++; startMarker(); stopMarkers();
    map.getSource("route").setData(emptyFC()); map.getSource("route-alt").setData(emptyFC());
  }
  async function start(simulate) {
    if (!trip) return;
    if (!simulate && !gpsFix) { U.toast(T("toast.noGps")); return; }
    // driving for real from a planned start elsewhere: guide from where the car is (simulation drives the plan)
    if (!simulate && startPt && U.dist([pos.lng, pos.lat], [startPt.lon, startPt.lat]) > 150) {
      const seq = ++previewSeq, go = $("s-go");
      go.disabled = true;  // no second Go while the route from here is computed
      let t;
      try { t = await route({ lng: pos.lng, lat: pos.lat, track: pos.track, real: true }, dest); }
      catch (e) { go.disabled = false; U.toast(T("toast.noRoute", { msg: e.message }), 4000); return; }
      go.disabled = false;
      if (seq !== previewSeq || state !== "preview") return;  // cancelled / Simulate / new preview meanwhile
      trip = t;
      map.getSource("route").setData(routeFC());
      U.toast(T("toast.fromHere"), 3000);
    }
    const fromName = simulate && startPt ? startPt.name : pos ? T("from.here") : T("from.center");
    startPt = null; centerFrom = null; previewSeq++; startMarker();
    remember(dest);
    window.dispatchEvent(new CustomEvent("navpi:dest", { detail: { from: fromName, to: dest.name } }));  // trip log
    guide = new Guidance(trip, { walk: dest.walk }); navAlong = 0;
    if (dest.via) markVias(dest.via, guide.shape, guide.cum);
    state = "nav"; arrivedAt = 0; alts = [];
    map.getSource("route-alt").setData(emptyFC()); stopMarkers();
    document.body.classList.add("navigating");
    $("sheet").classList.remove("open");
    $("banner").classList.add("open"); $("tripbar").classList.add("open");
    setFollowing(true);
    if (simulate) startSim(); else navTick();
    U.speak(T("say.go"), ["go"]);
  }
  function stop(byUser) {
    if (sim) { clearInterval(sim.timer); sim = null; }
    if (guide && pos && (pos.src === "gps" || window.__parkSim) && dest && !dest.walk) park(pos.lat, pos.lng, true);  // PN-39: a real drive ended here (simulations do not park; __parkSim = test harness)
    state = "browse"; guide = null; trip = null; dest = null; centerFrom = null; stops = []; alts = []; previewSeq++; SpeedLimits.reset();
    window.dispatchEvent(new CustomEvent("navpi:nav", { detail: null }));   // dashboard (PN-47)
    window.dispatchEvent(new CustomEvent("navpi:navstop"));
    stopMarkers();
    document.body.classList.remove("navigating");
    $("banner").classList.remove("open"); $("tripbar").classList.remove("open");
    window.dispatchEvent(new CustomEvent("navpi:guide", { detail: null }));
    if (map.getSource("route")) map.getSource("route").setData(emptyFC());
    map.easeTo({ pitch: 0, bearing: 0, padding: { top: 0, bottom: 0, left: 0, right: 0 }, duration: 500 });
    setFollowing(true);
    Shell.gpsStatus(gpsFix ? "fix" : gpsReceiver ? "search" : "none");
    if (byUser) U.toast(T("toast.stopped"));
  }
  async function reroute() {
    if (Date.now() - rerouteAt < 8000) return;
    rerouteAt = Date.now();
    U.speak(T("say.reroute"), ["reroute"]);
    try { await driveOn(stops.slice(guide ? guide.passed : 0)); }   // stops already reached are not driven again
    catch (e) { U.toast(T("toast.rerouteFail"), 3000); }
  }
  // a new route from the car to dest (via the stops `left`), guidance goes on (reroute, PN-38 stop or new destination)
  async function driveOn(left, to = dest) {
    if (to.via && guide) to.via = to.via.filter(v => !(v.at < navAlong));   // PN-41: round-trip points already passed
    const t = await route({ lng: pos.lng, lat: pos.lat, track: pos.track, real: true }, to, left);
    if (state !== "nav") return;
    trip = t; stops = left; dest = to;
    guide = new Guidance(trip, { walk: dest.walk }); navAlong = 0;
    if (to.via) markVias(to.via, guide.shape, guide.cum);
    if (sim) sim.restart(guide);
    map.getSource("route").setData(routeFC()); stopMarkers();
  }
  // metres along the shape where each round-trip point is passed (nearest shape point)
  function markVias(via, shape, cum) {
    for (const v of via) {
      let best = Infinity;
      shape.forEach((p, i) => { const d = U.dist(p, [v.lon, v.lat]); if (d < best) { best = d; v.at = cum[i]; } });
    }
  }
  // ---------- PN-38 / PN-41 hooks for along.js, roundtrip.js, qr.js ----------
  // the current route: legs' encoded shapes, metres driven, where each stop is along the route
  function ctx() {
    if (!trip || state === "browse") return { state, pos };
    const g = guide, ends = [];
    let m = 0;
    for (const l of trip.legs) { m += l.summary.length * 1000; ends.push(m); }
    return { state, legs: trip.legs.map(l => l.shape), done: g ? navAlong : 0, stopsAt: g ? g.stops.slice(g.passed) : ends.slice(0, -1),
      stops: g ? stops.slice(g.passed) : stops.slice(), dest, pos };
  }
  // add a place as a stop where it lies along the route (atM = metres along the whole route)
  async function insertStop(place, atM) {
    const c = ctx();
    const k = c.stopsAt.filter(s => s < atM).length, left = c.stops.slice(0, k).concat([place], c.stops.slice(k));
    if (left.length > MAX_STOPS) { U.toast(T("stop.max", { n: MAX_STOPS })); return; }
    if (state === "preview") return preview(dest, startPt, left);
    if (state !== "nav") return;
    U.toast(T("toast.routing"), 15000);
    try { await driveOn(left); U.toast(T("toast.stopAdded", { name: place.name }), 3000); } catch (e) { U.toast(T("toast.noRoute", { msg: e.message }), 4000); }
  }
  // drive to a place now: a preview becomes that destination; while driving, guidance switches to it
  async function navigateTo(place) {
    if (state !== "nav") return preview(place, startPt, []);
    U.toast(T("toast.routing"), 15000);
    try {
      await driveOn([], place); remember(place);
      window.dispatchEvent(new CustomEvent("navpi:dest", { detail: { to: place.name } }));
      $("toast").classList.remove("open");
    } catch (e) { U.toast(T("toast.noRoute", { msg: e.message }), 4000); }
  }

  // ---------- guidance UI ----------
  function navTick() {
    if (!guide || !pos) return;
    const st = guide.update([pos.lng, pos.lat], pos.speed);
    if (st.offRoute) return reroute();
    navAlong = st.along;
    const n = st.next;
    $("b-arrow").innerHTML = maneuverSvg(n.type);
    $("b-dist").textContent = arrivedAt ? T("arrived") : U.fmtDist(st.toNext);
    $("b-street").textContent = (n.street_names && n.street_names[0]) || n.instruction || "";
    const then = $("b-then");
    if (st.after && st.after.at - n.at < 400) {
      then.classList.add("on");
      $("b-then-arrow").innerHTML = maneuverSvg(st.after.type);
      $("b-then-text").textContent = (st.after.street_names && st.after.street_names[0]) || "";
    } else then.classList.remove("on");
    $("t-arrive").textContent = U.fmtClock(new Date(Date.now() + st.remainTime * 1000));
    $("t-rest").textContent = U.fmtDur(st.remainTime) + " · " + U.fmtDist(st.remain);
    window.dispatchEvent(new CustomEvent("navpi:nav", { detail: { type: n.type, toNext: st.toNext, street: $("b-street").textContent,
      remainTime: st.remainTime, remain: st.remain, arrived: !!arrivedAt } }));   // dashboard (PN-47)
    SpeedLimits.tick(st.limit);
    window.dispatchEvent(new CustomEvent("navpi:guide", { detail: { guide, st, speed: pos.speed || 0 } }));   // PN-36/40 lanes.js + safety alerts
    if (st.say) U.speak(st.say.text, st.say.cue);
    if (st.reached) {  // PN-37: an intermediate stop; guidance simply goes on to the next leg
      const s = stops[st.reached - 1];
      U.toast(T("toast.stop", { n: st.reached, name: s ? s.name : "" }), 4000);
      stopMarkers();
    }
    if (st.arrived && !arrivedAt) {
      arrivedAt = Date.now();
      $("b-dist").textContent = T("arrived");
      setTimeout(() => { if (state === "nav") stop(false); }, 6000);
    }
  }

  // ---------- simulated drive (testing without a GPS receiver) ----------
  function startSim() {
    Shell.gpsStatus("sim");
    sim = { d: 0, g: guide, timer: null, last: performance.now(),
      restart(g) { this.g = g; this.d = 0; } };
    // speed per shape point from the maneuver it belongs to (length/time), capped for realism
    sim.speedAt = (g, d) => {
      let k = 0; while (k + 1 < g.man.length && g.man[k + 1].at <= d) k++;
      const m = g.man[k];
      return m.time > 0 ? Math.min(36, (m.length * 1000) / m.time) : 8;
    };
    sim.timer = setInterval(() => {
      const now = performance.now(), dt = Math.min(0.5, (now - sim.last) / 1000); sim.last = now;
      const g = sim.g; const v = sim.speedAt(g, sim.d);
      sim.d = Math.min(g.total, sim.d + v * dt);
      let i = 0; while (i + 1 < g.cum.length - 1 && g.cum[i + 1] < sim.d) i++;
      const segLen = (g.cum[i + 1] - g.cum[i]) || 1;
      const p = U.along(g.shape[i], g.shape[i + 1], (sim.d - g.cum[i]) / segLen);
      onPosition({ lng: p[0], lat: p[1], speed: sim.d >= g.total ? 0 : v, track: U.bearing(g.shape[i], g.shape[i + 1]), src: "sim" });
      if (sim && sim.d >= g.total) { clearInterval(sim.timer); }
    }, 250);
  }

  // ---------- PN-33 route options: Valhalla 3.5 auto costing; previews and reroutes use the same ones ----------
  const RO = ["highways", "tolls", "ferries", "unpaved"];
  const routeOpts = () => Object.assign({ highways: false, tolls: false, ferries: false, unpaved: false }, U.store.get("routeOpts", {}));
  function costing() {  // "avoid" = strongest preference (Valhalla still uses a ferry/toll road when there is no other way)
    const o = routeOpts(), a = {};
    if (o.highways) a.use_highways = 0;
    if (o.tolls) a.use_tolls = 0;
    if (o.ferries) a.use_ferry = 0;
    if (o.unpaved) a.exclude_unpaved = true;
    return a;
  }
  const avoiding = () => { const o = routeOpts(); return RO.filter(k => o[k]).map(k => T("ro.s." + k)); };
  let roBefore = null;
  function openOpts() {
    closePlace();
    roBefore = JSON.stringify(routeOpts());
    const box = $("ro-list"), o = routeOpts(); box.innerHTML = "";
    for (const k of RO) {
      const b = document.createElement("button"); b.className = "row tog"; b.dataset.opt = k; b.setAttribute("role", "switch");
      b.innerHTML = '<span class="main"></span><span class="switch"><span></span></span>';
      b.querySelector(".main").textContent = T("ro." + k);
      const show = on => { b.setAttribute("aria-checked", on); b.querySelector(".switch").setAttribute("aria-checked", on); };
      show(o[k]);
      b.addEventListener("click", () => { const cur = routeOpts(); cur[k] = !cur[k]; U.store.set("routeOpts", cur); show(cur[k]); });
      box.appendChild(b);
    }
    $("ropts").classList.add("open");
  }
  function closeOpts() {
    $("ropts").classList.remove("open"); markOpts();
    if (JSON.stringify(routeOpts()) !== roBefore && dest && state === "preview") preview(dest);
  }
  function markOpts() { $("s-opts").classList.toggle("on", avoiding().length > 0); }

  // ---------- PN-34 saved places: Home, Work and favourites, stored on this device ----------
  const EDIT_SVG = '<svg class="i" viewBox="0 0 24 24"><path d="M3 17.25V21h3.75L17.81 9.94l-3.75-3.75L3 17.25zM20.71 7.04a1 1 0 0 0 0-1.41l-2.34-2.34a1 1 0 0 0-1.41 0l-1.83 1.83 3.75 3.75 1.83-1.83z"/></svg>';
  const iconOf = id => $(id).querySelector("svg").outerHTML;  // the panel's own Home / Work / star icons
  const places = () => Object.assign({ home: null, work: null, favs: [] }, U.store.get("places", {}));
  const plain = d => ({ name: d.name, ctx: d.ctx || "", lat: d.lat, lon: d.lon });
  const same = (a, b) => !!a && !!b && Math.abs(a.lat - b.lat) < 1e-4 && Math.abs(a.lon - b.lon) < 1e-4;
  const isSaved = d => { const p = places(); return same(p.home, d) || same(p.work, d) || p.favs.some(f => same(f, d)); };
  let pf = null;  // the place being saved/edited: {place, kind: new|fav|home|work, i: index in favs}
  function openPlace(o) {
    $("ropts").classList.remove("open");
    pf = o;
    const named = o.kind === "new" || o.kind === "fav";
    $("pf-title").textContent = o.kind === "new" ? T("fav.title", { name: o.place.name }) : o.kind === "fav" ? T("fav.edit")
      : T("fav." + o.kind) + " · " + o.place.name;
    $("pf-in").hidden = !named; $("pf-save").hidden = !named;
    $("pf-name").value = named ? o.place.name : "";
    $("pf-kinds").hidden = o.kind !== "new";
    $("pf-del").hidden = o.kind === "new";
    $("pf-save-l").textContent = o.kind === "new" ? T("fav.saveFav") : T("fav.rename");
    $("placeform").classList.add("open");
    if (named) focusName(); else Keyboard.hide();
  }
  function focusName() { if (pf) Keyboard.show($("pf-name"), () => {}, () => savePlace("fav")); }
  function savePlace(kind) {
    if (!pf) return;
    const p = places(), name = $("pf-name").value.trim(), pl = plain(pf.place);
    if (kind === "fav" && !name) { U.toast(T("fav.noName")); return; }
    if (kind !== "fav") p[kind] = pl;
    else if (pf.kind === "fav") p.favs[pf.i] = Object.assign(p.favs[pf.i] || pl, { name });
    else p.favs = [Object.assign(pl, { name })].concat(p.favs.filter(f => !same(f, pl))).slice(0, 30);
    U.store.set("places", p);
    U.toast(T("toast.saved", { name: kind === "fav" ? name : T("fav." + kind) }));
    closePlace();
  }
  function deletePlace() {
    if (!pf) return;
    const p = places(), name = pf.kind === "fav" ? pf.place.name : T("fav." + pf.kind);
    if (pf.kind === "fav") p.favs.splice(pf.i, 1); else p[pf.kind] = null;
    U.store.set("places", p);
    U.toast(T("toast.deleted", { name }));
    closePlace();
  }
  function closePlace() {
    if (!pf) return;
    pf = null; Keyboard.hide(); $("pf-name").blur();
    $("placeform").classList.remove("open");
    markSaved();
    if ($("search-results").classList.contains("open") && !$("q").value) showRecents();
  }
  function markSaved() { $("s-save").classList.toggle("on", !!dest && isSaved(dest)); }
  // Home, Work, favourites at the top of the search panel, for a destination and for a start alike
  function showSaved(box) {
    const p = places();
    const t = document.createElement("div"); t.className = "section-title"; t.textContent = T("saved"); box.appendChild(t);
    const row = (icon, label, place, kind, i) => {
      const r = document.createElement("div"); r.className = "row saved"; r.setAttribute("role", "button"); r.dataset.kind = kind;
      r.innerHTML = icon + '<div class="main"><div class="n"></div><div class="c"></div></div>';
      r.querySelector(".n").textContent = label;
      r.querySelector(".c").textContent = !place ? T("fav.notSet") : kind === "fav" ? place.ctx : [place.name, place.ctx].filter(Boolean).join(", ");
      r.addEventListener("click", () => place ? choose(place) : U.toast(T("fav.notSet"), 3000));
      if (place) {
        const e = document.createElement("button"); e.className = "ico edit"; e.setAttribute("aria-label", T("fav.editBtn")); e.innerHTML = EDIT_SVG;
        e.addEventListener("click", ev => { ev.stopPropagation(); openPlace({ place, kind, i }); });
        r.appendChild(e);
      }
      box.appendChild(r);
    };
    parkRow(box);
    row(iconOf("pf-home"), T("fav.home"), p.home, "home");
    row(iconOf("pf-work"), T("fav.work"), p.work, "work");
    p.favs.forEach((f, i) => row(iconOf("pf-save"), f.name, f, "fav", i));
  }

  // ---------- PN-39 parked car: saved when a drive ends or by "Park here"; walk back to it (pedestrian route) ----------
  const parked = () => U.store.get("parked", null);   // {lat, lon, t}
  const parkedPlace = p => ({ name: T("park.car"), ctx: T("park.at", { t: U.fmtClock(new Date(p.t)) }), lat: p.lat, lon: p.lon, walk: true });
  function park(lat, lon, quiet) {
    U.store.set("parked", { lat, lon, t: Date.now() });
    parkMarker();
    if (!quiet) U.toast(T("toast.parked"));
  }
  function unpark() {
    U.store.set("parked", null);
    parkMarker();
    U.toast(T("toast.unparked"));
  }
  function walkBack() { const p = parked(); if (p) { closeSearch(false); preview(parkedPlace(p), null, []); } }
  function parkMarker() {
    if (parkMk) { parkMk.remove(); parkMk = null; }
    const p = parked();
    if (!p || !map) return;
    const el = document.createElement("button"); el.className = "parkpin"; el.setAttribute("aria-label", T("park.back"));
    el.innerHTML = '<svg class="i"><use href="#i-park"/></svg>';
    el.addEventListener("click", e => { e.stopPropagation(); if (state !== "nav") walkBack(); });
    parkMk = new maplibregl.Marker({ element: el }).setLngLat([p.lon, p.lat]).addTo(map);
  }
  // the parked car on top of Saved places: tap the row or "Navigate back" = walk there; the x forgets it
  function parkRow(box) {
    const p = parked();
    if (!p) return;
    const r = document.createElement("div"); r.className = "row saved park"; r.setAttribute("role", "button"); r.dataset.kind = "park";
    r.innerHTML = '<svg class="i"><use href="#i-park"/></svg><div class="main"><div class="n"></div><div class="c"></div></div>';
    r.querySelector(".n").textContent = T("park.car");
    const c = pos ? [pos.lng, pos.lat] : null;
    r.querySelector(".c").textContent = [parkedPlace(p).ctx, c ? U.fmtDist(U.dist(c, [p.lon, p.lat])) : ""].filter(Boolean).join(" · ");
    r.addEventListener("click", () => searchFor === "dest" ? walkBack() : choose(Object.assign(parkedPlace(p), { walk: false })));
    if (searchFor === "dest") {
      const g = document.createElement("button"); g.className = "btn ghost back";
      g.innerHTML = '<svg class="i"><use href="#i-walk"/></svg><span></span>'; g.querySelector("span").textContent = T("park.back");
      g.addEventListener("click", ev => { ev.stopPropagation(); walkBack(); });
      r.appendChild(g);
    }
    const x = document.createElement("button"); x.className = "ico clear"; x.setAttribute("aria-label", T("park.clear"));
    x.innerHTML = '<svg class="i"><use href="#i-close"/></svg>';
    x.addEventListener("click", ev => { ev.stopPropagation(); unpark(); showRecents(); });
    r.appendChild(x);
    box.appendChild(r);
  }

  // ---------- recents ----------
  function remember(d) {
    if (!d || d.here || d.walk || d.name === T("marked")) return;
    const list = U.store.get("recents", []).filter(r => !(r.name === d.name && Math.abs(r.lat - d.lat) < 1e-4));
    list.unshift({ name: d.name, ctx: d.ctx, lat: d.lat, lon: d.lon });
    U.store.set("recents", list.slice(0, 8));
  }
  // recent destinations, shown in the search panel before typing (Home was removed 2026-11-11)
  function showRecents() {
    const box = $("search-results"); box.innerHTML = "";
    if (searchFor === "start") {
      const opt = (icon, label, sub, fn) => {
        const b = document.createElement("button"); b.className = "row";
        b.innerHTML = `<svg class="i"><use href="#${icon}"/></svg><div class="main"><div class="n"></div><div class="c"></div></div>`;
        b.querySelector(".n").textContent = label; b.querySelector(".c").textContent = sub;
        b.addEventListener("click", fn); box.appendChild(b);
      };
      opt("i-locate", T("from.here"), gpsFix ? T("gps.fix") : pos ? T("from.last") : T("from.center"), () => { closeSearch(false); setStart(null); });
      opt("i-pin", T("from.map"), T("from.mapHint"), () => { closeSearch(); U.toast(T("from.mapHint"), 4000); });
    }
    showSaved(box);
    window.dispatchEvent(new CustomEvent("navpi:recents", { detail: { box, mode: searchFor } }));   // PN-41 round trip row
    const t = document.createElement("div"); t.className = "section-title"; t.textContent = T("recent"); box.appendChild(t);
    const list = U.store.get("recents", []);
    if (!list.length) {
      const e = document.createElement("div"); e.className = "empty"; e.textContent = T("recent.empty2"); box.appendChild(e);
    }
    for (const r of list) {
      const b = document.createElement("button"); b.className = "row";
      b.innerHTML = '<svg class="i"><use href="#i-history"/></svg><div class="main"><div class="n"></div><div class="c"></div></div>';
      b.querySelector(".n").textContent = r.name; b.querySelector(".c").textContent = r.ctx || "";
      b.addEventListener("click", () => choose(r));
      box.appendChild(b);
    }
    box.classList.add("open");
  }
  function markTheme() { document.querySelectorAll("[data-theme]").forEach(b => b.classList.toggle("on", b.dataset.theme === theme)); }
  Shell.view("maps", { show() { init().then(resize); } });
  return { init, resize, preview, ctx, insertStop, navigateTo, picked: () => picked && { lat: picked.lat, lon: picked.lng } };
})();
