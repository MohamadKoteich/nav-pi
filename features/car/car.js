/* car feature (PN-51): service reminders by date and/or km (oil change, inspection/TUV, tyres, custom).
   Data lives on the Pi (navd /api/car*, NAV_DATA/car/reminders.json). Typing uses the on-screen keyboard
   (core/keyboard.js) and is refused while the car moves. A due reminder shows a calm notice only when the car
   stands still — 10 s after the app starts, or after a drive once the car has stood for 90 s — never while
   guiding; it slides away as soon as the car moves. Movement = the window event "navpi:pos" (maps.js);
   guidance = "navpi:nav" (non-null while guiding). */
"use strict";
(() => {
  const $ = id => document.getElementById(id);
  const ICON = { oil: "i-oil", inspection: "i-wrench", tyres: "i-tyre", custom: "i-wrench" };
  const DEFAULTS = { oil: { every_months: 12, every_km: 15000 }, inspection: { every_months: 24 }, tyres: {}, custom: {} };
  let data = null, bound = false, ed = null;
  let speed = 0, speedAt = 0, guiding = false, movedFor = 0, lastMoveT = 0, stillSince = Date.now(), shownAfterStop = true;

  const nf = n => new Intl.NumberFormat(LANGS[LANG].locale).format(n);
  const monthName = ym => { const [y, m] = ym.split("-").map(Number);
    return new Date(y, m - 1, 1).toLocaleDateString(LANGS[LANG].locale, { month: "short", year: "numeric" }); };
  const addMonths = (ym, n) => { const [y, m] = ym.split("-").map(Number), i = y * 12 + m - 1 + n;
    return Math.floor(i / 12) + "-" + String(i % 12 + 1).padStart(2, "0"); };
  const thisMonth = () => { const d = new Date(); return d.getFullYear() + "-" + String(d.getMonth() + 1).padStart(2, "0"); };
  const name = it => it.kind === "custom" ? it.name : (it.name || T("car.k." + it.kind));
  const moving = () => Date.now() - speedAt < 5000 && speed > 2.5;
  const el = (tag, cls, txt) => { const e = document.createElement(tag); if (cls) e.className = cls; if (txt != null) e.textContent = txt; return e; };

  function dueText(it) {
    const parts = [];
    if (it.due_month) parts.push(monthName(it.due_month));
    if (it.due_km != null) parts.push(nf(it.due_km) + " km");
    let s = parts.join(" " + T("car.or") + " ");
    const ev = [it.every_months ? T("car.everyM", { n: it.every_months }) : "", it.every_km ? nf(it.every_km) + " km" : ""].filter(Boolean);
    if (ev.length) s += " · " + T("car.repeat", { what: ev.join(" / ") });
    return s;
  }

  // ---------- Settings card ----------
  async function load() {
    try { data = await U.api("/api/car"); } catch (e) { data = null; }
    render();
    return data;
  }
  function render() {
    if (!data) return;
    $("car-km").textContent = data.km != null ? "≈ " + nf(data.km) + " km" : T("car.odoUnknown");
    $("car-km-src").textContent = data.odo ? T(data.kmSource === "trip" ? "car.odoTrip" : "car.odoEntered",
      { d: new Date(data.odo.t * 1000).toLocaleDateString(LANGS[LANG].locale, { day: "numeric", month: "short", year: "numeric" }) }) : T("car.odoHint");
    const box = $("car-list"); box.replaceChildren();
    if (!data.items.length) box.append(el("div", "car-none", T("car.none")));
    data.items.forEach(it => {
      const r = el("button", "row car-item");
      r.innerHTML = `<svg class="i"><use href="#${ICON[it.kind]}"/></svg><div class="main"><div class="n"></div><div class="c"></div></div>`;
      r.querySelector(".n").textContent = name(it);
      r.querySelector(".c").textContent = dueText(it);
      if (it.state !== "ok") r.append(el("span", "st " + it.state, T("car.s." + it.state)));
      r.addEventListener("click", () => openEditor(it));
      box.append(r);
    });
  }

  // ---------- editor (keyboard for text and km; steppers for months) ----------
  function guard() { if (moving()) { U.toast(T("car.stopFirst")); return false; } return true; }
  function openEditor(it) {
    if (!guard()) return;
    ed = it ? { mode: "item", id: it.id, kind: it.kind, month: it.due_month || addMonths(thisMonth(), 12), dateOn: !!it.due_month, every: it.every_months || 0 }
      : { mode: "item", id: null, kind: "oil", month: addMonths(thisMonth(), 12), dateOn: true, every: DEFAULTS.oil.every_months };
    $("ce-title").textContent = T(it ? "car.edit" : "car.add");
    $("ce-name").value = it ? it.name || "" : "";
    $("ce-km").value = it && it.due_km != null ? it.due_km : "";
    $("ce-everykm").value = it ? it.every_km || "" : (DEFAULTS.oil.every_km || "");
    if (!it && data && data.km != null) $("ce-km").value = data.km + DEFAULTS.oil.every_km;
    $("ce-del").hidden = !it;
    showRows(true); paint(); open();
  }
  function openOdo() {
    if (!guard()) return;
    ed = { mode: "odo" };
    $("ce-title").textContent = T("car.odoEnter");
    $("ce-odo").value = data && data.km != null ? data.km : "";
    $("ce-del").hidden = true;
    showRows(false); open();
    $("ce-odo").focus();
  }
  function showRows(item) {
    document.querySelectorAll("#car-edit .ce-row, #ce-kinds").forEach(r => { r.hidden = !item; });
    $("ce-odo-row").hidden = item;
  }
  function open() { $("ce-err").textContent = ""; $("car-edit").classList.add("open"); }
  function close() { Keyboard.hide(); $("car-edit").classList.remove("open", "kb"); ed = null; document.activeElement && document.activeElement.blur(); }
  function paint() {
    document.querySelectorAll("#ce-kinds button").forEach(b => b.classList.toggle("on", b.dataset.kind === ed.kind));
    $("ce-name-row").hidden = ed.kind !== "custom";
    $("ce-month").textContent = monthName(ed.month);
    $("ce-date-on").setAttribute("aria-checked", String(ed.dateOn));
    $("ce-month").parentElement.classList.toggle("off", !ed.dateOn);
    $("ce-every").textContent = ed.every ? T("car.everyM", { n: ed.every }) : T("car.no");
  }
  function setKind(k) {
    ed.kind = k;
    if (!ed.id) {                                         // a new reminder: sensible repeat defaults per kind
      const d = DEFAULTS[k];
      ed.every = d.every_months || 0;
      $("ce-everykm").value = d.every_km || "";
      $("ce-km").value = d.every_km && data && data.km != null ? data.km + d.every_km : "";
      ed.dateOn = k !== "tyres" || !!d.every_months;
    }
    paint();
  }
  function kbFor(inp, numeric) {
    inp.addEventListener("focus", () => {
      $("car-edit").classList.add("kb");
      let fresh = numeric ? inp.value : null;              // a prefilled number is replaced by the first key, not appended to
      Keyboard.show(inp, () => {
        if (fresh !== null && inp.value.length === fresh.length + 1 && inp.value.startsWith(fresh)) inp.value = inp.value.slice(-1);
        fresh = null;
        if (numeric) inp.value = inp.value.replace(/\D/g, "").slice(0, 7); else inp.value = inp.value.slice(0, 40);
      },
        () => { $("car-edit").classList.remove("kb"); inp.blur(); }, T("car.ok"));
      setTimeout(() => inp.scrollIntoView({ block: "nearest" }), 50);
    });
  }
  async function save() {
    $("ce-err").textContent = "";
    try {
      if (ed.mode === "odo") {
        const v = $("ce-odo").value.trim();
        if (!v) { $("ce-err").textContent = T("car.err.km"); return; }
        data = await U.api("/api/car/odo", { km: Number(v) });
      } else {
        const body = { id: ed.id, kind: ed.kind, name: $("ce-name").value.trim(), due_month: ed.dateOn ? ed.month : null,
          due_km: $("ce-km").value || null, every_months: ed.every || null, every_km: $("ce-everykm").value || null };
        if (ed.kind === "custom" && !body.name) { $("ce-err").textContent = T("car.err.name"); return; }
        if (!body.due_month && !body.due_km) { $("ce-err").textContent = T("car.err.when"); return; }
        data = await U.api("/api/car/save", body);
      }
    } catch (e) { $("ce-err").textContent = T("failed", { msg: e.message }); return; }
    close(); render();
  }
  async function del() {
    const b = $("ce-del");
    if (b.dataset.sure !== "1") { b.dataset.sure = "1"; U.toast(T("car.delSure")); setTimeout(() => { b.dataset.sure = ""; }, 3000); return; }
    b.dataset.sure = "";
    try { data = await U.api("/api/car/delete", { id: ed.id }); } catch (e) { U.toast(T("failed", { msg: e.message })); return; }
    close(); render();
  }
  function bind() {
    bound = true;
    $("car-add").addEventListener("click", () => openEditor(null));
    $("car-odo-btn").addEventListener("click", openOdo);
    document.querySelectorAll("#ce-kinds button").forEach(b => b.addEventListener("click", () => setKind(b.dataset.kind)));
    $("ce-m-minus").addEventListener("click", () => { ed.dateOn = true; ed.month = addMonths(ed.month, -1); paint(); });
    $("ce-m-plus").addEventListener("click", () => { ed.dateOn = true; ed.month = addMonths(ed.month, 1); paint(); });
    $("ce-date-on").addEventListener("click", () => { ed.dateOn = !ed.dateOn; paint(); });
    $("ce-e-minus").addEventListener("click", () => { ed.every = Math.max(0, ed.every - (ed.every > 12 ? 6 : 1)); paint(); });
    $("ce-e-plus").addEventListener("click", () => { ed.every = Math.min(120, ed.every + (ed.every >= 12 ? 6 : 1)); paint(); });
    $("ce-cancel").addEventListener("click", close);
    $("ce-save").addEventListener("click", save);
    $("ce-del").addEventListener("click", del);
    $("car-edit").addEventListener("click", e => { if (e.target.id === "car-edit") close(); });
    kbFor($("ce-name"), false); kbFor($("ce-km"), true); kbFor($("ce-everykm"), true); kbFor($("ce-odo"), true);
  }
  Settings.section({
    cat: "car",
    open() { if (!bound) bind(); load(); },
    close() { if (ed) close(); },
    relang() { render(); if (ed && ed.mode === "item") paint(); },
  });

  // ---------- calm notice when standing still ----------
  function notice() {
    let n = $("car-notice");
    if (!n) {
      n = el("div"); n.id = "car-notice"; n.setAttribute("role", "status");
      n.innerHTML = '<div class="h"><svg class="i"><use href="#i-wrench"/></svg><div style="min-width:0;flex:1"><div class="t"></div><div class="s"></div></div></div>' +
        '<div class="actions"><button class="btn ghost" id="cn-later"></button><button class="btn primary" id="cn-done"><svg class="i"><use href="#i-check"/></svg><span></span></button></div>';
      $("app").appendChild(n);
      $("cn-later").addEventListener("click", async () => { const id = n.dataset.id; hideNotice();
        try { await U.api("/api/car/snooze", { id }); } catch (e) { /* shown again next stop */ } });
      $("cn-done").addEventListener("click", async () => { const id = n.dataset.id; hideNotice();
        try { data = await U.api("/api/car/done", { id }); U.toast(T("car.doneToast")); render(); } catch (e) { U.toast(T("failed", { msg: e.message })); } });
    }
    return n;
  }
  function hideNotice() { const n = $("car-notice"); if (n) n.classList.remove("open"); }
  async function check() {
    if (moving() || guiding || Keyboard.isOpen()) return;
    const d = await load(); if (!d || moving() || guiding) return;
    const due = d.items.filter(it => it.state === "due" && !it.snoozed);
    if (!due.length) return;
    const it = due[0], n = notice();
    n.dataset.id = it.id;
    n.querySelector(".t").textContent = T("car.dueNow", { name: name(it) });
    n.querySelector(".s").textContent = dueText(it) + (due.length > 1 ? " · " + T("car.more2", { n: due.length - 1 }) : "");
    $("cn-later").textContent = T("car.laterBtn");
    $("cn-done").querySelector("span").textContent = T("car.doneBtn");
    n.classList.add("open");
  }
  window.addEventListener("navpi:pos", e => {
    const p = e.detail; if (!p) return;
    const now = Date.now();
    speed = p.speed || 0; speedAt = now;
    if (speed > 2.5) {
      hideNotice();
      if (lastMoveT && now - lastMoveT < 5000) movedFor += now - lastMoveT;
      lastMoveT = now; stillSince = 0;
      if (movedFor > 30000) shownAfterStop = false;      // a real drive: offer the notice at the next stop
    } else if (!stillSince) stillSince = now;
  });
  window.addEventListener("navpi:nav", e => { guiding = !!e.detail; if (guiding) hideNotice(); });
  setInterval(() => {                                      // 0.2 Hz: after a drive, stood 90 s, not guiding
    if (moving()) return;
    if (!stillSince) stillSince = Date.now();               // no fixes at all = parked / no receiver
    if (!shownAfterStop && Date.now() - stillSince > 90000 && !guiding) { shownAfterStop = true; movedFor = 0; check(); }
  }, 5000);
  setTimeout(check, 10000);                                // at start
  window.Car = { check, load };
})();
