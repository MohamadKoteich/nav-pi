/* PN-41 share a destination to a phone: a big QR code on the screen (encoder: qrcode.js, offline).
   Content, chosen by the chips and remembered: a geo: URI (Android opens its map app), an OpenStreetMap
   link or a Google Maps link (any phone camera opens a link). From the route sheet ("Share") and the
   long-press sheet. */
"use strict";
const ShareQR = (() => {
  const $ = id => document.getElementById(id);
  const FMT = ["geo", "osm", "google"];
  let place = null, fmt = U.store.get("qrFmt", "geo");
  const ICON = '<svg class="i" viewBox="0 0 24 24"><path d="M3 11h8V3H3zm2-6h4v4H5zM3 21h8v-8H3zm2-6h4v4H5zm8-12v8h8V3zm6 6h-4V5h4zm-6 4h2v2h-2zm2 2h2v2h-2zm-2 2h2v2h-2zm4 0h2v2h-2zm2 2h2v2h-2zm-4 0h2v2h-2zm2-6h2v2h-2zm2 2h2v2h-2z"/></svg>';
  const c6 = v => Number(v).toFixed(6);
  function text(p, f) {
    const ll = c6(p.lat) + "," + c6(p.lon);
    if (f === "osm") return `https://www.openstreetmap.org/?mlat=${c6(p.lat)}&mlon=${c6(p.lon)}#map=17/${c6(p.lat)}/${c6(p.lon)}`;
    if (f === "google") return `https://www.google.com/maps/search/?api=1&query=${ll}`;
    const label = (p.name || "").slice(0, 60);
    return "geo:" + ll + "?q=" + ll + (label ? "(" + encodeURIComponent(label) + ")" : "");
  }
  function build() {
    const p = document.createElement("div"); p.id = "qrshare"; p.setAttribute("role", "dialog");
    p.innerHTML = `<div class="qr-card"><div class="qr-code" id="qr-code" role="img"></div>
      <div class="qr-side"><div class="ttl" data-i18n="qr.title"></div><div class="qr-name" id="qr-name"></div>
        <div class="qr-hint" data-i18n="qr.hint"></div>
        <div class="qr-fmts" role="radiogroup">${FMT.map(f => `<button class="qr-fmt" data-f="${f}" role="radio" data-i18n="qr.${f}"></button>`).join("")}</div>
        <div class="qr-text num" id="qr-text"></div>
        <button class="btn primary" id="qr-close"><span data-i18n="qr.done"></span></button></div></div>`;
    $("maps").appendChild(p);
    p.querySelectorAll(".qr-fmt").forEach(b => b.addEventListener("click", () => { fmt = b.dataset.f; U.store.set("qrFmt", fmt); draw(); }));
    $("qr-close").addEventListener("click", close);
    p.addEventListener("click", e => { if (e.target === p) close(); });
    const t = document.createElement("button"); t.className = "btn ghost tool"; t.id = "s-share";
    t.innerHTML = ICON + '<span data-i18n="qr.btn"></span>';
    t.addEventListener("click", () => { const c = Maps.ctx(); if (c.dest) open(c.dest); });
    $("s-tools").appendChild(t);
    const sub = document.querySelector("#pick .actions.sub");
    const b = document.createElement("button"); b.className = "btn ghost"; b.id = "p-share";
    b.innerHTML = ICON + '<span data-i18n="qr.btn"></span>';
    b.addEventListener("click", () => { const pp = Maps.picked(); if (pp) { $("pick").classList.remove("open"); open({ name: "", lat: pp.lat, lon: pp.lon }); } });
    sub.appendChild(b);
    applyI18n(p); applyI18n($("s-tools")); applyI18n(sub);
  }
  function draw() {
    if (!FMT.includes(fmt)) fmt = "geo";
    const s = text(place, fmt);
    $("qr-code").innerHTML = QRCode.svg(s);
    $("qr-code").setAttribute("aria-label", s);
    $("qr-text").textContent = s;
    document.querySelectorAll("#qrshare .qr-fmt").forEach(b => b.setAttribute("aria-checked", b.dataset.f === fmt));
  }
  function open(p) {
    place = p;
    $("qr-name").textContent = p.name || (c6(p.lat) + ", " + c6(p.lon));
    draw();
    $("qrshare").classList.add("open");
  }
  function close() { $("qrshare").classList.remove("open"); }
  build();
  // a round trip has no destination worth sending; a walk back to the car neither
  window.addEventListener("navpi:preview", e => { const d = e.detail.dest; $("s-share").hidden = !!(d && (d.round || d.walk)); });
  return { open, close, text };
})();
