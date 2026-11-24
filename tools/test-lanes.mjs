// Unit test for features/nav/lanes.js (PN-36/40) and the voice options in guidance.js (PN-48), with a recorded real
// route + lanes (tools/fixtures/lanes-munich-ingolstadt.json, made by tools/record_lanes.py from Valhalla 3.5.1).
//   node tools/test-lanes.mjs [svg-out-dir]
import { readFileSync, writeFileSync } from "fs";
import vm from "vm";
import assert from "assert";
const fx = JSON.parse(readFileSync(new URL("./fixtures/lanes-munich-ingolstadt.json", import.meta.url)));
const src = f => readFileSync(new URL("../features/" + f, import.meta.url), "utf8");

function decode(str) {   // Valhalla polyline, precision 6 -> [lon, lat]
  let i = 0, lat = 0, lon = 0; const out = [];
  while (i < str.length) {
    for (const k of [0, 1]) { let s = 0, r = 0, b; do { b = str.charCodeAt(i++) - 63; r |= (b & 31) << s; s += 5; } while (b >= 32); const d = r & 1 ? ~(r >> 1) : r >> 1; k ? lon += d : lat += d; }
    out.push([lon / 1e6, lat / 1e6]);
  }
  return out;
}
const dist = (a, b) => { const R = 6371000, p = Math.PI / 180, dl = (b[1] - a[1]) * p, dn = (b[0] - a[0]) * p * Math.cos((a[1] + b[1]) / 2 * p); return R * Math.hypot(dl, dn); };
function project(p, a, b) {
  const c = Math.cos(a[1] * Math.PI / 180), ax = 0, ay = 0, bx = (b[0] - a[0]) * c, by = b[1] - a[1], px = (p[0] - a[0]) * c, py = p[1] - a[1];
  const L = bx * bx + by * by, t = L ? Math.max(0, Math.min(1, ((px - ax) * bx + (py - ay) * by) / L)) : 0;
  const pt = [a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t];
  return { t, pt, d: dist(p, pt) };
}
let opts = { style: "full", turns: "all" };
const ctx = { console, Set, Math, JSON, Promise, LANG: "de", T: k => k, module: undefined, window: undefined,
  VoiceOpts: { get: () => opts },
  U: { decodePolyline: decode, dist, project, bearing: () => 0, spokenDist: d => Math.round(d) + " Metern",
    api: async () => fx.lanes } };
vm.createContext(ctx);
vm.runInContext(src("nav/lanes.js") + "\nthis.Lanes = Lanes;", ctx);
vm.runInContext(src("nav/guidance.js") + "\nthis.Guidance = Guidance; this.isMajor = isMajor;", ctx);
const { Lanes, Guidance } = ctx;

// ---- PN-36: lanes attached to the right maneuvers
const g = new Guidance(fx.route);
await new Promise(r => setTimeout(r, 10));
assert.strictEqual(g.lanesReady, 1, "lanes loaded for the one leg");
const withLanes = g.man.filter(m => m.lanes), useful = g.man.filter(m => Lanes.useful(m.lanes)), jct = g.man.filter(m => m.jct);
console.log(`route ${fx.route.summary.length.toFixed(1)} km, ${g.man.length} maneuvers: ${withLanes.length} with lanes, ${useful.length} shown (some lane not for us), ${jct.length} junction views`);
for (const m of g.man) console.log(`  ${String(m.type).padStart(2)} ${m.instruction.slice(0, 58).padEnd(58)} ${m.lanes ? m.lanes.map(l => (l[1] ? "*" : ".") + l[0]).join(" ") : "-"}${m.jct ? "  [junction view]" : ""}`);
assert(withLanes.length >= 8, "most maneuvers of this route carry OSM lanes");
const exit62 = g.man.find(m => /Ausfahrt 62/.test(m.instruction));
assert(exit62 && exit62.lanes && exit62.lanes.length === 4 && exit62.lanes[3][1] === 1 && !exit62.lanes[0][1], "A9 exit 62: rightmost of 4 lanes");
assert(exit62.jct, "A9 exit 62 gets a junction view");
assert(!g.man[1].lanes, "a town turn without lane tags shows nothing");
assert(!Lanes.useful([["left", 1, "left"], ["left|straight", 1, "left"]]), "all lanes valid: not shown");

