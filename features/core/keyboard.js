/* On-screen keyboard for the kiosk (Chromium kiosk has no system keyboard): English QWERTY / German QWERTZ.
   PN-KBD-03 (compact and floating): a floating panel, docked bottom-centre
   and moved above / below the focused field so it never covers it. Three layouts, chosen ON the keyboard (options key,
   Material "tune" icon), never in Settings: "pad" letters + a number column on the right (default), "letters"
   letters only (digits on ?123 and by holding the top row, like Android), "wide" full width for big fingers; key size
   S / M / L. Both kept in localStorage (navpi.kbdLayout, navpi.kbdSize).
   Hold a key (450 ms) for its variants (accents, umlauts, ß, signs, the top row's digit): slide onto one and lift, or
   lift and tap one. A letter is typed when the finger lifts (so a hold can become a variant); Shift, Backspace, ?123
   act at once. Shift = one capital, tap Shift again = Caps Lock, a third tap = off (PN-KBD-01). "?123" opens the
   signs, "=\<" the second page of signs: together every ASCII sign a Wi-Fi password may hold.
   A USB keyboard types too: the field stays focusable (inputmode="none", never readonly), every native input is
   passed on like a key here, Enter = the last key (Search / Connect / OK), Escape closes. */
"use strict";
const Keyboard = (() => {
  const LAYOUT = {  // English QWERTY (default) / German QWERTZ (umlauts + ß as keys); en reaches äöüß by holding a/o/u/s
    en: ["qwertyuiop", "asdfghjkl'", "zxcvbnm-"],
    de: ["qwertzuiopü", "asdfghjklöä", "yxcvbnmß-"],
  };
  const PAD = ["789", "456", "123", ",0."];
  const SIGNS = {
    sym: ["1234567890", "-/:;()€&@\"", ".,?!'*+"],
    sym2: ["[]{}#%^$£=", "_\\|~<>°§µ`", ".,?!'*+"],
  };
  const ACC = {   // variants on hold (lower case; Shift/Caps make them capitals)
    a: "äàáâæãå", e: "éèêëē", i: "íìîï", o: "öóòôøœõ", u: "üúùû", y: "ýÿ", s: "ßśš", c: "çčć", n: "ñń", z: "žźż",
    l: "ł", "ü": "u", "ö": "o", "ä": "a", "ß": "s",
    "-": "–_—·", "'": "\"`´’‘", ".": "…:;", ",": ";:", "?": "¿", "!": "¡", "€": "$£¥¢", "&": "§", "(": "[{<", ")": "]}>",
    "/": "\\|", "@": "#", "*": "×÷", "+": "±", "0": "°", "1": "¹½", "2": "²", "3": "³", "\"": "„“”«»",
  };
  const TOP_DIGIT = "1234567890";   // the top letter row: hold = its digit first (q=1 ... p=0)
  const SIZES = { S: [46, 48], M: [54, 54], L: [64, 62] };   // key width / height px on the glass at UI scale <= 1 (see render)
  // On the glass (after the UI scale) a key is never narrower than 44 px nor lower than 48 px (2026-11-22 integration:
  // at scale 0.8 a 54 px key was 43 px). A layout that does not fit the window at that size steps down, see FITS.
  const GLASS_W = 44, GLASS_H = 48;
  const DE10 = ["qwertzuiop", "asdfghjkl'", "yxcvbnm-"];   // German on a window too narrow for 11 keys: äöüß by holding a/o/u/s
  const FITS = {   // tried in order until the panel fits the window; the last one is used anyway
    pad: [{ dig: "col" }, { dig: "row" }, { dig: "row", tight: 1 }, { dig: "hint", tight: 1 }, { dig: "hint", tight: 1, de10: 1 }],
    letters: [{ dig: "hint" }, { dig: "hint", tight: 1 }, { dig: "hint", tight: 1, de10: 1 }],
    wide: [{ dig: "row" }, { dig: "row", tight: 1 }, { dig: "hint", tight: 1 }, { dig: "hint", tight: 1, de10: 1 }],
  };
  const LAYOUTS = ["pad", "letters", "wide"];
  const HOLD_MS = 450, REPEAT_WAIT = 450, REPEAT_MS = 70;
  const SVG = (d, s = 26) => `<svg viewBox="0 0 24 24" width="${s}" height="${s}" aria-hidden="true"><path fill="currentColor" d="${d}"/></svg>`;
  const ICON = {   // Material shapes (no Apple modifier glyphs)
    shift: SVG("M12 3 3 13h5v7h8v-7h5L12 3Zm0 2.8L16.6 11H14v7h-4v-7H7.4L12 5.8Z"),
    shiftOn: SVG("M12 3 3 13h5v7h8v-7h5L12 3Z"),
    caps: SVG("M12 3 3 12h5v5h8v-5h5L12 3ZM8 19h8v2H8z"),
    back: SVG("M22 3H7c-.69 0-1.23.35-1.59.88L0 12l5.41 8.11c.36.53.9.89 1.59.89h15c1.1 0 2-.9 2-2V5c0-1.1-.9-2-2-2zm0 16H7.07L2.4 12l4.66-7H22v14zm-11.59-2L14 13.41 17.59 17 19 15.59 15.41 12 19 8.41 17.59 7 14 10.59 10.41 7 9 8.41 12.59 12 9 15.59z"),
    opts: SVG("M3 17v2h6v-2H3zM3 5v2h10V5H3zm10 16v-2h8v-2h-8v-2h-2v6h2zM7 9v2H3v2h4v2h2V9H7zm14 4v-2H11v2h10zm-6-4h2V7h4V5h-4V3h-2v6z"),   // tune
    hide: SVG("M20 3H4c-1.1 0-1.99.9-1.99 2L2 15c0 1.1.9 2 2 2h16c1.1 0 2-.9 2-2V5c0-1.1-.9-2-2-2zm-9 3h2v2h-2V6zm0 3h2v2h-2V9zM8 6h2v2H8V6zm0 3h2v2H8V9zm-1 2H5V9h2v2zm0-3H5V6h2v2zm9 7H8v-2h8v2zm0-4h-2V9h2v2zm0-3h-2V6h2v2zm3 3h-2V9h2v2zm0-3h-2V6h2v2zm-7 15 4-4H8l4 4z"),
  };
  const tx = k => (typeof T === "function" ? T(k) : k);
  let layer = "abc", shift = false, caps = false, menu = false;
  let layout = "pad", size = "M", fit = FITS.pad[0];
  let el, keysEl, pop, input, onChange, onDone, doneLabel = null, hold = null, scrolled = false, squeezed = null;
  // UI scale (features/core/scale.js): getBoundingClientRect / innerWidth are screen px, style + offset px are UI px
  const scale = () => (window.UiScale && UiScale.value()) || 1;

  function loadPrefs() {
    const l = U.store.get("kbdLayout", "pad"), s = U.store.get("kbdSize", "M");
    layout = LAYOUTS.includes(l) ? l : "pad"; size = SIZES[s] ? s : "M";
  }
  const upper = c => { const u = c.toUpperCase(); return u.length === 1 ? u : c; };   // "ß" stays "ß"
  const cased = c => (layer === "abc" && shift ? upper(c) : c);

  // ---- keys: a character key types on lift (a hold may turn into a variant); an action key acts on press ----
  function charKey(ch, cls, variants) {
    const b = document.createElement("button");
    b.type = "button"; b.tabIndex = -1; b.className = "k" + (cls ? " " + cls : "");
    b.textContent = cased(ch); b.dataset.ch = ch;
    if (variants) { b.dataset.var = variants; b.classList.add("hv"); }
    return b;
  }
  function actKey(label, cls, act, aria, repeat) {
    const b = document.createElement("button");
    b.type = "button"; b.tabIndex = -1; b.className = "k" + (cls ? " " + cls : "");
    if (label.startsWith("<svg")) b.innerHTML = label; else b.textContent = label;
    if (aria) { b.setAttribute("aria-label", aria); b.title = aria; }
    b._act = act; if (repeat) b._repeat = true;
    return b;
  }
  function variantsOf(ch, rowTop, i) {
    let v = ACC[ch] || "";
    if (rowTop && i < TOP_DIGIT.length) v = TOP_DIGIT[i] + v;
    return v;
  }

  function type(ch) {
    const a = input.selectionStart, z = input.selectionEnd;
    if (a == null || document.activeElement !== input) input.value += ch;
    else input.setRangeText(ch, a, z, "end");
    if (shift && !caps && layer === "abc") { shift = false; render(); }
    onChange(input.value);
  }
  function back() {
    const a = input.selectionStart, z = input.selectionEnd;
    if (a == null || document.activeElement !== input) input.value = input.value.slice(0, -1);
    else if (a !== z) input.setRangeText("", a, z, "end");
    else if (a > 0) input.setRangeText("", a - 1, a, "end");
    onChange(input.value);
  }
  function tapShift() {   // off -> one capital -> Caps Lock -> off
    if (!shift) shift = true; else if (!caps) caps = true; else shift = caps = false;
    render();
  }

  function row(...keys) { const r = document.createElement("div"); r.className = "r"; keys.forEach(k => r.appendChild(k)); return r; }
  function render() {
    el = document.getElementById("kbd");
    closePop();
    // S/M/L are glass px on screens up to the 720 px base and grow with the scale above it; four letter rows stay within
    // ~60 % of the window height (480x320: every size is 48 px), never below 48 px tall / 44 px wide on the glass
    const s = scale(), g = Math.max(s, 1), wmin = GLASS_W / s;
    const cap = (0.6 * innerHeight - 40) / 4;
    const kw = Math.max(SIZES[size][0] * g / s, wmin), kh = Math.max(GLASS_H, Math.min(SIZES[size][1] * g, cap)) / s;
    el.style.setProperty("--kw", kw + "px"); el.style.setProperty("--kh", kh + "px"); el.style.setProperty("--kmin", wmin + "px");
    el.dataset.layout = layout; el.dataset.size = size; el.dataset.layer = layer;
    el.classList.toggle("menu", menu);
    const tries = FITS[layout];
    for (let i = 0; i < tries.length; i++) {   // the first variant that fits the window (keys >= 44 x 48 px on the glass)
      fit = tries[i];
      el.style.maxWidth = (innerWidth - (fit.tight ? 8 : 16)) / s + "px";
      el.dataset.fit = (fit.dig === "row" && layout !== "wide" ? "row" : "") + (fit.tight ? " tight" : "");
      el.innerHTML = "";
      keysEl = document.createElement("div"); keysEl.className = "kb-keys";
      pop = document.createElement("div"); pop.className = "kb-pop"; pop.hidden = true;
      if (menu) renderMenu(); else renderKeys();
      el.appendChild(keysEl); el.appendChild(pop);
      if (menu || i === tries.length - 1 || fits()) break;
    }
    place();
  }
  // the panel fits: no row wider than its box and, with a digit row / column, at most 60 % of the window height
  function fits() {
    if (el.scrollWidth > el.clientWidth + 1) return false;
    for (const r of el.querySelectorAll(".kb-keys .r")) if (r.scrollWidth > r.clientWidth + 1) return false;
    return fit.dig === "hint" || el.getBoundingClientRect().height <= 0.6 * innerHeight;
  }
  function renderKeys() {
    const main = document.createElement("div"); main.className = "kb-main";
    const left = document.createElement("div"); left.className = "kb-letters";
    let rows = layer === "abc" ? (fit.de10 && LANG === "de" ? DE10 : LAYOUT[LANG] || LAYOUT.en) : SIGNS[layer];
    const digRow = layer === "abc" && fit.dig === "row";   // full width, or the number column on a narrow window: a digit row on top
    if (digRow) rows = [TOP_DIGIT].concat(rows);
    const top = digRow ? 1 : 0;   // index of the top letter row (hold = its digit)
    const hint = layer === "abc" && fit.dig === "hint";   // digits shown in the corner of the top row when they are not keys
    rows.forEach((r, i) => {
      const last = i === rows.length - 1, keys = [];
      if (last && layer === "abc") {
        const s = actKey(caps ? ICON.caps : shift ? ICON.shiftOn : ICON.shift, "w sh" + (shift ? " on" : ""), tapShift, tx("kbd.shift"));
        s.setAttribute("aria-pressed", String(shift)); keys.push(s);
      }
      if (last && layer !== "abc") keys.push(actKey(layer === "sym" ? "=\\<" : "?123", "w", () => { layer = layer === "sym" ? "sym2" : "sym"; render(); }));
      [...r].forEach((ch, j) => {
        const k = charKey(ch, "", variantsOf(ch, layer === "abc" && i === top, j));
        if (hint && i === top && j < TOP_DIGIT.length) k.dataset.hint = TOP_DIGIT[j];
        keys.push(k);
      });
      if (last) keys.push(actKey(ICON.back, "w bk", back, tx("kbd.back"), true));
      left.appendChild(row(...keys));
    });
    left.appendChild(row(
      actKey(ICON.opts, "w op", () => { menu = true; render(); }, tx("kbd.opts")),
      actKey(layer === "abc" ? "?123" : "ABC", "w", () => { layer = layer === "abc" ? "sym" : "abc"; render(); }),
      charKey(" ", "sp"),
      actKey(ICON.hide, "w hd", () => hide(), tx("kbd.close")),
      actKey(doneLabel || tx("kbd.search"), "w ok", done),
    ));
    main.appendChild(left);
    if (fit.dig === "col" && layer === "abc") {
      const pad = document.createElement("div"); pad.className = "kb-pad";
      PAD.forEach(r => pad.appendChild(row(...[...r].map(ch => charKey(ch, "n", ACC[ch]))))); main.appendChild(pad);
    }
    keysEl.appendChild(main);
    const sp = keysEl.querySelector(".sp"); sp.setAttribute("aria-label", tx("kbd.space")); sp.textContent = tx("kbd.space");
  }
  function renderMenu() {
    const m = document.createElement("div"); m.className = "kb-menu";
    const seg = (title, list, cur, pick) => {
      const box = document.createElement("div"); box.className = "kb-seg";
      const h = document.createElement("div"); h.className = "kb-h"; h.textContent = title; box.appendChild(h);
      const r = document.createElement("div"); r.className = "r";
      list.forEach(([v, label]) => {
        const b = actKey(label, "opt" + (v === cur ? " on" : ""), () => pick(v));
        b.dataset.v = v; b.setAttribute("aria-pressed", String(v === cur)); r.appendChild(b);
      });
      box.appendChild(r); m.appendChild(box);
    };
    seg(tx("kbd.layout"), LAYOUTS.map(v => [v, tx("kbd.l." + v)]), layout,
      v => { layout = v; U.store.set("kbdLayout", v); menu = false; render(); });   // a layout: back to the keys to see it
    seg(tx("kbd.size"), Object.keys(SIZES).map(v => [v, v]), size,
      v => { size = v; U.store.set("kbdSize", v); render(); });                       // a size: the panel resizes around the menu
    const tip = document.createElement("div"); tip.className = "kb-tip"; tip.textContent = tx("kbd.hold"); m.appendChild(tip);
    m.appendChild(row(actKey("ABC", "w back", () => { menu = false; render(); }), actKey(ICON.hide, "w hd", () => hide(), tx("kbd.close"))));
    keysEl.appendChild(m);
  }

  // ---- placement: docked bottom-centre; moved above (or below) the field when it would cover it ----
  // All geometry here in screen px (getBoundingClientRect, innerWidth); written to style in UI px (/ scale).
  function place() {
    if (!el || !isOpen()) return;
    const s = scale(), vw = window.innerWidth, vh = window.innerHeight, M = fit.tight ? 4 : 8;
    el.style.maxWidth = (vw - 2 * M) / s + "px";
    const K = el.getBoundingClientRect(), w = K.width, h = K.height;
    let top = vh - h - M;
    if (input && input.getBoundingClientRect) {
      let r = input.getBoundingClientRect();
      const covers = (a, t) => a.bottom + M > t && a.top - M < t + h;
      // the field's panel (.navpanel: a form with its close / save buttons) would run under the docked keyboard:
      // the panel ends above the keyboard and scrolls, so its buttons stay reachable (480x320: Places edit)
      const panel = input.closest && input.closest(".navpanel");
      if (panel && r.height) {
        const P = panel.getBoundingClientRect(), natBottom = squeezed === panel ? P.top + panel.scrollHeight * s : P.bottom;
        const room = top - M - P.top;
        if (natBottom + M > top && room >= r.height + 2 * M && (squeezed === panel || r.top - h - M < M)) {
          squeezed = panel; panel.style.maxHeight = room / s + "px";
          if (!scrolled) {   // once per opening: bring the field into the panel's room (the user may scroll on after)
            scrolled = true; r = input.getBoundingClientRect();
            const pb = P.top + room - M;
            if (r.bottom > pb) panel.scrollTop += (r.bottom - pb) / s;
          }
          el.style.left = Math.round((vw - w) / 2) / s + "px";
          el.style.top = Math.round(top) / s + "px";
          return;
        }
      }
      if (r.height && covers(r, top)) {
        if (r.top - h - M >= M) top = r.top - h - M;            // room above the field
        else if (r.bottom + M + h <= vh - M) top = r.bottom + M; // room below it
        else if (!scrolled) {                                    // small screen: scroll the field's own list up
          scrolled = true;
          const sc = scroller(input), need = r.bottom + M - top;
          if (sc) { sc.scrollTop += need / s; return requestAnimationFrame(place); }
        }
      }
    }
    el.style.left = Math.round((vw - w) / 2) / s + "px";
    el.style.top = Math.round(Math.max(M, top)) / s + "px";
  }
  function unsqueeze() { if (squeezed) { squeezed.style.maxHeight = ""; squeezed = null; } }

  // the nearest ancestor that scrolls (never #views / the page: their overflow is hidden, see PN-SHELL-01)
  function scroller(n) {
    for (let p = n.parentElement; p && p !== document.body; p = p.parentElement) {
      const o = getComputedStyle(p).overflowY;
      if ((o === "auto" || o === "scroll") && p.scrollHeight > p.clientHeight) return p;
    }
    return null;
  }

  // ---- the variants popup ----
  function showPop(b) {
    const vars = [...b.dataset.var].map(c => cased(c));
    pop.innerHTML = "";
    vars.forEach(c => { const v = document.createElement("button"); v.type = "button"; v.tabIndex = -1; v.className = "k v"; v.textContent = c; v.dataset.c = c; pop.appendChild(v); });
    pop.hidden = false;
    // screen px from the rects; the popup's left/top are UI px inside the (zoomed) panel
    const s = scale(), P = el.getBoundingClientRect(), k = b.getBoundingClientRect(), Q = pop.getBoundingClientRect(), w = Q.width, ph = Q.height;
    const left = Math.max(-P.left + 4, Math.min(window.innerWidth - P.left - w - 4, k.left - P.left + k.width / 2 - w / 2));
    let top = k.top - P.top - ph - 6;
    if (P.top + top < 4) top = k.bottom - P.top + 6;   // no room above: below the key
    pop.style.left = left / s + "px"; pop.style.top = top / s + "px";
  }
  function closePop() { if (pop) { pop.hidden = true; pop.innerHTML = ""; } }
  function variantAt(x, y) {
    if (!pop || pop.hidden) return null;
    const r = pop.getBoundingClientRect();
    if (y < r.top - 40 || y > r.bottom + 60 || x < r.left - 30 || x > r.right + 30) return null;
    let best = null, bd = Infinity;
    for (const v of pop.children) { const q = v.getBoundingClientRect(), d = Math.abs(x - (q.left + q.width / 2)); if (d < bd) { bd = d; best = v; } }
    return best;
  }

  function endHold() {
    if (!hold) return;
    clearTimeout(hold.t); clearInterval(hold.rep);
    hold.b && hold.b.classList.remove("down");
    hold = null;
  }
  function onDown(e) {
    if (e.button) return;
    const v = e.target.closest(".kb-pop .v");
    if (v) { e.preventDefault(); const c = v.dataset.c; closePop(); type(c); return; }   // the popup stayed open: tap one
    const b = e.target.closest("button.k"); if (!b || !el.contains(b)) return;
    e.preventDefault();
    if (hold) endHold();
    closePop();
    try { b.setPointerCapture(e.pointerId); } catch (_) { /* synthetic pointer */ }
    b.classList.add("down");
    hold = { b, id: e.pointerId, x: e.clientX, y: e.clientY, acc: false, sel: null };
    if (b._act) {
      b._act();
      if (b._repeat) { const h = hold; h.t = setTimeout(() => { h.rep = setInterval(back, REPEAT_MS); }, REPEAT_WAIT); }
      else { const bb = b; setTimeout(() => bb.classList.remove("down"), 120); hold = null; }
      return;
    }
    if (b.dataset.var) { const h = hold; h.t = setTimeout(() => { h.acc = true; showPop(b); }, HOLD_MS); }
  }
  function onMove(e) {
    if (!hold || e.pointerId !== hold.id || !hold.acc) return;
    if (Math.hypot(e.clientX - hold.x, e.clientY - hold.y) < 10) return;
    const s = variantAt(e.clientX, e.clientY);
    if (s !== hold.sel) { hold.sel && hold.sel.classList.remove("sel"); s && s.classList.add("sel"); hold.sel = s; }
  }
  function onUp(e) {
    if (!hold || e.pointerId !== hold.id) return;
    const h = hold; endHold();
    if (h.b._act) return;   // Backspace held: repeat stopped
    if (h.acc) { if (h.sel) { const c = h.sel.dataset.c; closePop(); type(c); } return; }   // nothing chosen: popup stays for a tap
    type(cased(h.b.dataset.ch));
  }
  function onCancel(e) { if (hold && e.pointerId === hold.id) { endHold(); } }

  function done() { hide(); onDone && onDone(input.value); }
  function bind() {
    if (el && el._bound) return;
    el = document.getElementById("kbd"); el._bound = true;
    el.addEventListener("pointerdown", onDown);
    el.addEventListener("pointermove", onMove);
    el.addEventListener("pointerup", onUp);
    el.addEventListener("pointercancel", onCancel);
    el.addEventListener("contextmenu", e => e.preventDefault());
    window.addEventListener("resize", () => { if (isOpen()) render(); });   // a new size / UI scale: key sizes and the fitting layout change
    document.addEventListener("scroll", () => { if (isOpen()) place(); }, true);
  }
  // A USB keyboard: the browser types into the focused field itself; tell the page like a key here would.
  document.addEventListener("input", e => { if (isOpen() && e.target === input) onChange(input.value); }, true);
  document.addEventListener("keydown", e => {
    if (!isOpen() || e.target !== input) return;
    if (e.key === "Enter") { e.preventDefault(); done(); }
    else if (e.key === "Escape") { e.preventDefault(); hide(); }
  }, true);
  function show(inp, change, done_, label) {   // label: optional text of the last key (default "Search")
    if (inp !== input) unsqueeze();
    input = inp; onChange = change; onDone = done_; doneLabel = label || null;
    layer = "abc"; shift = caps = menu = scrolled = false;
    loadPrefs(); bind();
    el.classList.add("open"); el.setAttribute("aria-hidden", "false");
    render();
    if (document.activeElement !== inp) { try { inp.focus({ preventScroll: true }); } catch (_) { /* not focusable */ } }
    setTimeout(place, 300);   // pages scroll their field into view after opening (wifi, car)
  }
  function hide() { endHold(); closePop(); unsqueeze(); if (el) { el.classList.remove("open"); el.setAttribute("aria-hidden", "true"); } }
  function isOpen() { return !!el && el.classList.contains("open"); }
  return { show, hide, isOpen, place };
})();
