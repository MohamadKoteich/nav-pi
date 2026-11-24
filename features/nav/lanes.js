/* nav-pi lane guidance (PN-36) and junction view (PN-40). Offline: lanes come from the local Valhalla graph
   (OSM turn:lanes / lanes tags) via POST /api/lanes (navd_nav.py -> Valhalla /trace_route format=osrm, edge_walk on
   the route's own shape; the native /route JSON has no lanes). A junction without lane tags shows no lanes.
   The junction picture is drawn here from the route geometry, the junction's road bearings and the lanes: no image
   assets. Pure drawing functions first (testable in node: tools/test-lanes.mjs), the DOM part at the bottom. */
"use strict";
const Lanes = (() => {
  const LANE_SHOW = 1500;    // m before the maneuver: lane arrows in the banner
  const JCT_SHOW = 800;      // m before the maneuver: junction picture (~25 s at 120 km/h)
  const JCT_TYPES = new Set([17, 18, 19, 20, 21, 22, 23, 24, 37, 38]);   // ramps, exits, forks/keeps, merges
  const ANGLE = { "straight": 0, "slight right": 45, "right": 90, "sharp right": 135, "slight left": -45, "left": -90,
    "sharp left": -135, "uturn": 180, "none": 0 };

  // ---------- pure: data ----------
  // guide.man[i].pt = [lon, lat] of the maneuver; points from /api/lanes, in route order -> m.lanes, m.jb
  function attach(mans, points) {
    let j = 0;
    for (const m of mans) {
      let best = -1, bd = 20;   // metres: a step point belongs to the maneuver at the same place
      for (let k = j; k < points.length && k < j + 40; k++) {
        const d = U.dist(m.pt, points[k].at);
        if (d < bd) { bd = d; best = k; }
      }
      if (best < 0) continue;
      const p = points[best]; j = best + 1;
      m.lanes = p.lanes && p.lanes.length >= 2 ? p.lanes : null;
      m.jb = p.b && p.b.length ? { b: p.b, in: p.in, out: p.out } : null;
    }
    mans.forEach((m, i) => { m.jct = junctionWorthy(m, mans[i - 1]); });
  }
  // lanes worth showing: at least one lane is not for this maneuver (all valid tells the driver nothing)
  const useful = lanes => !!lanes && lanes.length >= 2 && lanes.some(l => !l[1]) && lanes.some(l => l[1]);
  // a junction picture for ramps / exits / forks / merges on a motorway (the road before is one: Valhalla sets
  // `highway` on maneuvers that lead onto a motorway) or on a road with 3+ lanes, and only where the junction
  // has another road to take (else there is nothing to choose between)
  function junctionWorthy(m, prev) {
    if (!JCT_TYPES.has(m.type) || !m.jb) return false;
    const others = m.jb.b.filter((_, k) => k !== m.jb.in && k !== m.jb.out).length;
    return others > 0 && (!!(prev && prev.highway) || !!(m.lanes && m.lanes.length >= 3));
  }

  // ---------- pure: lane arrows ----------
  function arrowPath(a) {   // a lane arrow for angle a (deg, + = right) in a 32x40 box, stem at the bottom centre
    if (Math.abs(a) === 180) return { d: "M19 36V17a6 6 0 0 0-12 0v8", head: "2,24 12,24 7,32" };
    const r = a * Math.PI / 180, sx = 16, sy = a === 0 ? 8 : 20;
    const ex = sx + (a === 0 ? 0 : 11 * Math.sin(r)), ey = sy - (a === 0 ? 0 : 11 * Math.cos(r));
    const dx = Math.sin(r), dy = -Math.cos(r), px = -dy, py = dx;
    const tip = [ex + 7 * dx, ey + 7 * dy], b1 = [ex + 5.5 * px, ey + 5.5 * py], b2 = [ex - 5.5 * px, ey - 5.5 * py];
    const f = v => v.toFixed(1);
    return { d: `M16 36V${sy}${a === 0 ? "" : `L${f(ex)} ${f(ey)}`}`, head: [tip, b1, b2].map(p => f(p[0]) + "," + f(p[1])).join(" ") };
  }
  // one lane: every indication drawn; the one to follow bright, the others dim; a lane not for us all dim
  function laneSvg(lane) {
    const [ind, valid, follow] = lane;
    const parts = ind.split("|").map(s => ({ s, a: ANGLE[s] === undefined ? 0 : ANGLE[s] }));
    parts.sort((x, y) => (x.s === follow) - (y.s === follow));   // the followed arrow on top
    const g = parts.map(({ s, a }) => {
      const p = arrowPath(a), on = valid && (s === follow || !follow);
      return `<g class="${on ? "on" : "off"}"><path d="${p.d}"/><polygon points="${p.head}"/></g>`;
    }).join("");
    return `<svg viewBox="0 0 32 40" class="lane${valid ? " ok" : ""}" aria-hidden="true">${g}</svg>`;
  }
  function lanesHtml(lanes) { return lanes.map(laneSvg).join('<i class="sep"></i>'); }

  // ---------- pure: junction picture ----------
  // picture units: 300 high, as wide as the box it is shown in (4:3 beside the map, wide under the banner in portrait)
  const H = 300, CY = 185, K = 0.75, XS = 1.6, LW = 16;   // px per m, lateral exaggeration, px per lane
  let W = 400, CX = 200;
  // the shape between `a` and `b` metres along it, resampled every `step` m (smooth lines, no zigzag)
  function resample(shape, cum, a, b, step = 15) {
    const out = [], end = cum[cum.length - 1];
    let i = 0;
    for (let d = Math.max(0, a); d <= Math.min(end, b) + 0.01; d += step) {
      while (i + 1 < cum.length - 1 && cum[i + 1] < d) i++;
      const t = Math.max(0, Math.min(1, (d - cum[i]) / ((cum[i + 1] - cum[i]) || 1)));
      out.push([shape[i][0] + (shape[i + 1][0] - shape[i][0]) * t, shape[i][1] + (shape[i + 1][1] - shape[i][1]) * t]);
    }
    return out;
  }
  function bearing(a, b) {
    const c = Math.cos(a[1] * Math.PI / 180);
    return (Math.atan2((b[0] - a[0]) * c, b[1] - a[1]) * 180 / Math.PI + 360) % 360;
  }
  // a screen polyline cut where it first leaves the picture (minus a margin), so the arrow head stays visible
  function clip(pts, mg) {
    const inside = p => p[0] >= mg && p[0] <= W - mg && p[1] >= mg;
    const out = [];
    for (const p of pts) {
      if (!inside(p)) {
        const q = out[out.length - 1];
        if (q) {
          let lo = 0, hi = 1;
          for (let k = 0; k < 12; k++) { const t = (lo + hi) / 2; if (inside([q[0] + (p[0] - q[0]) * t, q[1] + (p[1] - q[1]) * t])) lo = t; else hi = t; }
          out.push([q[0] + (p[0] - q[0]) * lo, q[1] + (p[1] - q[1]) * lo]);
        }
        break;
      }
      out.push(p);
    }
    return out;
  }
  // geo -> screen: junction at (CX, CY), driving direction up, lateral offsets exaggerated (a 15 degree exit reads)
  function frame(o, heading) {
    const h = heading * Math.PI / 180, c = Math.cos(o[1] * Math.PI / 180);
    return p => {
      const x = (p[0] - o[0]) * c * 111320, y = (p[1] - o[1]) * 110540;
      const f = x * Math.sin(h) + y * Math.cos(h), r = x * Math.cos(h) - y * Math.sin(h);
      return [CX + r * K * XS, CY - f * K];
    };
  }
  function offsetLine(pts, d) {   // a screen polyline moved d px to its right
    return pts.map((p, i) => {
      const a = pts[Math.max(0, i - 1)], b = pts[Math.min(pts.length - 1, i + 1)];
      const dx = b[0] - a[0], dy = b[1] - a[1], n = Math.hypot(dx, dy) || 1;
      return [p[0] - dy / n * d, p[1] + dx / n * d];
    });
  }
  const pl = pts => pts.map(p => p[0].toFixed(1) + "," + p[1].toFixed(1)).join(" ");
  const shift = (pts, dx) => pts.map(p => [p[0] + dx, p[1]]);
  // m: maneuver with jb (+ lanes); shape/cum: the trip's shape and distance axis
  function junctionSvg(m, shape, cum, aspect = 4 / 3) {
    W = Math.round(H * Math.max(1, Math.min(4, aspect))); CX = W / 2;
    const jb = m.jb;
    // driving direction = the route's own last 100 m before the junction (the node bearing can be a short kink);
    // OSRM bearings[in] (pointing back along the road we come on) only as a fallback
    const back = resample(shape, cum, m.at - 100, m.at - 100, 1)[0];
    const heading = back && U.dist(back, m.pt) > 30 ? bearing(back, m.pt) : (jb.b[jb.in] + 180) % 360;
    const tf = frame(m.pt, heading);
    const appr = resample(shape, cum, m.at - 330, m.at).map(tf);
    const exit = resample(shape, cum, m.at, m.at + 300).map(tf);
    if (appr.length < 2 || exit.length < 2) return "";
    const n = m.lanes ? m.lanes.length : 2;
    const valid = m.lanes ? m.lanes.map((l, i) => l[1] ? i : -1).filter(i => i >= 0) : [];
    const rest = m.lanes ? m.lanes.map((l, i) => l[1] ? -1 : i).filter(i => i >= 0) : [];
    const centre = i => (i - (n - 1) / 2) * LW;
    const mean = a => a.reduce((t, x) => t + x, 0) / a.length;
    const wA = Math.max(32, n * LW);
    const offC = valid.length ? mean(valid.map(centre)) : 0, wC = Math.max(32, (valid.length || 1) * LW + 8);
    const offO = rest.length ? mean(rest.map(centre)) : 0, wO = Math.max(28, (rest.length || 1) * LW);
    const others = jb.b.map((b, k) => ({ b, k })).filter(x => x.k !== jb.in && x.k !== jb.out);
    // the other roads at the junction: straight along their bearing (the picture is a sketch, not a map)
    const branch = b => {
      const r = (b - heading) * Math.PI / 180, out = [];
      for (let d = 0; d <= 300; d += 20) out.push([CX + Math.sin(r) * d * K * XS, CY - Math.cos(r) * d * K]);
      return out;
    };
    const road = (pts, w, cls) => `<polyline class="edge ${cls}" points="${pl(pts)}" stroke-width="${w + 8}"/><polyline class="road ${cls}" points="${pl(pts)}" stroke-width="${w}"/>`;
    let s = `<svg viewBox="0 0 ${W} ${H}" preserveAspectRatio="xMidYMid meet" aria-hidden="true"><rect class="bg" width="${W}" height="${H}"/>`;
    for (const o of others) s += road(shift(branch(o.b), offO), wO, "other");
    s += road(appr, wA, "appr");
    s += road(shift(exit, offC), wC, "take");
    const near = appr.filter(p => p[1] >= CY + 8);   // lane lines up to the junction, not into it
    for (let i = 1; i < n && near.length >= 2; i++) s += `<polyline class="mark" points="${pl(offsetLine(near, centre(i) - LW / 2))}"/>`;
    // the way to go: from the lanes to use (bottom of the picture) into the exit, arrow head inside the picture
    const way = clip(shift(appr.filter(p => p[1] <= H + 20), offC).concat(shift(exit.slice(1), offC)), 34);
    if (way.length >= 2) {
      const e = way[way.length - 1];
      let q = way[way.length - 2];
      for (let k = way.length - 2; k >= 0 && Math.hypot(e[0] - way[k][0], e[1] - way[k][1]) < 8; k--) q = way[k];
      const dx = e[0] - q[0], dy = e[1] - q[1], L = Math.hypot(dx, dy) || 1, ux = dx / L, uy = dy / L;
      const tip = [e[0] + ux * 20, e[1] + uy * 20], b1 = [e[0] - uy * 16, e[1] + ux * 16], b2 = [e[0] + uy * 16, e[1] - ux * 16];
      s += `<polyline class="way-edge" points="${pl(way)}"/><polyline class="way" points="${pl(way)}"/>`;
      s += `<polygon class="head" points="${pl([tip, b1, b2])}"/>`;
    }
    return s + "</svg>";
  }

  // ---------- data loading ----------
  function load(guide) {
    const legs = guide.legShapes || [];
    legs.forEach((shape, li) => {
      U.api("/api/lanes", { shape }).then(r => {
        attach(guide.man.filter(m => m.leg === li), r.points || []);
        guide.lanesReady = (guide.lanesReady || 0) + 1;
      }).catch(() => { /* no lanes: the banner simply shows none */ });
    });
  }

  // ---------- DOM ----------
  let shownLanes = null, shownJct = null;
  function el(id, parent, cls, before) {
    let e = document.getElementById(id);
    if (!e) { e = document.createElement("div"); e.id = id; e.className = cls; parent.insertBefore(e, before || null); }
    return e;
  }
  function place(j) {   // portrait: below the banner (its height changes with the then / lanes rows)
    const b = document.getElementById("banner");
    j.style.top = matchMedia("(orientation: portrait)").matches && b ? (b.offsetTop + b.offsetHeight + 10) + "px" : "";
  }
  function render(st, guide) {
    const banner = document.getElementById("banner");
    if (!banner) return;
    const row = el("b-lanes", banner, "lanes", document.getElementById("b-then"));   // right under the next maneuver
    const jct = el("jct", banner.parentNode, "jct");
    const m = st && !st.arrived ? st.next : null;
    const lanesOn = m && useful(m.lanes) && st.toNext <= LANE_SHOW;
    if (lanesOn && shownLanes !== m) { row.innerHTML = lanesHtml(m.lanes); row.setAttribute("aria-label", T("lanes.aria", { n: m.lanes.filter(l => l[1]).length })); }
    row.classList.toggle("on", !!lanesOn); shownLanes = lanesOn ? m : null;
    const jctOn = !!(m && m.jct && guide && st.toNext <= JCT_SHOW && st.toNext > 10);
    jct.classList.toggle("open", jctOn);
    if (!jctOn) { shownJct = null; return; }
    place(jct);
    const aspect = jct.clientWidth / (jct.clientHeight || 1), key = m.at + ":" + aspect.toFixed(2);
    if (shownJct !== key) { jct.innerHTML = junctionSvg(m, guide.shape, guide.cum, aspect); shownJct = key; }
  }
  // maps.js sends every guidance tick ({st, guide}) and null when the drive ends
  if (typeof window !== "undefined") window.addEventListener("navpi:guide", e => render(e.detail && e.detail.st, e.detail && e.detail.guide));
  return { load, attach, useful, junctionWorthy, laneSvg, lanesHtml, junctionSvg, arrowPath, render, LANE_SHOW, JCT_SHOW };
})();
if (typeof module !== "undefined") module.exports = Lanes;