// ---- lane arrows: one arrow per indication, the followed one bright
const svg = Lanes.laneSvg(["straight|right", 1, "right"]);
assert.strictEqual((svg.match(/<g class="on"/g) || []).length, 1);
assert.strictEqual((svg.match(/<g class="off"/g) || []).length, 1);
assert(!/NaN/.test(Lanes.lanesHtml(exit62.lanes)));
for (const a of [0, 45, 90, 135, 180, -45, -90, -135]) assert(!/NaN/.test(JSON.stringify(Lanes.arrowPath(a))));

// ---- PN-40: junction pictures from the geometry
const out = process.argv[2];
jct.forEach((m, i) => {
  const s = Lanes.junctionSvg(m, g.shape, g.cum);
  assert(s.startsWith("<svg") && /class="way"/.test(s) && /class="head"/.test(s) && /class="road other"/.test(s) && !/NaN/.test(s), "junction svg " + m.instruction);
  if (out) writeFileSync(`${out}/jct-${i}.svg`, s.replace("<svg ", '<svg xmlns="http://www.w3.org/2000/svg" width="400" height="300" ') +
    "\n<!-- " + m.instruction + " -->\n");
});

// ---- PN-48: voice options along the whole route (simulated at a steady speed)
function drive(o, v) {
  opts = o;
  const gg = new Guidance(fx.route), said = [];
  for (let a = 0; a < gg.total; a += 15) {
    let i = 0; while (i + 1 < gg.cum.length && gg.cum[i + 1] < a) i++;
    const t = (a - gg.cum[i]) / ((gg.cum[i + 1] - gg.cum[i]) || 1), p = [gg.shape[i][0] + (gg.shape[i + 1][0] - gg.shape[i][0]) * t, gg.shape[i][1] + (gg.shape[i + 1][1] - gg.shape[i][1]) * t];
    const st = gg.update(p, v);
    if (st.say) said.push(st.say);
  }
  return said;
}
const all = drive({ style: "full", turns: "all" }, 14), major = drive({ style: "full", turns: "major" }, 14);
const short = drive({ style: "short", turns: "all" }, 14), shortFast = drive({ style: "short", turns: "all" }, 30), fullFast = drive({ style: "full", turns: "all" }, 30);
console.log(`voice prompts at 50 km/h: all ${all.length}, major only ${major.length}, short ${short.length}; at 108 km/h: full ${fullFast.length}, short ${shortFast.length}`);
assert(major.length < all.length, "major only says less");
assert(!major.some(s => /Rindermarkt|Rosental|Prälat-Zistl|Fritz-Neuland/.test(s.text)), "town turns into named streets are not major");
assert(major.some(s => /A 9/.test(s.text)) && major.some(s => /Ausfahrt 62|Ausfahrt/.test(s.text)), "the ramp onto the A 9 and the motorway exit are major");
assert(major.some(s => s.cue && s.cue[0] === "arrived"), "arrival is always spoken");
assert(short.length < all.length, "short: one prompt per maneuver in town");
assert(!short.some(s => /Rindermarkt|Rosental/.test(s.text)), "short: no street names");
assert(short.every(s => !s.cue || s.cue.length >= 1), "short keeps the voice-pack clip keys");
assert(shortFast.length >= fullFast.length - 2 && shortFast.length > short.length - 5, "short on fast roads keeps the early prompt");
for (const s of [...all, ...major, ...short]) assert(!s.cue || s.cue.every(k => typeof k === "string" && /^[a-z0-9_]+$/.test(k)), "cue keys");
console.log("test-lanes: all assertions passed");
