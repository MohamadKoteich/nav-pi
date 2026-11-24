/* PN-41 round trip of N km: start = your position, the map centre (no GPS) or a point chosen by long-press.
   Three "through" points on a circle that touches the start; the local Valhalla routes start -> them -> start,
   the circle is resized until the drive is within 20 % of N (at most 3 tries). "Shuffle" = another direction
   and turning sense. Opens from the search panel ("Round trip") and from the long-press sheet. */
"use strict";
const RoundTrip = (() => {
  const $ = id => document.getElementById(id);
  const KMS = [10, 25, 50, 100];
  let start = null, km = U.store.get("roundKm", 25), typing = false;

  const ICON_LOOP = '<svg class="i" viewBox="0 0 24 24"><path d="M12 4V1L8 5l4 4V6a6 6 0 0 1 5.3 8.8l1.5 1.5A8 8 0 0 0 12 4zm0 14a6 6 0 0 1-5.3-8.8L5.2 7.7A8 8 0 0 0 12 20v3l4-4-4-4z"/></svg>';
  const ICON_SHUFFLE = '<svg class="i" viewBox="0 0 24 24"><path d="M10.6 9.2 5.4 4 4 5.4l5.2 5.2zM14.5 4l2 2L4 18.6 5.4 20 18 7.5l2 2V4zm.3 9.4-1.4 1.4 3.1 3.1-2 2.1H20v-5.5l-2 2z"/></svg>';

  function build() {
    const p = document.createElement("div"); p.id = "rtrip"; p.className = "navpanel"; p.setAttribute("role", "dialog");
    p.innerHTML = `<div class="ttl" data-i18n="rt.title"></div>
      <div class="rt-from" id="rt-from"></div>
      <div class="rt-kms" role="radiogroup">${KMS.map(k => `<button class="rt-km num" data-km="${k}" role="radio">${k} km</button>`).join("")}
        <button class="rt-km" data-km="other" role="radio" data-i18n="rt.other"></button></div>
      <div class="pf-in rt-in" id="rt-in" hidden><input id="rt-num" inputmode="none" autocomplete="off" data-i18n-ph="rt.ph" data-i18n-label="rt.ph"></div>
      <div class="actions">
        <button class="btn ghost sq" id="rt-cancel" data-i18n-label="cancel"><svg class="i"><use href="#i-close"/></svg></button>
        <button class="btn primary" id="rt-go">${ICON_LOOP}<span data-i18n="rt.plan"></span></button></div>`;
    $("maps").appendChild(p);
    p.querySelectorAll(".rt-km").forEach(b => b.addEventListener("click", () => pick(b.dataset.km)));
    $("rt-cancel").addEventListener("click", close);
    $("rt-go").addEventListener("click", () => plan(0));
    $("rt-num").addEventListener("focus", () => Keyboard.show($("rt-num"), () => {}, () => plan(0)));
    // the long-press sheet: "Round trip" from the pressed point
    const sub = document.querySelector("#pick .actions.sub");
    const b = document.createElement("button"); b.className = "btn ghost"; b.id = "p-round";
    b.innerHTML = ICON_LOOP + '<span data-i18n="rt.title"></span>';
    b.addEventListener("click", () => { $("pick").classList.remove("open"); const pp = Maps.picked(); open(pp && { name: T("marked"), lat: pp.lat, lon: pp.lon }); });
    sub.appendChild(b);
    // Shuffle in the route sheet's tools row (round trips only)
    const sh = document.createElement("button"); sh.className = "btn ghost tool"; sh.id = "s-shuffle"; sh.hidden = true;
    sh.innerHTML = ICON_SHUFFLE + '<span data-i18n="rt.shuffle"></span>';
    sh.addEventListener("click", shuffle);
    $("s-tools").appendChild(sh);
    applyI18n(p); applyI18n(sub); applyI18n($("s-tools"));
  }
  function pick(k) {
    typing = k === "other";
    document.querySelectorAll("#rtrip .rt-km").forEach(b => b.setAttribute("aria-checked", b.dataset.km === String(typing ? "other" : k)));
    $("rt-in").hidden = !typing;
    if (typing) { $("rt-num").value = ""; $("rt-num").focus(); } else { km = Number(k); Keyboard.hide(); }
  }
  function open(from) {
    start = from || null;
    const c = Maps.ctx();
    $("rt-from").textContent = T("from") + " " + (start ? start.name : c.pos ? T("from.here") : T("from.center"));
    pick(KMS.includes(km) ? km : "other");
    if (!KMS.includes(km)) $("rt-num").value = km;
    $("rtrip").classList.add("open");
  }
  function close() { Keyboard.hide(); $("rt-num").blur(); $("rtrip").classList.remove("open"); }

  // three points on a circle through the start: centre r away at bearing th; dir = turning sense
  function circle(s, r, th, dir) {
    const kx = 111320 * Math.cos(s.lat * Math.PI / 180), ky = 110540, rad = d => d * Math.PI / 180;
    const cx = s.lon + Math.sin(rad(th)) * r / kx, cy = s.lat + Math.cos(rad(th)) * r / ky;
    const pts = [];
    for (let k = 1; k <= 3; k++) {
      const a = rad(th + 180 + dir * 90 * k);
      pts.push({ lat: cy + Math.cos(a) * r / ky, lon: cx + Math.sin(a) * r / kx });
    }
    return pts;
  }
  // -> {L: metres, back: share of the drive on road already driven (a point on a dead end = out and back)}
  async function length(s, via) {
    const body = { locations: [{ lat: s.lat, lon: s.lon }, ...via.map(v => ({ lat: v.lat, lon: v.lon, type: "through",
      search_filter: { min_road_class: "tertiary" } })), { lat: s.lat, lon: s.lon }], costing: "auto", directions_type: "none" };
    const t = (await U.api("/api/route", body)).trip;
    return { L: t.summary.length * 1000, back: overlap(t.legs.flatMap(l => U.decodePolyline(l.shape))) };
  }
  function overlap(shape) {
    const cell = p => Math.round(p[0] * 2000) + ":" + Math.round(p[1] * 3000);   // ~35 m cells
    const seen = new Map(), segs = [0];
    for (let i = 1; i < shape.length; i++) segs.push(U.dist(shape[i - 1], shape[i]));
    const total = segs.reduce((a, b) => a + b, 0);
    let d = 0, again = 0;
    for (let i = 1; i < shape.length; i++) {
      d += segs[i];
      const k = cell(shape[i]), first = seen.get(k);
      if (first === undefined) seen.set(k, d);
      else if (d - first > 400 && d > 1500 && d < total - 1500) again += segs[i];   // leaving and coming home on one road is fine
    }
    return total ? again / total : 0;
  }
  async function plan(seed, sp) {
    if (typing) {
      const n = Number(String($("rt-num").value).replace(",", "."));
      if (!(n >= 2 && n <= 300)) { U.toast(T("rt.range"), 3000); return; }
      km = Math.round(n);
    }
    U.store.set("roundKm", km);
    const c = Maps.ctx();
    sp = sp !== undefined ? sp : start;
    let s = sp;
    if (!s) {
      if (c.pos) s = { lat: c.pos.lat, lon: c.pos.lng };
      else { const m = window.__map.getCenter(); s = sp = { name: T("from.center"), lat: m.lat, lon: m.lng }; }
    }
    close();
    U.toast(T("rt.planning"), 20000);
    const dir = seed % 2 ? -1 : 1, want = km * 1000;
    let th = (seed * 137.508 + 23) % 360, r = want / 1.3 / 5.8, best = null;
    // up to 4 tries: resize the circle towards N km; a loop that drives a road twice (a point on a dead end) turns it a bit
    for (let i = 0; i < 4; i++) {
      const via = circle(s, r, th, dir);
      let m;
      try { m = await length(s, via); } catch (e) { r *= 0.8; th += 25; continue; }   // a point with no road nearby
      const off = Math.abs(m.L - want) / want, score = off + 2 * m.back;
      if (!best || score < best.score) best = { L: m.L, via, score };
      if (off < 0.2 && m.back < 0.08) break;
      if (off >= 0.2) r *= Math.max(0.5, Math.min(2, want / m.L));
      if (m.back >= 0.08) th += 25;
    }
    if (!best) { U.toast(T("rt.fail"), 4000); return; }
    const d = { name: T("rt.name", { km }), ctx: T("rt.ctx", { n: seed + 1 }), lat: s.lat, lon: s.lon, via: best.via,
      round: { km, seed, start: sp || null } };
    Maps.preview(d, sp || null, []);
  }
  function shuffle() {
    const d = Maps.ctx().dest;
    if (d && d.round) { km = d.round.km; typing = false; plan(d.round.seed + 1, d.round.start); }
  }
  // search panel (destination mode): "Round trip" under Saved places
  window.addEventListener("navpi:recents", e => {
    if (e.detail.mode !== "dest") return;
    const r = document.createElement("button"); r.className = "row"; r.id = "rt-row";
    r.innerHTML = ICON_LOOP + '<div class="main"><div class="n"></div><div class="c"></div></div>';
    r.querySelector(".n").textContent = T("rt.title"); r.querySelector(".c").textContent = T("rt.hint");
    r.addEventListener("click", () => { $("q-clear").click(); open(null); });
    e.detail.box.appendChild(r);
  });
  // a round trip in the sheet: Shuffle instead of swap / add stop (they would break the loop)
  window.addEventListener("navpi:preview", e => {
    const round = !!(e.detail.dest && e.detail.dest.round);
    $("s-shuffle").hidden = !round; $("s-swap").hidden = round; $("s-addstop").hidden = round;
  });
  build();
  return { open, plan };
})();
