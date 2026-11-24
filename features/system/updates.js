/* system feature: Settings > Updates (PN-22 map updates, PN-23 app + OS updates). Talks to navd /api/update/*.
   Bundles come from USB sticks or a PC address typed once; copy + sha256 check + switch happen in navd, never while driving. */
"use strict";
(() => {
  const $ = id => document.getElementById(id);
  let st = null, bundles = [], timer = null, bound = false, openNow = false, handledDone = false, checking = false, lastMsg = "";
  const gb = b => b >= 1e9 ? (b / 1e9).toFixed(b >= 1e10 ? 0 : 1) + " GB" : Math.max(1, Math.round(b / 1e6)) + " MB";
  const blocked = () => document.body.classList.contains("navigating") || !!(st && st.moving);
  const errText = (r) => T("upd.err." + (r.error || "bad"), { msg: r.msg || "" });
  async function post(path, body) {
    try { return await U.api("/api/update/" + path, body || { guiding: document.body.classList.contains("navigating") }); }
    catch (e) { return /^[a-z0-9]+$/.test(e.message) ? { ok: false, error: e.message } : { ok: false, error: "copy", msg: e.message }; }
  }
  const withGuard = b => ({ guiding: document.body.classList.contains("navigating"), ...b });

  function dialog(title, text, yes, opts) {
    return new Promise(res => {
      const ov = document.createElement("div");
      ov.className = "pwr-scrim"; ov.setAttribute("role", "alertdialog");
      ov.innerHTML = '<div class="pwr-box upd-box"><h2></h2><p></p><div class="acts"><button class="btn no"></button><button class="btn go"></button></div></div>';
      ov.querySelector("h2").textContent = title;
      ov.querySelector("p").textContent = text;
      const no = ov.querySelector(".no"), go = ov.querySelector(".go");
      no.textContent = T("sys.cancel");
      if (yes) { go.textContent = yes; if (opts && opts.safe) go.classList.add("safe"); } else go.remove();
      const done = v => { ov.remove(); res(v); };
      no.onclick = () => done(false);
      go.onclick = () => done(true);
      ov.addEventListener("click", e => { if (e.target === ov) done(false); });
      $("app").appendChild(ov);
    });
  }

  function mkRow(name, sub, subCls) {
    const r = document.createElement("div");
    r.className = "row";
    r.innerHTML = '<div class="main"><div class="n"></div><div class="st"></div></div><div class="acts"></div>';
    r.querySelector(".n").textContent = name;
    const s = r.querySelector(".st"); s.textContent = sub; if (subCls) s.classList.add(subCls);
    return r;
  }
  function btn(row, label, cls, fn, disabled) {
    const b = document.createElement("button");
    b.className = "btn " + (cls || ""); b.textContent = label; b.disabled = !!disabled;
    b.addEventListener("click", e => { e.stopPropagation(); fn(); });
    row.querySelector(".acts").appendChild(b);
  }

  function renderBundles() {
    const box = $("upd-bundles"); box.replaceChildren();
    for (const b of bundles) {
      const name = T("upd.kind." + b.kind, { name: b.kind === "map" ? b.region : (b.edition || "") });
      const bits = [];
      if (b.kind === "map" && b.osm) bits.push(T("upd.osm", { osm: b.osm }));
      if (b.kind === "app" && b.built) bits.push(b.built.slice(0, 16).replace("T", " "));
      bits.push(gb(b.total), b.via === "url" ? T("upd.from.url", { where: b.where }) : T("upd.from.usb", { where: b.where || "/" }));
      const cur = b.current && (b.current.osm || b.current.built);
      const state = T("upd.state." + b.state) + (cur ? " (" + T("upd.cur", { d: (b.current.osm || b.current.built).slice(0, 10) }) + ")" : "");
      const row = mkRow(name, bits.join(" · ") + "\n" + state, b.state === "new" ? "ok" : (b.state === "hardware" ? "err" : ""));
      row.querySelector(".st").style.whiteSpace = "pre-line";
      btn(row, b.state === "new" ? T("upd.install") : T("upd.installAgain"), b.state === "new" ? "primary on" : "ghost", () => install(b), blocked() || b.state === "hardware");
      box.appendChild(row);
    }
  }

  async function check() {
    if (checking) return;
    checking = true; $("upd-check").disabled = true;
    $("upd-msg").textContent = T("upd.checking"); $("upd-msg").className = "hint";
    const url = $("upd-url").value.trim();
    const r = await post("scan", url !== (st && st.url || "") ? { url } : {});
    checking = false; $("upd-check").disabled = false;
    if (r.ok === false) { $("upd-msg").textContent = errText(r); $("upd-msg").className = "hint warn"; bundles = []; renderBundles(); return; }
    bundles = r.bundles || [];
    const errs = (r.errors || []).map(e => T("upd.err." + e.error) + " (" + e.source + ")");
    $("upd-msg").className = "hint" + (errs.length && !bundles.length ? " warn" : "");
    $("upd-msg").textContent = bundles.length ? errs.join(" · ") : (errs.length ? errs.join(" · ") : T("upd.nothing"));
    renderBundles();
  }

  async function install(b) {
    const need = gb(b.plan.need), free = gb(b.plan.free), name = T("upd.kind." + b.kind, { name: b.kind === "map" ? b.region : (b.edition || "") });
    let mode = "side", confirm = false;
    if (b.kind === "app") {
      if (!await dialog(T("upd.ask", { name }), T("upd.ask.app"), T("upd.install"), { safe: true })) return;
    } else if (b.plan.fits === "side") {
      if (!await dialog(T("upd.ask", { name }), T("upd.ask.side", { need, free }), T("upd.install"), { safe: true })) return;
    } else if (b.plan.fits === "replace") {
      if (!await dialog(T("upd.ask", { name }), T("upd.ask.space", { need, free }) + "\n\n" + T("upd.ask.replace"), T("upd.ask.replaceYes"))) return;
      mode = "replace"; confirm = true;
    } else { await dialog(T("upd.ask", { name }), T("upd.ask.space", { need, free }) + "\n\n" + T("upd.ask.none"), null); return; }
    const r = await post("start", withGuard({ id: b.id, mode, confirm }));
    if (r.ok === false) { U.toast(errText(r), 5000); return; }
    handledDone = false; poll(true);
  }

  function renderJob() {
    const j = st.job || {}, box = $("upd-job"), bar = $("upd-bar"), bb = $("upd-job-b");
    bb.replaceChildren();
    const add = (label, cls, fn) => { const b = document.createElement("button"); b.className = "btn " + cls; b.textContent = label; b.addEventListener("click", fn); bb.appendChild(b); };
    box.hidden = !["running", "ready", "switching", "failed", "cancelled"].includes(j.state);
    if (box.hidden) return;
    let pct = j.total ? Math.min(100, Math.round(100 * (j.done || 0) / j.total)) : 0, txt = "";
    if (j.state === "running") {
      txt = T(j.phase === "verify" ? "upd.verifying" : "upd.copying", { n: j.file_i || 1, m: j.files || 1, name: j.file || "" }) + " — " + pct + " %";
      add(T("upd.cancel"), "ghost", () => post("cancel", {}));
    } else if (j.state === "ready") {
      pct = 100;
      txt = T(j.kind === "app" ? "upd.readyApp" : "upd.ready");
      add(T(j.kind === "app" ? "upd.applyApp" : "upd.switch"), "primary", async () => {
        const r = await post(j.kind === "app" ? "apply-app" : "switch", withGuard({}));
        if (r.ok === false) U.toast(errText(r), 5000); else { handledDone = true; sessionStorage.setItem("navpi.updDone", String(j.started)); waitReload(); }
      });
      $("upd-job-b").lastChild.disabled = blocked();
    } else if (j.state === "switching") { pct = 100; txt = T("upd.done"); }
    else if (j.state === "failed") { pct = 0; txt = errText({ error: j.error, msg: j.msg }); }
    else { pct = 0; txt = T("upd.cancelled"); }
    box.querySelector("#upd-job-t").textContent = txt;
    bar.style.width = pct + "%";
  }

  function renderRegions() {
    const box = $("upd-regions"); box.replaceChildren();
    const cur = (st.regions || []).find(r => r.current);
    $("upd-installed").textContent = cur ? T("upd.installed", { region: cur.region, osm: cur.osm || "?" }) : T("upd.none");
    for (const r of st.regions || []) {
      const tags = [r.current ? T("upd.current") : "", r.previous ? T("upd.previous") : ""].filter(Boolean);
      const row = mkRow(r.region + " · " + (r.osm || r.built || "?"), [r.name, gb(r.size)].concat(tags).join(" · "), r.current ? "ok" : "");
      if (!r.current) btn(row, T("upd.delete"), "ghost danger", async () => {
        if (await dialog(T("upd.deleteAsk", { name: r.name }), "", T("upd.delete"))) {
          const x = await post("delete", { name: r.name });
          if (x.ok === false) U.toast(errText(x), 4000); else U.toast(T("upd.deleted"), 2500);
          poll(true);
        }
      });
      box.appendChild(row);
    }
    const rb = $("upd-rollback");
    rb.hidden = !st.previous; rb.disabled = blocked() || (st.job && ["running", "switching"].includes(st.job.state));
  }

  function renderOs() {
    const o = st.os || {}, log = $("upd-os-log");
    $("upd-os").disabled = blocked() || o.state === "running";
    const t = o.state === "running" ? T("upd.os.running") : o.state === "done" ? T("upd.os.done") : o.state === "failed" ? T("upd.os.failed") : "";
    $("upd-os-t").textContent = t + (o.reboot && o.state === "done" ? " " + T("upd.os.reboot") : "");
    log.hidden = !o.log || o.state === "idle";
    if (!log.hidden) { log.textContent = o.log; log.scrollTop = log.scrollHeight; }
  }

  function render() {
    $("upd-parked").hidden = !blocked();
    $("upd-check").disabled = checking;
    document.querySelectorAll("#upd-bundles .btn").forEach(b => { if (blocked()) b.disabled = true; });
    if (document.activeElement !== $("upd-url") && !$("upd-url").dataset.edited) $("upd-url").value = st.url || "";
    renderJob(); renderRegions(); renderOs();
    const j = st.job || {};
    if (j.state === "done" && !handledDone && sessionStorage.getItem("navpi.updDone") !== String(j.started)) {   // once per update (navd keeps the finished job until it restarts)
      handledDone = true; sessionStorage.setItem("navpi.updDone", String(j.started)); U.toast(T("upd.done"), 6000); waitReload();
    }
  }

  async function waitReload() {   // navd restarts itself after a switch / app update: reload once it answers again
    await new Promise(r => setTimeout(r, 4000));
    for (let i = 0; i < 90; i++) {
      try { const r = await fetch("/api/update/state", { cache: "no-store" }); if (r.ok) { const j = await r.json(); if (!j.job || j.job.state !== "switching") { location.reload(); return; } } } catch (e) { /* restarting */ }
      await new Promise(r => setTimeout(r, 2000));
    }
  }

  async function poll(once) {
    clearTimeout(timer);
    try { st = await U.api("/api/update/state"); if (openNow) render(); } catch (e) { /* navd restarting */ }
    if (!once && openNow) {
      const busy = st && ((st.job && st.job.state === "running") || (st.os && st.os.state === "running"));
      timer = setTimeout(poll, busy ? 1000 : 5000);
    } else if (once && openNow) timer = setTimeout(poll, 1000);
  }

  function bind() {
    bound = true;
    const kb = () => Keyboard.show($("upd-url"), () => { $("upd-url").dataset.edited = "1"; }, () => { Keyboard.hide(); $("settings").classList.remove("kb"); }, "OK");
    $("upd-url").addEventListener("click", () => { $("settings").classList.add("kb"); kb(); });
    $("upd-check").addEventListener("click", () => { Keyboard.hide(); $("settings").classList.remove("kb"); check(); });
    $("upd-rollback").addEventListener("click", async () => {
      if (!await dialog(T("upd.rollback"), T("upd.rollbackAsk"), T("upd.rollback"))) return;
      const r = await post("rollback", withGuard({}));
      if (r.ok === false) U.toast(errText(r), 5000); else { U.toast(T("upd.rolled"), 4000); waitReload(); }
    });
    $("upd-os").addEventListener("click", async () => {
      if (!await dialog(T("upd.os.start"), T("upd.os.ask"), T("upd.os.start"), { safe: true })) return;
      const r = await post("os/start", withGuard({}));
      if (r.ok === false) U.toast(errText(r), 5000); else poll(true);
    });
  }

  Settings.section({
    cat: "system",
    open() { if (!bound) bind(); openNow = true; delete $("upd-url").dataset.edited; poll(); },
    close() { openNow = false; clearTimeout(timer); Keyboard.hide(); $("settings").classList.remove("kb"); },
    relang() { if (st) { render(); renderBundles(); } },
  });
})();
