/* system feature: Settings info card (storage, data versions, app version, uptime; temperature etc. on the Pi health page, health.js) and
   Restart / Shut down with a confirm dialog (navd /api/system, /api/system/power). */
"use strict";
(() => {
  let bound = false, last = null;
  const $ = id => document.getElementById(id);
  const gb = b => (b / 1e9).toFixed(b < 1e11 ? 1 : 0) + " GB";
  function dur(s) {
    if (s == null) return "–";
    const d = Math.floor(s / 86400), h = Math.floor(s % 86400 / 3600), m = Math.floor(s % 3600 / 60);
    return d ? d + " d " + h + " " + T("hr") : h ? h + " " + T("hr") + " " + m + " " + T("min") : Math.max(1, m) + " " + T("min");
  }
  function row(l, key, v, cls) {
    const k = document.createElement("span"), e = document.createElement("span");
    k.className = "k"; k.textContent = key ? T(key) : l;
    e.className = "v" + (cls ? " " + cls : ""); e.textContent = v;
    $("sys-list").append(k, e);
  }
  function sep() { const s = document.createElement("div"); s.className = "sep"; $("sys-list").append(s); }
  function render(d) {
    $("sys-list").replaceChildren();
    const free = d.disk ? d.disk.free : null;
    row("", "sys.free", d.disk ? T("sys.freeOf", { free: gb(d.disk.free), total: gb(d.disk.total) }) : "–", free != null && free < 5e9 ? "warn" : "");
    const dv = d.data || {}, ds = o => o ? (o.built || "?") : T("routes.missing");
    row("", "sys.map", dv.map ? T("sys.mapV", { osm: dv.map.osm || "?", built: dv.map.built || "?" }) : T("routes.missing"));
    row("", "sys.routes", ds(dv.routes));
    row("", "sys.search", ds(dv.search));
    sep();
    const a = d.app || {};
    row("", "sys.app", [a.edition, a.source].filter(Boolean).join(" · ") || "–");
    row("", "sys.built", a.built || "–");
    row("", "sys.uptime", dur(d.uptime));
  }
  async function load() {
    try { last = await U.api("/api/system"); render(last); } catch (e) { /* navd restarting */ }
  }
  function confirmPower(action) {
    const ov = document.createElement("div");
    ov.className = "pwr-scrim"; ov.setAttribute("role", "alertdialog");
    ov.innerHTML = `<div class="pwr-box"><h2></h2><p></p><div class="acts"><button class="btn no"></button><button class="btn go"></button></div></div>`;
    const key = action === "reboot" ? "sys.restart" : "sys.shutdown";
    ov.querySelector("h2").textContent = T(key) + "?";
    ov.querySelector("p").textContent = T(action === "reboot" ? "sys.restartAsk" : "sys.shutdownAsk");
    ov.querySelector(".no").textContent = T("sys.cancel");
    ov.querySelector(".go").textContent = T(key);
    const close = () => ov.remove();
    ov.querySelector(".no").onclick = close;
    ov.addEventListener("click", e => { if (e.target === ov) close(); });
    ov.querySelector(".go").onclick = async () => {
      close();
      try { await U.api("/api/system/power", { action }); U.toast(T(action === "reboot" ? "sys.restarting" : "sys.shuttingDown"), 8000); }
      catch (e) { U.toast(T("failed", { msg: e.message })); }
    };
    $("app").appendChild(ov);
  }
  function bind() {
    bound = true;
    document.querySelectorAll("[data-pwr]").forEach(b => b.addEventListener("click", () => confirmPower(b.dataset.pwr)));
  }
  // Restart / Shut down pinned at the bottom of the Settings category list, always visible
  const rail = document.querySelector("#settings .st-rail"), pwr = $("st-power");
  if (rail && pwr) rail.appendChild(pwr);
  Settings.section({ open() { if (!bound) bind(); load(); }, relang() { if (last) render(last); } });
})();
