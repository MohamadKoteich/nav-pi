/* imagery feature: "Satellite" map layer from offline MBTiles packs (navd /sat/<id>/{z}/{x}/{y}) + Settings card
   "Satellite areas" (installed packs, download an area over Wi-Fi, import from a USB stick).
   The photos are raster layers put under the first label layer, so street names and the route (added on top by maps.js)
   stay visible; each pack's source has its bounds + zooms, so outside a pack the normal map shows. Remembered on the
   device (U.store "satellite"); dimmed at night. Downloads/imports are refused while guiding or moving. */
"use strict";
(() => {
  const $ = id => document.getElementById(id);
  const ORIGIN = location.origin;
  let on = !!U.store.get("satellite", true), packs = [], info = null, map = null;
  let sel = null, level = U.store.get("satLevel", "standard"), plan = null, provId = null, planSeq = 0;
  let open = false, timer = null, lastJob = null, speed = 0, usbFiles = [], picking = false;
  const size = b => b == null ? "?" : b >= 1e9 ? (b / 1e9).toFixed(b >= 1e10 ? 0 : 1) + " GB" : b >= 1e6 ? Math.round(b / 1e6) + " MB" : Math.max(1, Math.round(b / 1e3)) + " kB";
  const plain = s => { const d = document.createElement("div"); d.innerHTML = s || ""; return d.textContent.trim(); };   // no links in a kiosk
  const el = (tag, cls, text) => { const e = document.createElement(tag); if (cls) e.className = cls; if (text != null) e.textContent = text; return e; };
  let speedAt = 0;   // a real GPS speed counts for 5 s (no fix = no news); guiding (also a simulated drive) always counts
  const driving = () => (typeof Maps !== "undefined" && Maps.ctx().state === "nav")   // Maps is a top-level const, not window.Maps || (speed > 3 && Date.now() - speedAt < 5000);
  const busy = () => info && info.job && (info.job.state === "running" || info.job.state === "paused");

  // ---------- map layer ----------
  function apply() {
    const m = window.__map; if (!m) return;
    let style; try { style = m.getStyle(); } catch (e) { return; }   // style switching (day/night): style.load calls again
    if (!style || !style.layers) return;
    const want = new Set(on ? packs.map(p => "sat-" + p.id) : []);
    for (const l of style.layers) if (l.id.startsWith("sat-") && !want.has(l.id)) m.removeLayer(l.id);
    for (const id of Object.keys(style.sources)) if (id.startsWith("sat-") && !want.has(id)) m.removeSource(id);
    const before = (style.layers.find(l => l.type === "symbol") || {}).id;
    const night = Theme.current() === "night";
    // coarse packs first, the most detailed on top
    [...packs].sort((a, b) => a.maxzoom - b.maxzoom).forEach(p => {
      if (!on) return;
      const id = "sat-" + p.id;
      if (!m.getSource(id)) m.addSource(id, { type: "raster", tileSize: 256, tiles: [ORIGIN + "/sat/" + p.id + "/{z}/{x}/{y}?v=" + p.mtime],
        bounds: p.bounds, minzoom: p.minzoom, maxzoom: p.maxzoom, attribution: plain(p.attribution) });
      if (!m.getLayer(id)) m.addLayer({ id, type: "raster", source: id, paint: { "raster-fade-duration": 0 } }, before);
      m.setPaintProperty(id, "raster-brightness-max", night ? 0.7 : 1);     // calm at night: no bright photo in the dark
      m.setPaintProperty(id, "raster-saturation", night ? -0.3 : 0);
    });
    coverage();
  }
  function covered() {
    const m = window.__map; if (!m || !packs.length) return false;
    const b = m.getBounds(), z = m.getZoom();
    return packs.some(p => z >= p.minzoom - 0.5 && p.bounds[0] < b.getEast() && p.bounds[2] > b.getWest() && p.bounds[1] < b.getNorth() && p.bounds[3] > b.getSouth());
  }
  function coverage() {
    const f = $("btn-sat"); if (!f) return;
    f.hidden = !packs.length;
    f.classList.toggle("on", on);
    f.classList.toggle("nocov", on && !covered());
    f.setAttribute("aria-pressed", on ? "true" : "false");
  }
  function mark() {
    coverage();
  }
  function set(v, quiet) {
    on = !!v; U.store.set("satellite", on); apply(); mark();
    window.dispatchEvent(new CustomEvent("navpi:satellite", { detail: { on } }));
    if (on && !quiet && !covered()) U.toast(T("sat.none"), 3000);
  }
  function hook() {   // the map is made when Maps is first shown; attach once it exists
    const m = window.__map;
    if (!m || m === map) return;
    map = m;
    m.on("style.load", apply);
    m.on("load", apply);
    m.on("moveend", coverage);
    apply();
  }
  setInterval(hook, 400);
  window.addEventListener("navpi:theme", () => setTimeout(apply, 50));
  window.addEventListener("navpi:navstop", () => { if (open) render(); });
  window.addEventListener("navpi:pos", e => { const d = e.detail; speed = d && d.src === "gps" ? d.speed || 0 : 0; speedAt = Date.now(); });

  const fab = el("button", "fab"); fab.id = "btn-sat"; fab.dataset.i18nLabel = "sat.toggle"; fab.hidden = true;
  fab.innerHTML = '<svg class="i"><use href="#i-sat"/></svg>';
  fab.addEventListener("click", () => set(!on));
  ($("fabs") || $("maps")).appendChild(fab);

  async function load() {
    try { info = await U.api("/api/imagery"); packs = info.packs || []; } catch (e) { /* navd restarting */ }
    apply(); mark();
    jobChanged();
    if (open) render();
  }

  // ---------- Settings: installed packs ----------
  function renderPacks() {
    const box = $("sat-packs"); box.textContent = "";
    $("sat-free").textContent = info && info.free != null ? T("sat.free", { free: size(info.free) }) : "";
    if (!packs.length) box.append(el("div", "hint", T("sat.empty")));
    packs.forEach(p => {
      const r = el("div", "row");
      r.innerHTML = '<svg class="i"><use href="#i-sat"/></svg><div class="main"><div class="n"></div><div class="c"></div></div><div class="acts"></div>';
      r.querySelector(".n").textContent = p.name;
      r.querySelector(".c").textContent = T("sat.packSub", { size: size(p.size), z: p.maxzoom }) + (p.attribution ? " · " + plain(p.attribution) : "");
      const acts = r.querySelector(".acts");
      const show = el("button", "btn ghost", T("sat.show"));
      show.addEventListener("click", () => {
        set(true, true); Shell.go("maps");
        setTimeout(() => { const m = window.__map; if (m) m.fitBounds([[p.bounds[0], p.bounds[1]], [p.bounds[2], p.bounds[3]]], { padding: 40, duration: 0, maxZoom: 14 }); }, 150);
      });
      const del = el("button", "btn danger", T("sat.del"));
      del.addEventListener("click", async () => {
        if (del.dataset.sure !== "1") { del.dataset.sure = "1"; del.textContent = T("sat.delSure"); setTimeout(() => { del.dataset.sure = ""; del.textContent = T("sat.del"); }, 3000); return; }
        try { await U.api("/api/imagery/delete", { id: p.id }); } catch (e) { U.toast(T("failed", { msg: e.message })); }
        load();
      });
      acts.append(show, del); box.append(r);
    });
    const ub = $("sat-unfinished"); ub.textContent = "";
    ((info && info.unfinished) || []).forEach(u => {
      const r = el("div", "row");
      r.innerHTML = '<svg class="i"><use href="#i-dl"/></svg><div class="main"><div class="n"></div><div class="c"></div></div><div class="acts"></div>';
      r.querySelector(".n").textContent = u.name || u.id;
      r.querySelector(".c").textContent = T("sat.unfinished", { done: u.done, total: u.total });
      const res = el("button", "btn primary", T("sat.resume")), dis = el("button", "btn ghost", T("sat.discard"));
      res.disabled = busy() || driving();
      res.addEventListener("click", () => start({ resume: u.id }));
      dis.addEventListener("click", async () => { await U.api("/api/imagery/cancel", { drop: u.id }).catch(() => {}); load(); });
      r.querySelector(".acts").append(res, dis); ub.append(r);
    });
  }

  // ---------- Settings: download an area ----------
  function viewBounds() {
    const m = window.__map; if (!m) return null;
    const b = m.getBounds();
    return [b.getWest(), b.getSouth(), b.getEast(), b.getNorth()].map(v => +v.toFixed(5));
  }
  function frameBounds() {
    const m = window.__map, f = $("sat-frame"); if (!m || !f) return null;
    const mr = m.getContainer().getBoundingClientRect(), r = f.getBoundingClientRect();
    const a = m.unproject([r.left - mr.left, r.bottom - mr.top]), b = m.unproject([r.right - mr.left, r.top - mr.top]);
    return [a.lng, a.lat, b.lng, b.lat].map(v => +v.toFixed(5));
  }
  function areaText(b) {
    if (!b) return T("sat.noArea");
    const cy = (b[1] + b[3]) / 2, cx = (b[0] + b[2]) / 2;
    const w = U.dist([b[0], cy], [b[2], cy]) / 1000, h = U.dist([cx, b[1]], [cx, b[3]]) / 1000;
    const f = v => v >= 10 ? Math.round(v) : v.toFixed(1);
    return T("sat.area", { w: f(w), h: f(h), lat: cy.toFixed(3), lon: cx.toFixed(3) });
  }
  function choose(b) {
    if (b) { b[0] = Math.max(-180, b[0]); b[2] = Math.min(180, b[2]); b[1] = Math.max(-85, b[1]); b[3] = Math.min(85, b[3]); }
    sel = b; provId = null; plan = null; getPlan();
  }
  async function getPlan() {
    renderDl();
    if (!sel) return;
    const seq = ++planSeq;
    try { const r = await U.api("/api/imagery/plan", { bounds: sel, level }); if (seq !== planSeq) return; plan = r; }
    catch (e) { if (seq === planSeq) { plan = { options: [], error: e.message }; } }
    renderDl();
  }
  const opt = () => plan && plan.options && (plan.options.find(o => o.id === provId) || plan.options[0]);
  function estText(o) {
    if (!o) return plan && plan.error ? T("failed", { msg: plan.error }) : "";
    if (o.too_big) return T("sat.tooBig");
    if (o.fits === false) return T("sat.noSpace", { need: size(o.need_bytes), free: size(plan.free) });
    return T("sat.est", { size: size(o.estimated_bytes), n: o.tiles.toLocaleString(LANGS[LANG].locale), free: size(plan.free) });
  }
  function renderDl() {
    $("sat-area").textContent = areaText(sel);
    document.querySelectorAll("#sat-level [data-level]").forEach(b => { b.classList.toggle("on", b.dataset.level === level); b.setAttribute("aria-checked", b.dataset.level === level ? "true" : "false"); });
    const box = $("sat-provs"); box.textContent = "";
    const o = opt();
    ((plan && plan.options) || []).forEach((p, i) => {
      const r = el("button", "row sat-prov" + (o && p.id === o.id ? " on" : "")); r.setAttribute("role", "radio");
      r.setAttribute("aria-checked", o && p.id === o.id ? "true" : "false");
      r.innerHTML = '<span class="dot"></span><div class="main"><div class="n"></div><div class="c"></div></div>';
      r.querySelector(".n").textContent = p.name + (i === 0 ? " · " + T("sat.rec") : "");
      r.querySelector(".c").textContent = T("sat.res", { r: p.resolution, s: p.stored_resolution }) + " · " + p.license + (p.nc ? " " + T("sat.nc") : "");
      r.addEventListener("click", () => { provId = p.id; renderDl(); });
      box.append(r);
    });
    const est = $("sat-est");
    est.textContent = driving() ? T("sat.driving") : busy() ? T("sat.busy") : estText(o);
    est.classList.toggle("warn", driving() || !!(o && (o.too_big || o.fits === false)));
    $("sat-start").disabled = !sel || !o || o.too_big || o.fits === false || driving() || busy();
  }
  async function start(body) {
    if (driving()) { U.toast(T("sat.driving"), 3500); return; }
    try { await U.api("/api/imagery/download", body); }
    catch (e) { U.toast(e.message === "driving" ? T("sat.driving") : e.message === "busy" ? T("sat.busy") : T("failed", { msg: e.message }), 4000); }
    lastJob = "running"; load(); poll();
  }

  // ---------- job progress (download or USB import) ----------
  function renderJob() {
    const j = info && info.job, box = $("sat-job");
    box.hidden = !busy();
    if (box.hidden) return;
    const paused = j.state === "paused";
    $("sat-job-t").textContent = T(paused ? "sat.pausedT" : j.kind === "import" ? "sat.imp" : "sat.dl", { name: j.name || j.id });
    const f = j.total ? Math.min(1, j.done / j.total) : 0;
    $("sat-bar").style.width = (f * 100).toFixed(1) + "%";
    $("sat-job-s").textContent = j.kind === "import" ? T("sat.progB", { done: size(j.done), total: size(j.total) })
      : T("sat.prog", { done: (j.done || 0).toLocaleString(LANGS[LANG].locale), total: (j.total || 0).toLocaleString(LANGS[LANG].locale), size: size(j.bytes) });
    $("sat-pause").textContent = T(paused ? "sat.resumeB" : "sat.pause");
  }
  function jobChanged() {
    const j = info && info.job; if (!j) return;
    if (lastJob && lastJob !== j.state) {
      if (j.state === "done") U.toast(T("sat.done", { name: j.name || j.id }), 4000);
      if (j.state === "failed") U.toast(T("sat.failed", { msg: j.error === "offline" ? T("sat.offline") : j.error === "disk" ? T("sat.disk") : j.error }), 6000);
      if (j.state === "cancelled") U.toast(T("sat.cancelled"));
    }
    lastJob = j.state;
    if (busy()) poll();
  }
  function poll() {
    clearTimeout(timer);
    if (!busy() && !open && lastJob !== "running") return;
    timer = setTimeout(load, busy() ? 1000 : 4000);
  }
  async function usb() {
    try { usbFiles = (await U.api("/api/imagery/usb")).files || []; } catch (e) { usbFiles = []; }
    const box = $("sat-usb-list"); box.textContent = "";
    $("sat-usb").hidden = !usbFiles.length;
    usbFiles.forEach(f => {
      const r = el("div", "row");
      r.innerHTML = '<svg class="i"><use href="#i-usb"/></svg><div class="main"><div class="n"></div><div class="c"></div></div><div class="acts"></div>';
      r.querySelector(".n").textContent = f.name;
      r.querySelector(".c").textContent = T("sat.usbSub", { size: size(f.size), stick: f.stick || "USB" });
      const b = el("button", "btn primary", T("sat.import")); b.disabled = busy() || driving();
      b.addEventListener("click", async () => {
        if (driving()) { U.toast(T("sat.driving"), 3500); return; }
        try { await U.api("/api/imagery/import", { path: f.path }); lastJob = "running"; }
        catch (e) { U.toast(e.message === "busy" ? T("sat.busy") : e.message === "space" ? T("sat.noSpace", { need: size(f.size), free: size(info && info.free) }) : T("failed", { msg: e.message }), 4000); }
        load();
      });
      r.querySelector(".acts").append(b); box.append(r);
    });
  }
  function render() { renderPacks(); renderDl(); renderJob(); }

  // ---------- choose the area on the map: a fixed frame, the map moves under it ----------
  function pickUi() {
    if ($("sat-frame")) return;
    const f = el("div"); f.id = "sat-frame"; f.setAttribute("aria-hidden", "true");
    const bar = el("div", "navpanel"); bar.id = "sat-pickbar"; bar.setAttribute("role", "dialog");
    bar.innerHTML = `<div class="sp-t"><div class="ttl" id="sp-hint"></div><div class="sp-est num" id="sp-est"></div></div>
      <div class="actions"><button class="btn ghost" id="sp-cancel"></button><button class="btn primary" id="sp-use"><svg class="i"><use href="#i-frame"/></svg><span></span></button></div>`;
    $("maps").append(f, bar);
    $("sp-cancel").addEventListener("click", () => endPick(false));
    $("sp-use").addEventListener("click", () => endPick(true));
  }
  function pickLabels() {
    if (!$("sp-hint")) return;
    $("sp-hint").textContent = T("sat.pickHint"); $("sp-cancel").textContent = T("sat.pickCancel");
    $("sp-use").querySelector("span").textContent = T("sat.useArea");
  }
  function pickEst() { if (picking) $("sp-est").textContent = areaText(frameBounds()); }
  function startPick() {
    pickUi(); pickLabels(); picking = true;
    Shell.go("maps");
    $("maps").classList.add("sat-picking"); $("sat-pickbar").classList.add("open");
    if (window.__map) { window.__map.on("move", pickEst); setTimeout(pickEst, 300); }
  }
  function endPick(use) {
    const b = use ? frameBounds() : null;
    picking = false;
    $("maps").classList.remove("sat-picking"); $("sat-pickbar").classList.remove("open");
    if (window.__map) window.__map.off("move", pickEst);
    Settings.open("sat");
    if (b) choose(b);
    setTimeout(() => $("sat-dl").scrollIntoView({ block: "start" }), 100);
  }

  $("sat-view").addEventListener("click", () => choose(viewBounds()));
  $("sat-pick").addEventListener("click", () => { if (driving()) { U.toast(T("sat.driving"), 3500); return; } startPick(); });
  document.querySelectorAll("#sat-level [data-level]").forEach(b => b.addEventListener("click", () => { level = b.dataset.level; U.store.set("satLevel", level); getPlan(); }));
  $("sat-start").addEventListener("click", () => { const o = opt(); if (sel && o) start({ bounds: sel, level, provider: o.id }); });
  $("sat-pause").addEventListener("click", async () => { const p = info.job.state === "paused"; await U.api("/api/imagery/" + (p ? "resume" : "pause"), {}).catch(e => U.toast(e.message === "driving" ? T("sat.driving") : e.message)); load(); });
  $("sat-cancel").addEventListener("click", async () => { await U.api("/api/imagery/cancel", {}).catch(() => {}); load(); });

  Settings.section({
    cat: "sat",
    open() { open = true; if (!sel) sel = viewBounds(); if (sel && !plan) getPlan(); load(); usb(); },
    close() { open = false; },
    relang() { render(); usb(); pickLabels(); },
  });
  setInterval(() => { if (open) usb(); }, 6000);
  Shell.onLang(() => { mark(); pickLabels(); });
  window.Imagery = { set, isOn: () => on, packs: () => packs, reload: load, frameBounds, choose };
  mark(); load();
})();
