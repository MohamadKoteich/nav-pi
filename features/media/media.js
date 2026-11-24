/* media feature: one "Media" tab — phone over Bluetooth, local Music, Audiobooks, Podcasts.
   Local files play in the browser (<audio>) through the Pi's default output (e.g. the Bluetooth speaker);
   audiobooks/podcasts resume where they stopped; music ducks while the navigation voice speaks. */
"use strict";
(() => {
  const $ = id => document.getElementById(id);
  const HAS_BT = window.EDITION && EDITION.features.includes("bluetooth");
  const RESUME = { Audiobooks: true, Podcasts: true };
  let src = U.store.get("media.src", HAS_BT ? "Phone" : "Music"), path = "";
  let q = null;                       // {src, folder, files:[{name,path}], idx}
  const audio = new Audio(); audio.preload = "auto";
  // reader-core's player rules (vendored, see vendor/reader-core/VENDORED.md): speeds, skip,
  // rewind-on-resume, chapter restart, sleep timer, MediaSession actions.
  let R = null, S = null, sleep = null;
  import("./vendor/reader-core/player-rules.js").then(m => { R = m; });
  import("./vendor/reader-core/sleep-timer.js").then(m => { S = m; });
  const SLEEP_RING = ["off", "15", "30", "60", "chapter"];
  let phoneTimer = null, phoneState = null, visibleUntil = 0, bound = false;

  const fmt = s => { s = Math.max(0, Math.floor(s || 0)); const h = Math.floor(s / 3600), m = Math.floor(s / 60) % 60, x = s % 60;
    return (h ? h + ":" + String(m).padStart(2, "0") : m) + ":" + String(x).padStart(2, "0"); };
  const fileUrl = (s, p) => "/api/media/file/" + encodeURIComponent(s) + "/" + p.split("/").map(encodeURIComponent).join("/");
  const posKey = (s, folder) => "pos." + s + "/" + folder;

  // ---------- sources ----------
  function setSrc(s) {
    src = s; path = ""; U.store.set("media.src", s);
    document.querySelectorAll(".srcs button").forEach(b => b.classList.toggle("on", b.dataset.src === s));
    clearInterval(phoneTimer); phoneTimer = null;
    if (s === "Phone") { renderPhone(); phoneTimer = setInterval(renderPhone, 2000); } else browse();
  }
  function row(icon, name, sub, onClick, cls) {
    const b = document.createElement("button"); b.className = "row" + (cls ? " " + cls : "");
    b.innerHTML = `<svg class="i"><use href="#${icon}"/></svg><div class="main"><div class="n"></div><div class="c"></div></div>`;
    b.querySelector(".n").textContent = name; b.querySelector(".c").textContent = sub || "";
    b.addEventListener("click", onClick); return b;
  }
  function msg(text) { const d = document.createElement("div"); d.className = "card"; d.innerHTML = '<div class="big-msg"></div>';
    d.querySelector(".big-msg").textContent = text; return d; }

  // ---------- local library ----------
  let browseSeq = 0;
  async function browse() {
    const box = $("m-body"), mySrc = src, myPath = path, seq = ++browseSeq;
    let r;
    try { r = await U.api(`/api/media/list?src=${encodeURIComponent(src)}&path=${encodeURIComponent(path)}`); }
    catch (e) { box.innerHTML = ""; box.appendChild(msg(T("media.error"))); return; }
    if (seq !== browseSeq || mySrc !== src || myPath !== path) return;   // a newer request owns the list
    box.innerHTML = "";
    if (path) box.appendChild(row("i-back", T("back"), path, () => { path = path.split("/").slice(0, -1).join("/"); browse(); }));
    if (RESUME[src] && path) {
      const saved = U.store.get(posKey(src, path), null);
      if (saved && r.files.some(f => f.path === saved.file))
        box.appendChild(row("i-play", T("media.continue"), r.files.find(f => f.path === saved.file).name + " · " + fmt(saved.t),
          () => play(r.files, r.files.findIndex(f => f.path === saved.file),
            Math.max(0, saved.t - (R ? R.rewindSecondsFor(Date.now() - (saved.at || Date.now()), true) : 0))), "playing"));
    }
    for (const d of r.dirs) box.appendChild(row(RESUME[src] ? "i-book" : "i-folder", d.name, T("media.items", { n: d.count }), () => { path = d.path; browse(); }));
    r.files.forEach((f, i) => box.appendChild(row("i-play", f.name, "", () => play(r.files, i, 0),
      q && q.src === src && q.files[q.idx] && q.files[q.idx].path === f.path ? "playing" : "")));
    if (!r.dirs.length && !r.files.length) box.appendChild(msg(T("media.empty", { folder: src })));
  }
  function play(files, idx, at) {
    stopPhone();
    q = { src, folder: path, files, idx };
    audio.src = fileUrl(src, files[idx].path);
    audio.currentTime = 0;
    audio.addEventListener("loadedmetadata", () => { if (at) audio.currentTime = at; }, { once: true });
    audio.play().catch(() => {});
    $("m-player").hidden = false;
    $("p-rew").hidden = $("p-fwd").hidden = !RESUME[src];
    document.querySelector(".p-opts").hidden = !RESUME[src];
    audio.playbackRate = RESUME[src] ? (R ? R.clampAudioSpeed(U.store.get("speed." + src, 1)) : 1) : 1;
    $("p-speed").textContent = audio.playbackRate + "×";
    mediaSession();
    showInfo(); browseMark();
  }
  function browseMark() { if (src !== "Phone") document.querySelectorAll("#m-body .row").forEach(r => r.classList.remove("playing")); }
  function showInfo() {
    if (!q) return;
    const f = q.files[q.idx];
    $("p-title").textContent = f.name;
    $("p-sub").textContent = [T("src." + ({ Music: "music", Audiobooks: "books", Podcasts: "podcasts" })[q.src]), q.folder].filter(Boolean).join(" · ");
    Shell.nowPlaying({ title: f.name, playing: !audio.paused, toggle });
  }
  function toggle() {
    if (phoneState && phoneState.connected && (!q || audio.paused)) return phoneCmd(phoneState.status === "playing" ? "pause" : "play");
    if (!q) return;
    audio.paused ? audio.play().catch(() => {}) : audio.pause();
  }
  function step(d) {
    if (phoneState && phoneState.connected && (!q || audio.paused)) return phoneCmd(d > 0 ? "next" : "previous");
    localStep(d);
  }
  window.Media = { toggle, next: () => step(1) };   // dashboard card (PN-47)
  function localStep(d) {
    if (!q) return;
    let i = q.idx + d;
    if (d < 0) {
      const t = R ? R.previousChapterTarget(q.idx, audio.currentTime) : { index: q.idx - 1, restart: audio.currentTime > 3 };
      if (t.restart || t.index < 0) { audio.currentTime = 0; return; }
      i = t.index;
    }
    if (i < 0 || i >= q.files.length) return;
    q.idx = i; audio.src = fileUrl(q.src, q.files[i].path); audio.play().catch(() => {}); showInfo();
  }
  function savePos() { if (q && RESUME[q.src] && audio.currentTime > 3) U.store.set(posKey(q.src, q.folder), { file: q.files[q.idx].path, t: audio.currentTime, at: Date.now() }); }
  audio.addEventListener("ended", () => {   // next file saves its own position; a finished book forgets its spot
    if (q && q.idx + 1 < q.files.length) localStep(+1);
    else if (q && RESUME[q.src]) U.store.set(posKey(q.src, q.folder), null);
  });
  audio.addEventListener("play", showInfo);
  audio.addEventListener("pause", () => { savePos(); showInfo(); });
  audio.addEventListener("timeupdate", () => {
    $("p-cur").textContent = fmt(audio.currentTime); $("p-dur").textContent = fmt(audio.duration);
    $("p-fill").style.width = (audio.duration ? 100 * audio.currentTime / audio.duration : 0) + "%";
    if (Math.floor(audio.currentTime) % 5 === 0) savePos();
    if (S && sleep && S.shouldStop(sleep, { now: Date.now(), position: audio.currentTime, chapterEnd: audio.duration })) {
      audio.pause(); sleep = null; sleepLabel();
    }
  });
  // navigation voice: lower the music while it speaks
  let duckT;
  window.addEventListener("navpi:speak", e => {
    if (audio.paused) return;
    audio.volume = 0.25; clearTimeout(duckT);
    duckT = setTimeout(() => { audio.volume = 1; }, 1500 + 75 * ((e.detail && e.detail.length) || 40));
  });

  function sleepLabel() {
    $("p-sleep-t").textContent = !sleep ? T("sleep.off") : sleep.mode === "chapter" ? T("sleep.chapter")
      : T("sleep.min", { n: Math.max(1, Math.round((sleep.until - Date.now()) / 60000)) });
  }
  setInterval(() => { if (sleep && sleep.mode === "duration") sleepLabel(); }, 30000);
  // lock-screen / Bluetooth media buttons (AVRCP from a speaker or the car) -> MediaSession
  function mediaSession() {
    const m = navigator.mediaSession; if (!m || !q) return;
    try { m.metadata = new MediaMetadata({ title: q.files[q.idx].name, album: q.folder || q.src, artist: "" }); } catch (e) { /* old browser */ }
    const h = { play: () => audio.play().catch(() => {}), pause: () => audio.pause(), previoustrack: () => localStep(-1), nexttrack: () => localStep(+1),
      seekbackward: () => { audio.currentTime = Math.max(0, audio.currentTime - (R ? R.SKIP_SECONDS_DEFAULT : 30)); },
      seekforward: () => { audio.currentTime = audio.currentTime + (R ? R.SKIP_SECONDS_DEFAULT : 30); },
      stop: () => audio.pause(), seekto: d => { if (d && typeof d.seekTime === "number") audio.currentTime = d.seekTime; } };
    for (const a of (R ? R.MEDIA_SESSION_ACTIONS : Object.keys(h))) { try { m.setActionHandler(a, h[a] || null); } catch (e) { /* unsupported */ } }
  }

  // ---------- phone over Bluetooth ----------
  function stopPhone() { if (phoneState && phoneState.connected && phoneState.status === "playing") phoneCmd("pause"); }
  async function phoneCmd(c) { try { await U.api("/api/media/phone/" + c, {}); } catch (e) { /* ignore */ } setTimeout(renderPhone, 400); }
  async function renderPhone() {
    if (src !== "Phone") return;
    const box = $("m-body");
    let p = { connected: false }, bt = null;
    try { p = await U.api("/api/media/phone"); } catch (e) { /* ignore */ }
    try { bt = HAS_BT ? await U.api("/api/bt") : null; } catch (e) { /* ignore */ }
    phoneState = p;
    if (src !== "Phone") return;   // the user switched source while we were waiting: do not wipe their list
    box.innerHTML = "";
    if (!HAS_BT) { box.appendChild(msg(T("phone.noBt"))); return; }
    if (p.connected) {
      const c = document.createElement("div"); c.className = "card";
      c.innerHTML = '<div class="qh"><svg class="i"><use href="#i-phone"/></svg><span class="dev"></span></div><div class="p-title t"></div><div class="p-sub a"></div><div class="p-ctl"></div>';
      c.querySelector(".dev").textContent = p.device || T("src.phone");
      c.querySelector(".t").textContent = p.title || T("phone.noTrack");
      c.querySelector(".a").textContent = [p.artist, p.album].filter(Boolean).join(" · ");
      const ctl = c.querySelector(".p-ctl");
      for (const [icon, cmd, big] of [["i-prev", "previous"], [p.status === "playing" ? "i-pause" : "i-play", p.status === "playing" ? "pause" : "play", 1], ["i-next", "next"]]) {
        const b = document.createElement("button"); b.className = "pc" + (big ? " big" : "");
        b.innerHTML = `<svg class="i"><use href="#${icon}"/></svg>`; b.addEventListener("click", () => { if (cmd === "play" && !audio.paused) audio.pause(); phoneCmd(cmd); });
        ctl.appendChild(b);
      }
      box.appendChild(c);
      if (!q || audio.paused) Shell.nowPlaying(p.title ? { title: p.title, playing: p.status === "playing", toggle } : null);
      return;
    }
    const phones = bt ? bt.devices.filter(d => d.paired && d.phone) : [];
    box.appendChild(msg(T("phone.how")));
    const vis = bt && bt.visible && Date.now() < visibleUntil + 5000;
    const v = document.createElement("button"); v.className = "btn primary wide";
    v.innerHTML = '<svg class="i"><use href="#i-bt"/></svg><span></span>';
    v.querySelector("span").textContent = vis ? T("phone.visibleNow", { s: Math.max(0, Math.round((visibleUntil - Date.now()) / 1000)) }) : T("phone.makeVisible");
    v.disabled = !!vis;
    v.addEventListener("click", async () => { try { await U.api("/api/bt/visible", { on: true }); visibleUntil = Date.now() + 180000; } catch (e) { U.toast(T("bt.powerFail")); } renderPhone(); });
    box.appendChild(v);
    for (const d of phones) box.appendChild(row("i-phone", d.name, d.connected ? T("bt.connected") : T("phone.connectFromPhone"), () => {}));
  }

  // ---------- wiring ----------
  document.addEventListener("usb:imported", () => { if (bound && src !== "Phone") browse(); });   // usb feature copied new files
  function bind() {
    bound = true;
    document.querySelectorAll(".srcs button").forEach(b => b.addEventListener("click", () => setSrc(b.dataset.src)));
    if (!HAS_BT) document.querySelector('.srcs [data-src="Phone"]').hidden = true;
    // the player card controls the local file only; the status-bar chip (toggle) also drives the phone
    $("p-play").addEventListener("click", () => { if (q) audio.paused ? audio.play().catch(() => {}) : audio.pause(); });
    $("p-next").addEventListener("click", () => localStep(+1));
    $("p-prev").addEventListener("click", () => localStep(-1));
    $("p-speed").addEventListener("click", () => {
      if (!R || !q) return;
      audio.playbackRate = R.nextAudioSpeed(audio.playbackRate, R.AUDIO_SPEEDS);
      U.store.set("speed." + q.src, audio.playbackRate); $("p-speed").textContent = audio.playbackRate + "×";
    });
    $("p-sleep").addEventListener("click", () => {
      if (!S) return;
      const cur = sleep ? (sleep.mode === "chapter" ? "chapter" : String(sleep.minutes)) : "off";
      const next = SLEEP_RING[(SLEEP_RING.indexOf(cur) + 1) % SLEEP_RING.length];
      sleep = next === "off" ? null : S.sleepTimerFrom(next, Date.now()); sleepLabel();
    });
    $("p-rew").addEventListener("click", () => { audio.currentTime = Math.max(0, audio.currentTime - 30); });
    $("p-fwd").addEventListener("click", () => { audio.currentTime = Math.min(audio.duration || 0, audio.currentTime + 30); });
    $("p-bar").addEventListener("click", e => { const r = e.currentTarget.getBoundingClientRect();
      if (audio.duration) audio.currentTime = audio.duration * (e.clientX - r.left) / r.width; });
    audio.addEventListener("play", () => { $("p-play").innerHTML = '<svg class="i"><use href="#i-pause"/></svg>'; });
    audio.addEventListener("pause", () => { $("p-play").innerHTML = '<svg class="i"><use href="#i-play"/></svg>'; });
  }
  Shell.view("media", {
    show() { if (!bound) bind(); if (src === "Phone" && !HAS_BT) src = "Music"; setSrc(src); },
    hide() { clearInterval(phoneTimer); phoneTimer = null; },
  });
  Shell.onLang(() => { if (bound) setSrc(src); showInfo(); });
})();
