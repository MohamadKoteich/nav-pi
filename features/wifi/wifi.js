/* wifi feature: networks, connect (password on the on-screen keyboard), forget, on/off (navd /api/wifi, NetworkManager).
   The password goes only to navd -> nmcli --ask -> NetworkManager; it is not kept here (the input is cleared). */
"use strict";
(() => {
  const $ = id => document.getElementById(id);
  let timer = null, bound = false, last = null, pick = null, confirmId = null, wasJob = "idle", scanUntil = 0;
  const bars = s => s >= 75 ? 1 : s >= 50 ? .8 : s >= 25 ? .6 : .4;
  const kbd = () => Keyboard.show($("wifi-pw"), () => {}, () => submit(), T("wifi.kbd"));
  function status(st) {
    if (!st.enabled) return T("wifi.off");
    if (st.job && st.job.state === "connecting") return T("wifi.connecting", { ssid: st.job.ssid });
    if (st.ssid) return st.ssid + (st.ip ? " · " + T("wifi.ip", { ip: st.ip }) : "");
    return T("wifi.notConnected");
  }
  function row(n) {
    const b = document.createElement("div"); b.className = "row";
    const busy = last.job && last.job.state === "connecting";
    const id = n.uuid || n.ssid;
    const lock = n.secure ? '<svg class="i lk"><use href="#i-lock"/></svg>' : "";
    b.innerHTML = `<span class="wifi-sig"><svg class="i" style="opacity:${bars(n.signal || 0)}"><use href="#i-wifi"/></svg>${lock}</span>
      <div class="main"><div class="n"></div><div class="st"></div></div><div class="acts"></div>`;
    b.querySelector(".n").textContent = n.ssid;
    const st = b.querySelector(".st");
    st.textContent = n.inuse ? T("wifi.connected") : n.enterprise ? T("wifi.enterprise") : n.out ? T("wifi.out") : n.uuid ? T("wifi.saved") : n.secure ? T("wifi.secured") : T("wifi.open");
    if (n.inuse) st.classList.add("on");
    const acts = b.querySelector(".acts");
    const btn = (label, cls, fn, dis) => { const x = document.createElement("button"); x.className = "btn " + cls; x.innerHTML = label; x.disabled = !!dis;
      x.addEventListener("click", e => { e.stopPropagation(); fn(); }); acts.appendChild(x); };
    if (!n.inuse && !n.out && !n.enterprise) btn(T("wifi.connect"), "primary", () => start(n), busy);
    if (n.uuid) {
      if (confirmId === id) btn(T("wifi.reallyForget"), "danger", () => { confirmId = null; forget(n.uuid); });
      else btn('<svg class="i"><use href="#i-trash"/></svg>', "ghost sq", () => { confirmId = id; render(last);
        setTimeout(() => { if (confirmId === id) { confirmId = null; if (last) render(last); } }, 4000); });
    }
    return b;
  }
  // status bar icon (information only): green = connected, grey = on but not connected, grey crossed = off
  // (show the off state, do not hide it); hidden only without a Wi-Fi adapter. Polled every 30 s.
  function chip(st) {
    const c = $("wifi-chip"); if (!c) return;
    c.hidden = !(st && st.present); if (c.hidden) return;
    c.className = "chip " + (st.enabled && st.ssid ? "ok" : st.enabled ? "off" : "off dim");
    c.querySelector("use").setAttribute("href", st.enabled ? "#i-wifi" : "#i-wifi-off");
    c.title = st.enabled ? T("wifi.chip", { s: st.ssid || T("wifi.notConnected") }) : T("wifi.off");
  }
  function render(st) {
    chip(st);
    if (!st || !$("wifi-card")) return;
    last = st;
    $("wifi-card").hidden = !st.present; $("wifi-absent").hidden = st.present;
    if (!st.present) return;
    $("wifi-power").setAttribute("aria-checked", String(st.enabled));
    $("wifi-status").textContent = status(st);
    const l = $("wifi-list"); l.innerHTML = "";
    const items = st.networks.concat(st.saved.map(s => ({ ssid: s.name, uuid: s.uuid, secure: true, signal: 0, out: true })));
    if (!items.length && st.enabled) { const h = document.createElement("div"); h.className = "hint"; h.textContent = T("wifi.none"); l.appendChild(h); }
    for (const n of items) l.appendChild(row(n));
    const sc = $("wifi-scan"); sc.disabled = !st.enabled; sc.querySelector("span").textContent = T(Date.now() < scanUntil ? "wifi.scanning" : "wifi.scan");
    const j = st.job || {};
    if (wasJob === "connecting" && j.state === "done") { U.toast(T("wifi.ok", { ssid: j.ssid }), 3000); closePass(); }
    if (wasJob === "connecting" && j.state === "failed") U.toast(T("wifi.err." + (j.error || "failed")), 4000);
    wasJob = j.state;
  }
  function start(n) {
    if (n.uuid || !n.secure) return connect(n.ssid, "", n.uuid);
    pick = n.ssid; $("wifi-pw").value = ""; $("wifi-pw").type = "password";
    $("wifi-pass-for").textContent = T("wifi.passFor", { ssid: n.ssid });
    $("wifi-pass").hidden = false; $("settings").classList.add("kb");
    const pane = $("st-pane"), at = $("wifi-pass");   // scroll the pane only: scrollIntoView also shifts #views (seen on the Pi)
    if (pane) pane.scrollTop += (at.getBoundingClientRect().top - pane.getBoundingClientRect().top) / UiScale.value();   // screen px -> UI px
    kbd();
  }
  function closePass() { pick = null; $("wifi-pw").value = ""; $("wifi-pass").hidden = true; $("settings").classList.remove("kb"); Keyboard.hide(); }
  function submit() {
    const pw = $("wifi-pw").value;
    if (!pick) return;
    if (pw.length < 8) { U.toast(T("wifi.err.bad"), 3500); kbd(); return; }
    const ssid = pick; closePass(); connect(ssid, pw, "");
  }
  async function connect(ssid, password, uuid) {
    wasJob = "connecting";   // a fast job may finish between two polls: still announce its result
    try { await U.api("/api/wifi/connect", { ssid, password, uuid }); }
    catch (e) { U.toast(T("failed", { msg: e.message }), 3500); }
    setTimeout(refresh, 300); setTimeout(refresh, 1500);
  }
  async function forget(uuid) {
    try { await U.api("/api/wifi/forget", { uuid }); } catch (e) { U.toast(T("failed", { msg: e.message }), 3500); }
    refresh();
  }
  async function refresh() { try { render(await U.api("/api/wifi")); } catch (e) { /* navd restarting */ } }
  async function scan() {
    scanUntil = Date.now() + 6000; if (last) render(last);
    try { await U.api("/api/wifi/scan", {}); } catch (e) { /* ignore */ }
    setTimeout(refresh, 2500); setTimeout(refresh, 6000);
  }
  async function power() {
    const on = !(last && last.enabled);
    try { await U.api("/api/wifi/power", { on }); } catch (e) { U.toast(T("failed", { msg: e.message }), 3500); }
    if (on) setTimeout(scan, 1500);
    refresh();
  }
  function bind() {
    bound = true;
    $("wifi-power").addEventListener("click", power);
    $("wifi-scan").addEventListener("click", scan);
    $("wifi-go").addEventListener("click", submit);
    $("wifi-cancel").addEventListener("click", closePass);
    $("wifi-pw").addEventListener("click", kbd);
    $("wifi-pw").addEventListener("keydown", e => { if (e.key === "Enter" && !Keyboard.isOpen()) { e.preventDefault(); submit(); } });
    $("wifi-eye").addEventListener("click", () => { const p = $("wifi-pw"); p.type = p.type === "password" ? "text" : "password"; });
  }
  Settings.section({
    cat: "connect",
    open() { if (!bound) bind(); refresh().then(() => { if (last && last.enabled) scan(); }); clearInterval(timer); timer = setInterval(refresh, 3000); },
    close() { clearInterval(timer); timer = null; closePass(); },
    relang() { if (last) render(last); },
  });
  setTimeout(refresh, 1500); setInterval(() => { if (!timer) refresh(); }, 30000);   // status bar icon
})();
