/* usb feature: USB sticks in Settings (navd /api/usb/*) — list with free space, open / eject, import audio into the
   media library. Toasts when a stick appears or goes (polled in every screen; 3 s, 1 s while copying). */
"use strict";
(() => {
  const $ = id => document.getElementById(id);
  const DEST = ["Music", "Audiobooks", "Podcasts"];
  let last = null, seen = null, timer = null, open = false, imp = null, wasJob = "idle", gone = new Set();
  const size = b => b == null ? "?" : b >= 1e9 ? (b / 1e9).toFixed(b >= 1e10 ? 0 : 1) + " GB" : Math.max(1, Math.round(b / 1e6)) + " MB";
  const fsName = f => ({ vfat: "FAT32", exfat: "exFAT", ntfs: "NTFS" })[f] || f;
  const media = () => last && last.media;
  async function post(path, body) {
    try { return await U.api("/api/usb/" + path, body || {}); }
    catch (e) { return { ok: false, error: e.message }; }
  }
  function row(s) {
    const b = document.createElement("div"); b.className = "row";
    b.innerHTML = '<svg class="i"><use href="#i-usb"/></svg><div class="main"><div class="n"></div><div class="st"></div></div><div class="acts"></div>';
    b.querySelector(".n").textContent = s.label;
    const st = b.querySelector(".st");
    const head = fsName(s.fs) + " · ";
    if (!s.supported) { st.textContent = head + T("usb.unsupported"); st.classList.add("err"); }
    else if (s.mounted) { st.textContent = head + T("usb.free", { free: size(s.free), total: size(s.total) }) + (s.writable ? "" : " · " + T("usb.ro")); st.classList.add("on"); }
    else if (s.error) { st.textContent = head + T("usb.err." + s.error); st.classList.add("err"); }
    else st.textContent = head + T("usb.notMounted");
    const acts = b.querySelector(".acts");
    const btn = (html, cls, fn) => { const x = document.createElement("button"); x.className = "btn " + cls; x.innerHTML = html;
      x.addEventListener("click", e => { e.stopPropagation(); fn(); }); acts.appendChild(x); };
    const running = last.job && last.job.state === "running";
    if (s.mounted && media() && !running) btn(T("usb.import"), "primary", () => scan(s));
    if (!s.mounted && s.supported) btn(T("usb.mount"), "primary", async () => { const r = await post("mount", { id: s.id }); if (!r.ok) U.toast(T("usb.err." + (r.error === "denied" ? "denied" : "failed")), 3500); refresh(); });
    btn('<svg class="i"><use href="#i-eject"/></svg>' + T("usb.eject"), "ghost", () => eject(s));
    return b;
  }
  async function eject(s) {
    const r = await post("eject", { id: s.id });
    if (r.ok) { gone.add(s.id); U.toast(T("usb.ejected", { label: s.label }), 3500); if (imp && imp.id === s.id) imp = null; }
    else U.toast(T(r.error === "busy" ? "usb.busy" : "failed", { msg: r.error }), 3500);
    seen = null; refresh();
  }
  async function scan(s) {
    imp = { id: s.id, label: s.label, folders: null }; render(last);
    const r = await post("scan", { id: s.id });
    if (!imp || imp.id !== s.id) return;
    if (!r.ok) { imp = null; U.toast(T("failed", { msg: r.error }), 3500); render(last); return; }
    imp.folders = r.folders.map(f => ({ ...f, pick: f.dest })); render(last);
  }
  function renderImp() {
    const box = $("usb-imp"), j = last.job || {};
    box.innerHTML = "";
    if (j.state === "running") {
      box.hidden = false;
      const pct = j.total ? Math.min(100, Math.round(100 * j.done / j.total)) : 0;
      box.innerHTML = '<div class="hint"></div><div class="usb-bar"><div></div></div><div class="qrow"><button class="btn ghost"></button></div>';
      box.querySelector(".hint").textContent = j.files ? T("usb.progress", { n: Math.min(j.files, j.files_done + 1), m: j.files, name: j.current }) : T("usb.preparing");
      box.querySelector(".usb-bar div").style.width = pct + "%";
      const c = box.querySelector("button"); c.textContent = T("usb.cancel"); c.addEventListener("click", () => post("cancel"));
      return;
    }
    if (!imp) { box.hidden = true; return; }
    box.hidden = false;
    if (!imp.folders) { box.innerHTML = '<div class="hint"></div>'; box.firstChild.textContent = T("usb.scanning"); return; }
    if (!imp.folders.length) {
      box.innerHTML = '<div class="hint"></div><div class="qrow"><button class="btn ghost"></button></div>';
      box.querySelector(".hint").textContent = T("usb.noAudio");
      const c = box.querySelector("button"); c.textContent = T("cancel"); c.addEventListener("click", () => { imp = null; render(last); });
      return;
    }
    const h = document.createElement("div"); h.className = "hint"; h.textContent = T("usb.pick"); box.appendChild(h);
    for (const f of imp.folders) {
      const d = document.createElement("div"); d.className = "usb-f";
      d.innerHTML = '<div class="n"></div><div class="c"></div><div class="usb-dest"></div>';
      d.querySelector(".n").textContent = f.name || T("usb.rootFiles");
      d.querySelector(".c").textContent = T("usb.files", { n: f.count, size: size(f.size) });
      const seg = d.querySelector(".usb-dest");
      for (const o of DEST.concat([""])) {
        const b = document.createElement("button"); b.textContent = o ? T("dest." + o) : T("usb.skip");
        b.classList.toggle("on", f.pick === o);
        b.addEventListener("click", () => { f.pick = o; renderImp(); }); seg.appendChild(b);
      }
      box.appendChild(d);
    }
    const q = document.createElement("div"); q.className = "qrow";
    q.innerHTML = '<button class="btn primary"></button><button class="btn ghost"></button>';
    const go = q.children[0], no = q.children[1];
    go.textContent = T("usb.start"); no.textContent = T("cancel");
    go.disabled = !imp.folders.some(f => f.pick);
    go.addEventListener("click", async () => {
      const items = imp.folders.filter(f => f.pick).map(f => ({ folder: f.name, dest: f.pick }));
      const r = await post("import", { id: imp.id, items });
      if (!r.ok) { U.toast(T(r.error === "busy" ? "usb.busy" : "usb.err.bad"), 3500); return; }
      wasJob = "running"; imp = null; refresh();
    });
    no.addEventListener("click", () => { imp = null; render(last); });
    box.appendChild(q);
  }
  function render(st) {
    last = st;
    if (!$("usb-card")) return;
    $("usb-card").hidden = !st.present || (!st.sticks.length && !open);
    if (!st.present) return;
    const l = $("usb-list"); l.innerHTML = "";
    if (!st.sticks.length) { const h = document.createElement("div"); h.className = "hint"; h.textContent = T("usb.none"); l.appendChild(h); }
    for (const s of st.sticks) l.appendChild(row(s));
    renderImp();
  }
  function toasts(st) {
    const now = new Map(st.sticks.map(s => [s.id, s]));
    if (seen) {
      for (const [id, s] of now) if (!seen.has(id)) U.toast(T("usb.in", { label: s.label }), 3500);
      for (const [id, s] of seen) if (!now.has(id) && !gone.delete(id)) U.toast(T("usb.out", { label: s.label }), 3500);
    }
    seen = now;
    const j = st.job || {};
    if (wasJob === "running" && j.state === "done") {
      U.toast(T("usb.done", { n: j.copied, skipped: j.skipped }), 4500);
      document.dispatchEvent(new CustomEvent("usb:imported"));   // the media library re-reads its folders
    }
    if (wasJob === "running" && j.state === "failed") U.toast(T("usb.err." + (j.error || "failed")), 4500);
    if (wasJob === "running" && j.state === "cancelled") U.toast(T("usb.cancelled"), 3000);
    wasJob = j.state;
  }
  async function refresh() {
    let st;
    try { st = await U.api("/api/usb/state"); } catch (e) { return; }   // navd restarting
    if (!st.present) { if ($("usb-card")) $("usb-card").hidden = true; clearTimeout(timer); return; }
    toasts(st); render(st);
    schedule();
  }
  function schedule() {
    clearTimeout(timer);
    timer = setTimeout(refresh, last && last.job && last.job.state === "running" ? 1000 : 3000);
  }
  Settings.section({
    cat: "connect",
    open() { open = true; refresh(); },
    close() { open = false; imp = null; if (last) render(last); },
    relang() { if (last) render(last); },
  });
  refresh();
})();
