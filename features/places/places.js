/* nav-pi places: the "Places" rail page (a Home/Work page like a car navigator's): two big Home and Work
   tiles, favourites (rename, move, delete with confirm), the parked car (PN-39) and recent destinations. One tap = a
   route PREVIEW through Maps.preview (never starts guidance; while driving it asks before replacing the route).
   Data = the same device store the Maps search panel uses (maps.js PN-34/39): U.store "places" {home, work, favs[]},
   "parked" {lat, lon, t}, "recents" [..]. Nothing here keeps its own copy, so both views always agree.
   Distances on the page are straight-line from the current position (no routing on page open). */
"use strict";
const Places = (() => {
  const $ = id => document.getElementById(id);
  const get = () => Object.assign({ home: null, work: null, favs: [] }, U.store.get("places", {}));
  const put = p => U.store.set("places", p);
  const plain = d => ({ name: d.name, ctx: d.ctx || "", lat: d.lat, lon: d.lon });
  const same = (a, b) => !!a && !!b && Math.abs(a.lat - b.lat) < 1e-4 && Math.abs(a.lon - b.lon) < 1e-4;
  const KIND = { home: ["i-home-f", "fav.home", "pl.pickHome"], work: ["i-work", "fav.work", "pl.pickWork"] };
  const ico = id => `<svg class="i" aria-hidden="true"><use href="#${id}"/></svg>`;
  const ctxNow = () => (typeof Maps !== "undefined" && Maps.ctx ? Maps.ctx() : { state: "browse" });
  const here = () => ctxNow().pos || null;   // {lng, lat} — GPS, simulation or the tunnel estimate
  const away = p => { const h = here(); return h && p ? T("pl.away", { d: U.fmtDist(U.dist([h.lng, h.lat], [p.lon, p.lat])) }) : ""; };
  const addr = p => [p.name, p.ctx].filter(Boolean).join(", ");
  // Home / Work tiles: real drive time from the local route planner, one request per tile when the
  // page opens; reused while the car stays within 500 m and 5 min of where it was asked. Straight-line km until then.
  const drive = {};   // kind -> {lat, lon, from: [lng, lat], at, text}
  function driveTime(kind, p, el) {
    const h = here(); if (!h || !p || ctxNow().state === "nav") return;   // never while guiding: the planner serves the drive
    const c = drive[kind];
    if (c && same(c, p) && U.dist(c.from, [h.lng, h.lat]) < 500 && Date.now() - c.at < 300000) { if (c.text) el.textContent = c.text; return; }
    const ask = drive[kind] = { lat: p.lat, lon: p.lon, from: [h.lng, h.lat], at: Date.now(), text: "" };
    U.api("/api/route", { locations: [{ lat: h.lat, lon: h.lng }, { lat: p.lat, lon: p.lon }], costing: "auto",
      directions_options: { units: "kilometers" } }).then(r => {
      const t = r && r.trip && r.trip.summary; if (!t || drive[kind] !== ask) return;
      ask.text = U.fmtDur(t.time) + " · " + U.fmtDist(t.length * 1000);
      if (el.isConnected) el.textContent = ask.text;
    }).catch(() => { /* no route (e.g. off the road network): the straight-line distance stays */ });
  }
  let shown = false;

  // ---------- a tap: route preview (or, while driving, ask before replacing the route) ----------
  async function go(place, label) {
    const d = Object.assign(plain(place), place.walk ? { walk: true } : {});
    if (ctxNow().state === "nav") {
      if (await confirm(T("pl.drive", { name: label || place.name }), T("pl.driveP"), T("pl.driveYes"), false)) Maps.navigateTo(plain(place));
      return;
    }
    Maps.preview(d, null, []);   // from here (null start), a new trip without stops — like a tap in Saved places
  }

  // long-press = edit (the visible edit button does the same; nothing depends on the gesture alone)
  function longPress(el, fn) {
    let t = null, at = null, fired = false;
    el.addEventListener("pointerdown", e => { fired = false; at = [e.clientX, e.clientY]; clearTimeout(t); t = setTimeout(() => { fired = true; fn(); }, 650); });
    const stop = () => clearTimeout(t);
    el.addEventListener("pointerup", stop); el.addEventListener("pointercancel", stop); el.addEventListener("pointerleave", stop);
    el.addEventListener("pointermove", e => { if (at && Math.hypot(e.clientX - at[0], e.clientY - at[1]) > 12) stop(); });
    el.addEventListener("click", e => { if (fired) { e.stopImmediatePropagation(); e.preventDefault(); fired = false; } }, true);
  }
  function editBtn(label, fn) {
    const e = document.createElement("button"); e.className = "ico pl-edit"; e.setAttribute("aria-label", label); e.innerHTML = ico("i-edit");
    e.addEventListener("click", ev => { ev.stopPropagation(); fn(); });
    return e;
  }

  // ---------- render ----------
  function tile(kind) {
    const p = get()[kind], [icon, name] = KIND[kind];
    const w = document.createElement("div"); w.className = "pl-tile" + (p ? "" : " unset"); w.dataset.kind = kind;
    const b = document.createElement("button"); b.className = "pl-tmain";
    b.innerHTML = `<span class="pl-ti">${ico(p ? icon : "i-plus")}</span><span class="pl-tt"><span class="n"></span><span class="c"></span><span class="d num"></span></span>`;
    b.querySelector(".n").textContent = p ? T(name) : T("pl.set", { name: T(name) });
    b.querySelector(".c").textContent = p ? addr(p) : T("pl.setHint");
    b.querySelector(".d").textContent = p ? away(p) : "";
    if (p) driveTime(kind, p, b.querySelector(".d"));
    b.addEventListener("click", () => p ? go(p, T(name)) : openPick(kind));
    w.appendChild(b);
    if (p) {
      longPress(b, () => openEdit({ kind, place: p }));
      w.appendChild(editBtn(T("pl.edit", { name: T(name) }), () => openEdit({ kind, place: p })));
    }
    return w;
  }
  function row(icon, n, c, d, onTap, onEdit, editLabel, extra) {
    const w = document.createElement("div"); w.className = "pl-row";
    const b = document.createElement("button"); b.className = "row pl-rmain";
    b.innerHTML = `${ico(icon)}<span class="main"><span class="n"></span><span class="c"></span></span><span class="c num pl-d"></span>`;
    b.querySelector(".n").textContent = n; b.querySelector(".main .c").textContent = c; b.querySelector(".pl-d").textContent = d;
    b.addEventListener("click", onTap);
    w.appendChild(b);
    if (extra) w.appendChild(extra);
    if (onEdit) { longPress(b, onEdit); w.appendChild(editBtn(editLabel, onEdit)); }
    return w;
  }
  const empty = text => { const e = document.createElement("div"); e.className = "pl-empty"; e.textContent = text; return e; };
  function render() {
    if (!$("pl-tiles")) return;
    const p = get();
    $("pl-tiles").replaceChildren(tile("home"), tile("work"));
    const favs = $("pl-favs"); favs.replaceChildren();
    p.favs.forEach((f, i) => {
      const r = row("i-star", f.name, f.ctx || "", away(f), () => go(f), () => openEdit({ kind: "fav", i, place: f }), T("fav.editBtn"));
      r.dataset.i = i; favs.appendChild(r);
    });
    if (!p.favs.length) favs.appendChild(empty(T("pl.favsEmpty")));
    const pk = U.store.get("parked", null), park = $("pl-park");
    $("pl-park-card").hidden = !pk; park.replaceChildren();
    if (pk) {
      const car = { name: T("park.car"), ctx: T("park.at", { t: U.fmtClock(new Date(pk.t)) }), lat: pk.lat, lon: pk.lon, walk: true };
      const r = row("i-walk", T("pl.walkBack"), car.ctx, away(car), () => go(car)); r.classList.add("park"); park.appendChild(r);
    }
    const rec = $("pl-recent"); rec.replaceChildren();
    const list = U.store.get("recents", []);
    list.forEach(r => {
      const saved = same(p.home, r) || same(p.work, r) || p.favs.some(f => same(f, r));
      rec.appendChild(row("i-history", r.name, r.ctx || "", away(r), () => go(r),
        saved ? null : () => openEdit({ kind: "new", place: r }), T("pl.addFav")));
    });
    rec.querySelectorAll(".pl-edit").forEach(e => { e.innerHTML = ico("i-star"); });   // on a recent the button saves it
    if (!list.length) rec.appendChild(empty(T("pl.recentEmpty")));
  }

  // ---------- pick a place (Home, Work, a new favourite): search, my position, the map centre, a recent ----------
  let pickFor = null, qt = null;
  function openPick(kind) {
    closeEdit();
    pickFor = kind;
    $("pl-pick-t").textContent = T(kind === "fav" ? "pl.pickFav" : KIND[kind][2]);
    $("pl-q").value = ""; $("pl-q-clear").hidden = true;
    $("pl-pick").classList.add("open");
    pickStart();
    focusQ();
  }
  function closePick() {
    if (!pickFor) return;
    pickFor = null; clearTimeout(qt); Keyboard.hide(); $("pl-q").blur();
    $("pl-pick").classList.remove("open");
  }
  function focusQ() { if (pickFor) Keyboard.show($("pl-q"), onQ, () => Keyboard.hide()); }
  function onQ() {
    const q = $("pl-q").value; $("pl-q-clear").hidden = !q;
    clearTimeout(qt);
    qt = setTimeout(() => search(q), 200);
  }
  function origin() {
    const h = here(); if (h) return [h.lng, h.lat];
    const m = window.__map; if (m) { const c = m.getCenter(); return [c.lng, c.lat]; }
    return [11.575, 48.137];
  }
  function pickRow(icon, n, c, d, fn, disabled) {
    const b = document.createElement("button"); b.className = "row";
    b.innerHTML = `${ico(icon)}<span class="main"><span class="n"></span><span class="c"></span></span><span class="c num pl-d"></span>`;
    b.querySelector(".n").textContent = n; b.querySelector(".main .c").textContent = c; b.querySelector(".pl-d").textContent = d || "";
    if (disabled) b.disabled = true; else b.addEventListener("click", fn);
    return b;
  }
  const title = t => { const e = document.createElement("div"); e.className = "section-title"; e.textContent = t; return e; };
  const pt = (lng, lat) => ({ name: T("marked"), ctx: T("pl.atPoint", { lat: lat.toFixed(5), lon: lng.toFixed(5) }), lat, lon: lng });
  function pickStart() {
    const box = $("pl-results"); box.replaceChildren();
    const h = here(), m = window.__map;
    box.appendChild(pickRow("i-locate", T("pl.here"), h ? T("pl.atPoint", { lat: h.lat.toFixed(5), lon: h.lng.toFixed(5) }) : T("pl.hereNone"), "",
      () => picked(pt(h.lng, h.lat)), !h));
    if (m) box.appendChild(pickRow("i-map", T("pl.center"), T("pl.centerHint"), "", () => { const c = m.getCenter(); picked(pt(c.lng, c.lat)); }));
    const list = U.store.get("recents", []);
    if (list.length) {
      box.appendChild(title(T("pl.recent")));
      for (const r of list) box.appendChild(pickRow("i-history", r.name, r.ctx || "", away(r), () => picked(r)));
    }
  }
  async function search(q) {
    if (!pickFor) return;
    if (!q.trim()) { pickStart(); return; }
    const box = $("pl-results"), c = origin();
    let res = [];
    try { res = await U.api(`/api/search?q=${encodeURIComponent(q)}&lat=${c[1]}&lon=${c[0]}`); } catch (e) { /* offline index missing */ }
    if (!pickFor || $("pl-q").value !== q) return;   // a newer query is on its way
    box.replaceChildren();
    if (!res.length) box.appendChild(empty(T("pl.noResult")));
    for (const r of res) {
      const place = { name: r.name, ctx: r.context || "", lat: r.lat, lon: r.lon };
      box.appendChild(pickRow("i-pin", r.name, r.context || "", U.fmtDist(U.dist(c, [r.lon, r.lat])), () => picked(place)));
    }
  }
  function picked(place) {
    const kind = pickFor;
    closePick();
    if (kind === "fav") { openEdit({ kind: "new", place }); return; }
    const p = get(); p[kind] = plain(place); put(p);
    U.toast(T("toast.saved", { name: T(KIND[kind][1]) }));
    render();
  }

  // ---------- edit: rename / move / delete a favourite, change / delete Home or Work, name a new favourite ----------
  let ed = null;   // {kind: home|work|fav|new, i, place}
  function openEdit(o) {
    closePick();
    ed = o;
    const named = o.kind === "fav" || o.kind === "new", hw = o.kind === "home" || o.kind === "work";
    $("pl-edit-t").textContent = hw ? T("pl.edit", { name: T(KIND[o.kind][1]) }) : o.kind === "fav" ? T("fav.edit") : T("fav.title", { name: o.place.name });
    $("pl-edit-sub").textContent = named ? o.place.ctx || "" : addr(o.place);
    $("pl-edit-in").hidden = !named;
    $("pl-name").value = named ? o.place.name : "";
    $("pl-up").hidden = $("pl-down").hidden = o.kind !== "fav";
    if (o.kind === "fav") { const n = get().favs.length; $("pl-up").disabled = o.i === 0; $("pl-down").disabled = o.i >= n - 1; }
    $("pl-change").hidden = !hw;
    $("pl-del").hidden = o.kind === "new";
    $("pl-save").hidden = !named;
    $("pl-save-l").textContent = o.kind === "new" ? T("pl.saveFav") : T("fav.rename");
    $("pl-edit").classList.add("open");
    if (named) focusName(); else Keyboard.hide();
  }
  function closeEdit() {
    if (!ed) return;
    ed = null; Keyboard.hide(); $("pl-name").blur();
    $("pl-edit").classList.remove("open");
  }
  function focusName() { if (ed) Keyboard.show($("pl-name"), () => {}, save, T("pl.saveKey")); }
  function save() {
    if (!ed) return;
    const name = $("pl-name").value.trim();
    if (!name) { U.toast(T("fav.noName")); return; }
    const p = get();
    if (ed.kind === "fav") { if (p.favs[ed.i]) p.favs[ed.i].name = name; }
    else { const pl = plain(ed.place); p.favs = [Object.assign(pl, { name })].concat(p.favs.filter(f => !same(f, pl))).slice(0, 30); }   // as maps.js: newest first, max 30
    put(p); U.toast(T("toast.saved", { name }));
    closeEdit(); render();
  }
  function move(d) {
    if (!ed || ed.kind !== "fav") return;
    const p = get(), i = ed.i, j = i + d;
    if (j < 0 || j >= p.favs.length) return;
    [p.favs[i], p.favs[j]] = [p.favs[j], p.favs[i]]; put(p);
    ed.i = j; $("pl-up").disabled = j === 0; $("pl-down").disabled = j >= p.favs.length - 1;
    render();
  }
  async function del() {
    if (!ed) return;
    const o = ed, hw = o.kind !== "fav", name = hw ? T(KIND[o.kind][1]) : o.place.name;
    Keyboard.hide();
    if (!await confirm(T("pl.delAsk", { name }), T(hw ? "pl.delHome" : "pl.delFav"), T("fav.delete"), true)) { if (ed && ed.kind === "fav") focusName(); return; }
    const p = get();
    if (hw) p[o.kind] = null;
    else { const k = p.favs.findIndex((f, i) => i === o.i && same(f, o.place)); if (k >= 0) p.favs.splice(k, 1); }
    put(p); U.toast(T("toast.deleted", { name }));
    closeEdit(); render();
  }

  // ---------- confirm dialog (one at a time) -> Promise<boolean> ----------
  let cfDone = null;
  function confirm(t, text, yes, danger) {
    if (cfDone) cfDone(false);
    $("pl-cf-t").textContent = t; $("pl-cf-p").textContent = text;
    $("pl-cf-no").textContent = T("cancel"); $("pl-cf-yes").textContent = yes;
    $("pl-cf-yes").className = "btn " + (danger ? "danger-solid" : "primary");
    $("pl-confirm").hidden = false;
    return new Promise(res => { cfDone = v => { cfDone = null; $("pl-confirm").hidden = true; res(v); }; });
  }

  function closeAll() { closePick(); closeEdit(); if (cfDone) cfDone(false); }
  function bind() {
    $("pl-add").addEventListener("click", () => openPick("fav"));
    $("pl-pick-x").addEventListener("click", closePick);
    $("pl-q").addEventListener("focus", focusQ);
    $("pl-q").addEventListener("input", onQ);   // a USB keyboard types natively
    $("pl-q-clear").addEventListener("click", () => { $("pl-q").value = ""; onQ(); focusQ(); });
    $("pl-name").addEventListener("focus", focusName);
    $("pl-name-clear").addEventListener("click", () => { $("pl-name").value = ""; focusName(); });
    $("pl-edit-x").addEventListener("click", closeEdit);
    $("pl-save").addEventListener("click", save);
    $("pl-del").addEventListener("click", del);
    $("pl-change").addEventListener("click", () => { const k = ed && ed.kind; closeEdit(); if (k) openPick(k); });
    $("pl-up").addEventListener("click", () => move(-1));
    $("pl-down").addEventListener("click", () => move(1));
    $("pl-cf-no").addEventListener("click", () => cfDone && cfDone(false));
    $("pl-cf-yes").addEventListener("click", () => cfDone && cfDone(true));
    $("pl-confirm").addEventListener("click", e => { if (e.target.id === "pl-confirm" && cfDone) cfDone(false); });
    document.addEventListener("keydown", e => { if (e.key === "Escape" && shown) closeAll(); });
  }
  if (document.readyState === "loading") document.addEventListener("DOMContentLoaded", bind); else bind();

  // distances follow the car while the page is open (redrawn at most every 10 s, only while shown)
  let lastDraw = 0;
  window.addEventListener("navpi:pos", () => { if (shown && !ed && !pickFor && Date.now() - lastDraw > 10000) { lastDraw = Date.now(); render(); } });
  Shell.view("places", { show() { shown = true; lastDraw = Date.now(); render(); $("pl-body").scrollTop = 0; }, hide() { shown = false; closeAll(); } });
  Shell.onLang(() => { if (shown) render(); });
  return { render, openPick };
})();
