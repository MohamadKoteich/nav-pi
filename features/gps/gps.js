/* gps feature: GPS status page (rail page "GPS"). Reads navd /api/gps/info (gpsd DEVICES / SKY / TPV).
   Shows: receiver present, fix 2D/3D, satellites used/seen (sky plot + signal bars), accuracy, speed, heading (compass),
   GPS time, receiver model. "No GPS receiver connected" when gpsd has no device. Dead-reckoning state (deadreckon.js)
   shows as "Estimated". Pure display: nothing here changes the position the map uses. */
"use strict";
(() => {
  const $ = id => document.getElementById(id);
  let last = null, timer = null, est = false;
  const CARD = ["N", "NE", "E", "SE", "S", "SW", "W", "NW"];
  const cardinal = d => T("gps.dir." + CARD[Math.round(d / 45) % 8]);
  const kmh = v => Math.round((v || 0) * 3.6);

  // one summary for the card header: {key, cls, text, sub}
  function summary(g) {
    if (!g) return { cls: "off", text: T("gps.noRxShort"), sub: "" };
    const seen = g.nSat == null ? 0 : g.nSat, used = g.uSat == null ? 0 : g.uSat;
    const sats = T("gps.sats", { u: used, n: seen });
    if (est) return { cls: "warn", text: T("gps.est"), sub: T("gps.estSub") };
    if (!g.receiver) return { cls: "off", text: T("gps.noRxShort"), sub: T("gps.plugIn") };
    if (g.mode >= 3) return { cls: "ok", text: T("gps.fix3"), sub: sats + (g.fix.eph != null ? " · ±" + Math.round(g.fix.eph) + " m" : "") };
    if (g.mode === 2) return { cls: "ok", text: T("gps.fix2"), sub: sats + (g.fix.eph != null ? " · ±" + Math.round(g.fix.eph) + " m" : "") };
    return { cls: "warn", text: g.stale ? T("gps.lost") : T("gps.searching"), sub: sats };
  }

  function skySvg(sats) {
    let h = '<circle r="100" fill="none" stroke="var(--text-3)" stroke-width="1.5"/><circle r="66.7" fill="none" stroke="var(--surface-3)" stroke-width="1"/><circle r="33.3" fill="none" stroke="var(--surface-3)" stroke-width="1"/>' +
      '<path d="M-100 0H100M0 -100V100" stroke="var(--surface-3)" stroke-width="1"/>' +
      '<g fill="var(--text-2)" font-size="12" text-anchor="middle"><text y="-102">N</text><text x="106" y="4">E</text><text y="112">S</text><text x="-106" y="4">W</text></g>';
    for (const s of sats) {
      if (s.el == null || s.az == null) continue;
      const r = 100 * (90 - Math.max(0, Math.min(90, s.el))) / 90, a = s.az * Math.PI / 180;
      const x = (r * Math.sin(a)).toFixed(1), y = (-r * Math.cos(a)).toFixed(1);
      h += `<g class="sat ${s.used ? "used" : "seen"}" data-prn="${s.prn}"><circle cx="${x}" cy="${y}" r="8.5" fill="${s.used ? "var(--ok)" : "var(--text-3)"}"/>` +
        `<text x="${x}" y="${(+y + 3.2).toFixed(1)}" font-size="9" font-weight="700" text-anchor="middle" fill="#04101f">${s.prn}</text></g>`;
    }
    return h;
  }
  function compassSvg(track, moving) {
    let h = '<circle r="54" fill="none" stroke="var(--text-3)" stroke-width="2"/>';
    for (let i = 0; i < 36; i++) h += `<line y1="-54" y2="${i % 9 === 0 ? -46 : -50}" stroke="var(--text-3)" stroke-width="1.5" transform="rotate(${i * 10})"/>`;
    h += '<g fill="var(--text-2)" font-size="12" text-anchor="middle"><text y="-34" fill="var(--danger)" font-weight="700">N</text><text x="36" y="4">E</text><text y="42">S</text><text x="-36" y="4">W</text></g>';
    if (track != null) h += `<g transform="rotate(${track})" id="gps-needle"><path d="M0 -30 9 12 0 6 -9 12z" fill="${moving ? "var(--accent)" : "var(--text-3)"}"/></g>`;
    return h;
  }
  function bars(sats) {
    const l = $("gps-bars");
    if (!sats.length) { l.innerHTML = '<span class="none"></span>'; l.firstChild.textContent = T("gps.noSats"); return; }
    const s = sats.slice().sort((a, b) => (b.used - a.used) || ((b.ss || 0) - (a.ss || 0))).slice(0, 24);
    l.innerHTML = s.map(x => `<div class="b ${x.used ? "used" : ""}"><i style="height:${Math.max(3, Math.min(100, (x.ss || 0) / 50 * 100))}%"></i>${x.prn}</div>`).join("");
  }
  function val(label, v, cls) { return `<div${cls ? ' class="' + cls + '"' : ""}><small>${label}</small>${v}</div>`; }
  function esc(s) { return String(s).replace(/[&<>"]/g, c => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c])); }

  function render() {
    if (!$("gps-card") || !last) return;
    const g = last, s = summary(g), f = g.fix || {};
    $("gps-state").textContent = s.text;
    $("gps-none").hidden = g.receiver; $("gps-body").hidden = !g.receiver;
    $("gps-est").hidden = !est;
    if (!g.receiver) return;
    $("gps-sky").innerHTML = skySvg(g.sats || []);
    const moving = g.mode >= 2 && (f.speed || 0) > 0.6;
    const track = g.mode >= 2 && f.track != null ? f.track : null;
    $("gps-compass").innerHTML = compassSvg(track, moving);
    $("gps-hd").textContent = track != null ? Math.round(track) + "° " + cardinal(track) : "–";
    const dev = (g.devices && g.devices[0]) || {};
    const model = [dev.driver, dev.subtype].filter(Boolean).join(" ") || "–";
    let time = "–";
    if (f.time) {
      const t = Date.parse(f.time);
      if (!isNaN(t)) {
        time = new Date(t).toISOString().slice(11, 19) + " UTC";
        const diff = Math.round((Date.now() - (t + (g.tpv_age || 0) * 1000)) / 1000);
        if (Math.abs(diff) > 2) time += "<small>" + esc(T("gps.clockDiff", { s: (diff > 0 ? "+" : "") + diff })) + "</small>";
      }
    }
    const acc = f.eph != null ? "±" + Math.round(f.eph) + " m" : "–";
    const dop = g.dop && g.dop.hdop != null ? "<small>HDOP " + g.dop.hdop.toFixed(1) + "</small>" : "";
    $("gps-vals").innerHTML =
      val(T("gps.fixLabel"), esc(s.text)) +
      val(T("gps.satellites"), g.nSat == null ? "–" : (g.uSat || 0) + " / " + g.nSat) +
      val(T("gps.accuracy"), acc + dop) +
      val(T("gps.speed"), g.mode >= 2 ? kmh(f.speed) + " km/h" : "–") +
      val(T("gps.time"), time, "wide") +
      val(T("gps.receiver"), esc(model) + "<small>" + esc([dev.path, dev.bps ? dev.bps + " bps" : ""].filter(Boolean).join(" · ")) + "</small>", "wide");
    bars(g.sats || []);
  }

  async function refresh() {
    try { last = await U.api("/api/gps/info"); } catch (e) { return; }
    render();
  }
  window.addEventListener("navpi:gps-est", e => { est = !!(e.detail && e.detail.on); render(); });
  Shell.view("gps", {   // rail page "GPS" (2026-11-22; was a Settings card)
    show() { refresh(); clearInterval(timer); timer = setInterval(refresh, 1000); },
    hide() { clearInterval(timer); timer = null; },
  });
  Shell.onLang(() => { if (last) render(); });
})();
