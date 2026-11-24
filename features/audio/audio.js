/* audio feature: output device, volume, voice test (navd /api/audio, PipeWire). */
"use strict";
(() => {
  const $ = id => document.getElementById(id);
  let audio = { volume: 0.5 }, bound = false, timer = null;
  async function refresh() {
    try {
      const a = await U.api("/api/audio");
      const out = !a.output || /dummy/i.test(a.output) ? T("sound.none") : a.output;
      const v = a.volume == null ? 0 : Math.round(a.volume * 100), pct = a.volume == null ? "–" : v + " %";
      if ($("au-out")) { $("au-out").textContent = out; $("vol-bar").style.width = v + "%"; $("vol-pct").textContent = pct; }
      audio = a;
    } catch (e) { /* ignore */ }
  }
  async function setVol(d) {
    const v = Math.max(0, Math.min(1, Math.round(((audio.volume || 0) + d) * 10) / 10));
    try { audio = await U.api("/api/audio", { volume: v }); } catch (e) { /* ignore */ }
    refresh();
  }
  function bind() {
    bound = true;
    if ($("vol-up")) {
      $("vol-up").addEventListener("click", () => setVol(+0.1));
      $("vol-down").addEventListener("click", () => setVol(-0.1));
    }
    if ($("au-test")) $("au-test").addEventListener("click", () => U.api("/api/speak", { text: T("sound.testText"), lang: LANG, cue: ["in_300m", "turn_right"] }).catch(() => {}));
  }
  Settings.section({
    cat: "sound",
    open() { if (!bound) bind(); refresh(); clearInterval(timer); timer = setInterval(refresh, 3000); },
    close() { clearInterval(timer); timer = null; },
    relang: refresh,
  });
})();
