/* system feature: Settings > Pi health — processor temperature, load, clock, memory, storage, power supply / throttling
   (Pi firmware flags), services, and 1-hour charts. Data from navd /api/system/health, sampled on the Pi every 10 s
   and kept in memory only: nothing leaves the device. Polled every 5 s while the category is open. The status bar
   shows no temperature (it read like the weather). */
"use strict";
(() => {
  const $ = id => document.getElementById(id);
  let timer = null, last = null;
  const gb = b => (b / 1e9).toFixed(b < 1e10 ? 1 : 0) + " GB";
  function dur(s) {
    if (s == null) return "–";
    const d = Math.floor(s / 86400), h = Math.floor(s % 86400 / 3600), m = Math.floor(s % 3600 / 60);
    return d ? d + " d " + h + " " + T("hr") : h ? h + " " + T("hr") + " " + m + " " + T("min") : Math.max(1, m) + " " + T("min");
  }
  // level: ok / warn / bad -> colour of the tile value
  function tile(label, value, unit, level) {
    const t = document.createElement("div"); t.className = "hl-tile " + (level || "ok");
    t.innerHTML = '<span class="v num"></span><span class="u"></span><span class="k"></span>';
    t.querySelector(".v").textContent = value; t.querySelector(".u").textContent = unit || ""; t.querySelector(".k").textContent = label;
    return t;
  }
  // a 1-hour line chart (inline SVG, no library); max = fixed top of the scale
  function chart(label, pts, key, max, unit) {
    const w = 300, h = 64, vals = pts.map(p => p[key]).filter(v => v != null);
    const c = document.createElement("div"); c.className = "hl-chart";
    const now = vals.length ? vals[vals.length - 1] : null;
    c.innerHTML = '<div class="hl-ch-h"><span class="k"></span><span class="v num"></span></div>' +
      `<svg viewBox="0 0 ${w} ${h}" preserveAspectRatio="none" aria-hidden="true"><polyline fill="none" stroke-width="2.5" vector-effect="non-scaling-stroke"/></svg>`;
    c.querySelector(".k").textContent = label;
    c.querySelector(".v").textContent = now == null ? "–" : Math.round(now) + " " + unit;
    if (pts.length > 1) {
      const t0 = pts[0].t, span = Math.max(1, pts[pts.length - 1].t - t0);
      c.querySelector("polyline").setAttribute("points", pts.filter(p => p[key] != null)
        .map(p => ((p.t - t0) / span * w).toFixed(1) + "," + (h - 2 - Math.min(1, p[key] / max) * (h - 4)).toFixed(1)).join(" "));
    } else c.classList.add("empty");
    return c;
  }
  function row(key, v, cls) {
    const k = document.createElement("span"), e = document.createElement("span");
    k.className = "k"; k.textContent = T(key); e.className = "v" + (cls ? " " + cls : ""); e.textContent = v;
    $("hl-list").append(k, e);
  }
  function render(d) {
    last = d;
    const tl = $("hl-tiles"); tl.replaceChildren();
    const temp = d.tempC, memUsed = d.mem ? 1 - d.mem.avail / d.mem.total : null, free = d.disk ? d.disk.free : null;
    tl.append(
      tile(T("hl.temp"), temp == null ? "–" : temp.toFixed(0), "°C", temp == null ? "" : temp >= 80 ? "bad" : temp >= 70 ? "warn" : "ok"),
      tile(T("hl.cpu"), d.cpu == null ? "–" : Math.round(d.cpu), "%", d.cpu >= 90 ? "warn" : "ok"),
      tile(T("hl.mem"), memUsed == null ? "–" : Math.round(memUsed * 100), "%", memUsed >= 0.9 ? "bad" : memUsed >= 0.75 ? "warn" : "ok"),
      tile(T("hl.disk"), free == null ? "–" : gb(free), T("hl.free"), free != null && free < 5e9 ? "bad" : free != null && free < 20e9 ? "warn" : "ok"));
    const ch = $("hl-charts"); ch.replaceChildren(
      chart(T("hl.tempH"), d.history || [], "temp", 90, "°C"),
      chart(T("hl.cpuH"), d.history || [], "cpu", 100, "%"),
      chart(T("hl.memH"), d.history || [], "mem", 100, "%"));
    $("hl-list").replaceChildren();
    const th = d.throttled;
    row("hl.power", !th ? T("hl.na") : th.undervolt ? T("hl.undervoltNow") : th.undervolt_was ? T("hl.undervoltWas") : T("hl.powerOk"),
      th && th.undervolt ? "bad" : th && th.undervolt_was ? "warn" : "");
    row("hl.throttle", !th ? T("hl.na") : th.throttled || th.capped || th.templimit ? T("hl.throttleNow") : th.throttled_was || th.capped_was || th.templimit_was ? T("hl.throttleWas") : T("hl.throttleOk"),
      th && (th.throttled || th.capped || th.templimit) ? "bad" : th && (th.throttled_was || th.capped_was) ? "warn" : "");
    row("hl.freq", d.freqMHz == null ? "–" : d.freqMHz + " MHz");
    row("hl.load", d.load ? d.load.map(x => x.toFixed(2)).join(" · ") + (d.cores ? "  (" + T("hl.cores", { n: d.cores }) + ")" : "") : "–");
    row("hl.ram", d.mem ? T("sys.freeOf", { free: gb(d.mem.avail), total: gb(d.mem.total) }) : "–");
    if (d.mem && d.mem.swapTotal) row("hl.swap", gb(d.mem.swapUsed) + " / " + gb(d.mem.swapTotal), d.mem.swapUsed > 5e8 ? "warn" : "");
    row("sys.uptime", dur(d.uptime));
    for (const [name, st] of Object.entries(d.services || {}))
      row("hl.svc." + name, st === "active" ? T("hl.running") : st === "inactive" ? T("hl.stopped") : st, st === "active" ? "ok" : "bad");
  }
  async function load() { try { render(await U.api("/api/system/health")); } catch (e) { /* navd restarting */ } }
  Settings.section({
    cat: "health",
    open() { load(); clearInterval(timer); timer = setInterval(load, 5000); },
    close() { clearInterval(timer); timer = null; },
    relang() { if (last) render(last); },
  });
})();
