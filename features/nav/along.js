/* PN-38 places along the route: fuel, parking, toilets, rest areas, nearest ahead first.
   Offline: navd /api/along reads the map's POIs (along.sqlite index, or the z15 tiles without it), km ahead
   along the route and the extra driving (detour) from the local Valhalla. Tap a row = add it as a stop where
   it lies on the route (PN-37 stops); the arrow button = drive there instead. No prices, no opening hours.
   Opens from the route sheet ("Along the route") and, while driving, from the round button on the map. */
"use strict";
const Along = (() => {
  const $ = id => document.getElementById(id);
  const CATS = ["fuel", "parking", "toilets", "rest"];
  const ICON = { fuel: "i-fuel", parking: "i-park", toilets: "i-wc", rest: "i-cafe", rest_area: "i-cafe", services: "i-cafe" };
  let cat = U.store.get("alongCat", "fuel"), items = [], at0 = 0, seq = 0, timer = null, busy = false, note = "";

  // ---------- DOM (built once; strings follow the language through data-i18n) ----------
  const sprite = `<svg width="0" height="0" style="position:absolute" aria-hidden="true">
    <symbol id="i-fuel" viewBox="0 0 24 24"><path d="m19.8 7.2-3.7-3.7L15 4.6l2.1 2.1A2.5 2.5 0 0 0 18 11.5c.4 0 .7-.1 1-.2v7.2a1 1 0 0 1-2 0V14a2 2 0 0 0-2-2h-1V5a2 2 0 0 0-2-2H6a2 2 0 0 0-2 2v16h10v-7.5h1.5v5a2.5 2.5 0 0 0 5 0V9c0-.7-.3-1.3-.7-1.8zM12 10H6V5h6zm6 0a1 1 0 1 1 0-2 1 1 0 0 1 0 2z"/></symbol>
    <symbol id="i-wc" viewBox="0 0 24 24"><path d="M5.5 22v-7.5H4V9a2 2 0 0 1 2-2h3a2 2 0 0 1 2 2v5.5H9.5V22zM18 22v-6h3l-2.5-7.6A2 2 0 0 0 16.6 7h-.2a2 2 0 0 0-1.9 1.4L12 16h3v6zM7.5 6a2 2 0 1 0 0-4 2 2 0 0 0 0 4zm9 0a2 2 0 1 0 0-4 2 2 0 0 0 0 4z"/></symbol>
    <symbol id="i-cafe" viewBox="0 0 24 24"><path d="M20 3H4v10a4 4 0 0 0 4 4h6a4 4 0 0 0 4-4v-3h2a2 2 0 0 0 2-2V5a2 2 0 0 0-2-2zm0 5h-2V5h2zM4 19h16v2H4z"/></symbol>
  </svg>`;
  function build() {
    const sheet = $("sheet"), facts = sheet.querySelector(".facts");
    let tools = $("s-tools");
    if (!tools) {   // a row of labelled tools in the route sheet (shared with roundtrip.js and qr.js)
      tools = document.createElement("div"); tools.className = "tools"; tools.id = "s-tools";
      facts.after(tools);
    }
    const b = document.createElement("button"); b.className = "btn ghost tool"; b.id = "s-along";
    b.innerHTML = '<svg class="i"><use href="#i-fuel"/></svg><span data-i18n="along.btn"></span>';
    b.addEventListener("click", open);
    tools.prepend(b);
    const fab = document.createElement("button"); fab.className = "fab"; fab.id = "btn-along"; fab.dataset.i18nLabel = "along.title";
    fab.innerHTML = '<svg class="i"><use href="#i-fuel"/></svg>';
    fab.addEventListener("click", open);
    $("btn-recenter").after(fab);
    const p = document.createElement("div"); p.id = "along"; p.className = "navpanel"; p.setAttribute("role", "dialog");
    p.innerHTML = `<div class="al-head"><div class="ttl" data-i18n="along.title"></div>
        <button class="ico" id="al-close" data-i18n-label="along.close"><svg class="i"><use href="#i-close"/></svg></button></div>
      <div class="al-cats" role="radiogroup">${CATS.map(c => `<button class="al-cat" data-cat="${c}" role="radio">
        <svg class="i"><use href="#${ICON[c]}"/></svg><span data-i18n="along.${c}"></span></button>`).join("")}</div>
      <div class="al-note" id="al-note" aria-live="polite"></div>
      <div class="al-list" id="al-list"></div>`;
    $("maps").appendChild(p);
    p.querySelector("#al-close").addEventListener("click", close);
    p.querySelectorAll(".al-cat").forEach(c => c.addEventListener("click", () => { cat = c.dataset.cat; U.store.set("alongCat", cat); load(); }));
    document.body.insertAdjacentHTML("beforeend", sprite);
    applyI18n(tools); applyI18n(p); applyI18n(fab.parentNode);
  }

  // ---------- data ----------
  async function load() {
    const c = Maps.ctx();
    document.querySelectorAll("#along .al-cat").forEach(b => b.setAttribute("aria-checked", b.dataset.cat === cat));
    if (!c.legs) { close(); return; }
    const my = ++seq;
    busy = true; note = T("along.searching"); items = []; render();
    let r;
    try { r = await U.api("/api/along", { legs: c.legs, from_m: c.done, cat }); }
    catch (e) { if (my === seq) { busy = false; note = T("along.fail", { msg: e.message }); render(); } return; }
    if (my !== seq) return;
    busy = false; at0 = c.done; items = r.items || [];
    note = !items.length ? T("along.none") : r.source === "tiles" ? T("along.near", { km: r.window_km }) : "";
    render();
  }
  const kindName = k => { const t = T("kind." + k); return t === "kind." + k ? T("along." + cat) : t; };
  function render() {
    const box = $("al-list"); box.innerHTML = "";
    $("al-note").textContent = note; $("al-note").classList.toggle("busy", busy);
    const c = Maps.ctx(), moved = c.legs ? c.done - at0 : 0;
    for (const it of items) {
      const ahead = it.ahead_m - moved;
      if (ahead < -150) continue;   // driven past
      const r = document.createElement("div"); r.className = "row al-row"; r.setAttribute("role", "button");
      r.innerHTML = `<svg class="i"><use href="#${ICON[it.kind] || ICON[cat]}"/></svg><div class="main"><div class="n"></div><div class="c num"></div></div>
        <button class="ico add"><svg class="i"><use href="#i-addstop"/></svg></button><button class="ico go"><svg class="i"><use href="#i-nav"/></svg></button>`;
      const name = it.name || kindName(it.kind);
      r.querySelector(".n").textContent = name;
      const det = it.detour_m == null ? T("along.off", { d: U.fmtDist(it.off_m) }) : it.detour_m < 100 ? T("along.onRoute") : T("along.detour", { d: U.fmtDist(it.detour_m) });
      r.querySelector(".c").textContent = (ahead < 100 ? T("along.here") : T("along.ahead", { d: U.fmtDist(ahead) })) + " · " + det;
      const place = { name, ctx: it.name ? kindName(it.kind) : "", lat: it.lat, lon: it.lon };
      const add = () => { close(); Maps.insertStop(place, at0 + it.ahead_m); };
      r.querySelector(".add").setAttribute("aria-label", T("stop.add"));
      r.querySelector(".go").setAttribute("aria-label", T("along.go"));
      r.addEventListener("click", add);
      r.querySelector(".add").addEventListener("click", ev => { ev.stopPropagation(); add(); });
      r.querySelector(".go").addEventListener("click", ev => { ev.stopPropagation(); close(); Maps.navigateTo(place); });
      box.appendChild(r);
    }
  }
  function open() {
    if (!Maps.ctx().legs) return;
    $("sheet").classList.remove("open");
    $("along").classList.add("open");
    load();
    clearInterval(timer); timer = setInterval(render, 3000);   // while driving: km ahead count down, passed places drop out
  }
  function close() {
    clearInterval(timer); timer = null; seq++;
    const p = $("along");
    if (!p || !p.classList.contains("open")) return;
    p.classList.remove("open");
    if (Maps.ctx().state === "preview") $("sheet").classList.add("open");
  }
  build();
  window.addEventListener("navpi:preview", close);
  return { open, close, load };
})();
