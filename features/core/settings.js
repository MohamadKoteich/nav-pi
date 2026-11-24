/* nav-pi Settings screen (2026-11-22): a category rail on the left (tinted
   icon tiles), the chosen category's cards on the right under its title. Features bring their own HTML cards
   (features/<id>/settings.html); each card says its category with data-cat="…". The rail lists only the
   categories that have a card in this edition, so the basic edition shows no empty category; a card without
   data-cat lands in System. Sections register with Settings.section({cat, open, close, relang}): a section with
   a cat is opened only while its category is shown (polling stops elsewhere), one without is opened with the page.
   Card visibility inside a category stays the feature's business (the hidden attribute); the category filter
   uses its own class (st-off), so the two never fight. */
"use strict";
const Settings = (() => {
  const $ = id => document.getElementById(id);
  // order = rail order. hue tints the icon tile.
  const CATS = [
    { id: "nav", icon: "i-nav", hue: 214 },
    { id: "safety", icon: "i-warning", hue: 32 },
    { id: "display", icon: "i-sun", hue: 48 },
    { id: "sound", icon: "i-speaker", hue: 172 },
    { id: "connect", icon: "i-wifi", hue: 196 },
    { id: "sat", icon: "i-sat", hue: 262 },
    { id: "car", icon: "i-car", hue: 8 },
    { id: "health", icon: "i-speed", hue: 140 },
    { id: "system", icon: "i-info", hue: 226 },
  ];
  const sections = [];
  let bound = false, shown = false, cur = null, built = false;
  function section(s) { sections.push(s); }
  const cards = () => [...document.querySelectorAll("#st-pane > [data-cat]")];
  function build() {
    built = true;
    const known = new Set(CATS.map(c => c.id));
    document.querySelectorAll("#st-pane > .card").forEach(c => { if (!known.has(c.dataset.cat)) c.dataset.cat = "system"; });
    const have = new Set(cards().map(c => c.dataset.cat));
    const nav = $("st-nav");
    for (const c of CATS) {
      if (!have.has(c.id)) continue;
      const b = document.createElement("button");
      b.dataset.cat = c.id;
      b.innerHTML = `<span class="st-ico" style="--hue:${c.hue}"><svg class="i"><use href="#${c.icon}"/></svg></span><span class="st-nav-t"></span>`;
      b.addEventListener("click", () => show(c.id));
      nav.appendChild(b);
    }
    label();
  }
  function label() {
    document.querySelectorAll("#st-nav button").forEach(b => {
      const t = T("cat." + b.dataset.cat);
      b.querySelector(".st-nav-t").textContent = t; b.setAttribute("aria-label", t);
    });
    if (cur) $("st-title").textContent = T("cat." + cur);
  }
  const openSec = s => s.open && s.open(), closeSec = s => s.close && s.close();
  function show(id) {
    if (!built) build();
    if (!document.querySelector(`#st-nav button[data-cat="${id}"]`)) id = (document.querySelector("#st-nav button") || {}).dataset?.cat;
    if (!id) return;
    const was = cur; cur = id;
    document.querySelectorAll("#st-nav button").forEach(b => {
      const on = b.dataset.cat === id; b.classList.toggle("on", on); b.setAttribute("aria-current", on ? "page" : "false");
    });
    cards().forEach(c => c.classList.toggle("st-off", c.dataset.cat !== id));
    $("st-title").textContent = T("cat." + id);
    if (was !== id) $("st-pane").scrollTop = 0;
    if (!shown) return;
    if (was && was !== id) sections.filter(s => s.cat === was).forEach(closeSec);
    if (was !== id) sections.filter(s => s.cat === id).forEach(openSec);
  }
  // open Settings at the category of a card (or a category id): Settings.open("gps-card"), Settings.open("sat")
  function open(what) {
    const el = $(what), cat = el && el.dataset.cat ? el.dataset.cat : what;
    Shell.go("settings"); show(cat);
    if (el && el.dataset.cat) setTimeout(() => { const pane = $("st-pane"); pane.scrollTop += (el.getBoundingClientRect().top - pane.getBoundingClientRect().top) / UiScale.value(); }, 60);   // rects are screen px, scrollTop is UI px
  }
  function markLang() { document.querySelectorAll("#langs button").forEach(b => b.classList.toggle("on", b.dataset.lang === LANG)); }
  async function loadAbout() {
    try {
      const s = await U.api("/api/status");
      const m = (s.data.map || "").match(/osmosisreplicationtime (\S+)/), r = (s.data.valhalla || "").match(/built=(\S+)/);
      $("about").textContent = T("about", { map: m ? m[1].slice(0, 10) : "?",
        routes: r ? T("routes.built", { d: r[1].slice(0, 10) }) : T("routes.missing"), voice: s.voice || "–" }) +
        (window.EDITION ? " · " + EDITION.name + " (" + EDITION.hardware + ")" : "");
    } catch (e) { /* navd restarting */ }
  }
  function bind() {
    bound = true;
    document.querySelectorAll("#langs button").forEach(b => b.addEventListener("click", () => {
      setLang(b.dataset.lang); markLang(); Shell.relang(); loadAbout();
      sections.forEach(s => s.relang && s.relang());
    }));
  }
  Shell.onLang(() => { if (built) label(); });
  Shell.view("settings", {
    show() {
      if (!bound) bind();
      if (!built) build();
      shown = true; markLang(); loadAbout();
      const c = cur || (document.querySelector("#st-nav button") || {}).dataset?.cat;
      cur = null; show(c);
      sections.filter(s => !s.cat).forEach(openSec);
    },
    hide() {
      shown = false;
      sections.filter(s => !s.cat || s.cat === cur).forEach(closeSec);
    },
  });
  return { section, show, open, current: () => cur };
})();
