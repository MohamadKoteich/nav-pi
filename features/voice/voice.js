/* nav-pi voice prompt options (PN-48): mute, style (full / short), all turns or major ones only. Kept on this
   device (U.store "voiceOpts"). Mute is applied here by wrapping U.speak, so every spoken navigation prompt
   (turns, "Let's go", "Recalculating") goes quiet - recorded voice pack and espeak-ng alike, because both sit
   behind the one /api/speak call. Not muted: "Test voice" in Sound settings and the over-speed chime (it has its
   own setting). Style and "major only" are read by guidance.js (Guidance.voice, isMajor). */
"use strict";
const VoiceOpts = (() => {
  const DEF = { mute: false, style: "full", turns: "all" };
  const get = () => Object.assign({}, DEF, U.store.get("voiceOpts", {}));
  function set(k, v) {
    const o = get(); o[k] = v; U.store.set("voiceOpts", o);
    mark();
    window.dispatchEvent(new CustomEvent("navpi:voice", { detail: o }));
  }
  const speak = U.speak;
  U.speak = (text, cue) => (get().mute ? undefined : speak(text, cue));

  function mark() {
    const o = get();
    document.querySelectorAll("#vo-style button").forEach(b => b.classList.toggle("on", b.dataset.style === o.style));
    document.querySelectorAll("#vo-turns button").forEach(b => b.classList.toggle("on", b.dataset.turns === o.turns));
    const s = document.getElementById("vo-on"); if (s) s.setAttribute("aria-checked", String(!o.mute));
    ["vo-style", "vo-turns"].forEach(id => { const e = document.getElementById(id); if (e) e.classList.toggle("dim", o.mute); });
  }
  let bound = false;
  function bind() {
    bound = true;
    const s = document.getElementById("vo-on"); if (s) s.addEventListener("click", () => set("mute", !get().mute));
    document.querySelectorAll("#vo-style button").forEach(b => b.addEventListener("click", () => set("style", b.dataset.style)));
    document.querySelectorAll("#vo-turns button").forEach(b => b.addEventListener("click", () => set("turns", b.dataset.turns)));
  }
  const open = () => { if (!bound) bind(); mark(); };
  if (typeof Settings !== "undefined") Settings.section({ open, relang: mark });
  if (typeof Shell !== "undefined") Shell.onLang(mark);
  return { get, set };
})();
