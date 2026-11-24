/* bluetooth feature: scan, pair, connect, disconnect, forget (navd /api/bt, BlueZ). */
"use strict";
(() => {
  const $ = id => document.getElementById(id);
  let timer = null, scanning = false, confirmMac = null, bound = false, last = null;
  const STATUS = { pairing: "bt.pairing", connecting: "bt.connecting" };
  function row(d, paired, compact) {
    const b = document.createElement("div"); b.className = "row";
    const job = d.job, busy = job === "pairing" || job === "connecting";
    const st = busy ? T(STATUS[job]) : job ? job : T(d.connected ? "bt.connected" : paired ? "bt.notConnected" : "bt.tapToPair");
    b.innerHTML = `<svg class="i"><use href="#${d.audio ? "i-speaker" : "i-bt"}"/></svg>
      <div class="main"><div class="n"></div><div class="st ${d.connected ? "on" : job && !busy ? "err" : ""}"></div></div><div class="acts"></div>`;
    b.querySelector(".n").textContent = d.name;
    b.querySelector(".st").textContent = st;
    const acts = b.querySelector(".acts");
    const btn = (label, cls, fn) => { const x = document.createElement("button"); x.className = "btn " + cls; x.innerHTML = label;
      x.disabled = busy; x.addEventListener("click", e => { e.stopPropagation(); fn(); }); acts.appendChild(x); };
    if (paired) {
      if (d.connected) btn(T("bt.disconnect"), "ghost", () => act("disconnect", d.mac));
      else btn(T("bt.connect"), "primary", () => act("connect", d.mac));
      if (compact) return b;
      if (confirmMac === d.mac) btn(T("bt.reallyRemove"), "danger", () => { confirmMac = null; act("remove", d.mac); });
      else btn('<svg class="i"><use href="#i-trash"/></svg>', "ghost sq", () => { confirmMac = d.mac; render(last); setTimeout(() => { if (confirmMac === d.mac) { confirmMac = null; render(last); } }, 4000); });
    } else {
      b.style.cursor = "pointer";
      if (!busy) b.addEventListener("click", () => act("pair", d.mac));
    }
    return b;
  }
  function render(st) {
    if (!st || !$("bt-paired")) return;
    last = st;
    $("bt-power").setAttribute("aria-checked", String(st.powered));
    const paired = st.devices.filter(d => d.paired), found = st.devices.filter(d => !d.paired);
    const pb = $("bt-paired"); pb.innerHTML = "";
    if (!paired.length) { const h = document.createElement("div"); h.className = "hint"; h.textContent = T("bt.none"); pb.appendChild(h); }
    for (const d of paired) pb.appendChild(row(d, true));
    const fb = $("bt-found"); fb.innerHTML = "";
    if (scanning || st.scanning) for (const d of found) fb.appendChild(row(d, false));
    $("bt-hint").hidden = !(scanning || st.scanning);
    $("bt-scan").innerHTML = `<svg class="i"><use href="#${st.scanning ? "i-bt" : "i-plus"}"/></svg><span></span>`;
    $("bt-scan").querySelector("span").textContent = T(st.scanning ? "bt.scanning" : "bt.pairNew");
    $("bt-scan").disabled = !st.powered || st.scanning;
  }
  // status bar icon (information only): green = a device is connected, grey = on, grey crossed = off
  // (show the off state); hidden only without a Bluetooth controller. Polled every 30 s.
  function chip(st) {
    const c = $("bt-chip"); if (!c) return;
    c.hidden = !(st && st.present !== false); if (c.hidden) return;
    const on = st.powered ? st.devices.filter(d => d.connected).map(d => d.name || d.mac) : [];
    c.className = "chip " + (on.length ? "ok" : st.powered ? "off" : "off dim");
    c.querySelector("use").setAttribute("href", st.powered ? "#i-bt" : "#i-bt-off");
    c.title = st.powered ? T("bt.chip", { s: on.length ? on.join(", ") : T("bt.notConnected") }) : T("bt.off");
  }
  async function refresh() { try { const st = await U.api("/api/bt"); chip(st); render(st); } catch (e) { /* navd restarting */ } }
  async function act(action, mac, on) {
    try { await U.api("/api/bt/" + action, { mac, on }); }
    catch (e) { U.toast(action === "power" ? T("bt.powerFail") : T("failed", { msg: e.message }), 3500); }
    refresh();
  }
  function bind() {
    bound = true;
    $("bt-power").addEventListener("click", () => act("power", null, !(last && last.powered)));
    $("bt-scan").addEventListener("click", () => { scanning = true; act("scan", null, true); setTimeout(() => { scanning = false; }, 30000); });
  }
  Settings.section({
    cat: "connect",
    open() { if (!bound) bind(); refresh(); clearInterval(timer); timer = setInterval(refresh, 2000); },
    close() { clearInterval(timer); timer = null; },
    relang() { if (last) render(last); },
  });
  setTimeout(refresh, 2000); setInterval(() => { if (!timer) refresh(); }, 30000);   // status bar icon
})();
