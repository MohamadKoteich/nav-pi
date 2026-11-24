// Unit test for features/nav/speedlimit.js with a recorded Valhalla route + trace_attributes (tools/fixtures/limits-munich.json,
// made by tools/record_limits.py). node tools/test-speedlimit.mjs
import { createRequire } from "module";
import { readFileSync } from "fs";
import assert from "assert";
const require = createRequire(import.meta.url);
const SL = require("../features/nav/speedlimit.js");
const fx = JSON.parse(readFileSync(new URL("./fixtures/limits-munich.json", import.meta.url)));

function decode(str) {   // Valhalla polyline, precision 6 -> [lon, lat]
  let i = 0, lat = 0, lon = 0; const out = [];
  while (i < str.length) {
    for (const k of [0, 1]) { let s = 0, r = 0, b; do { b = str.charCodeAt(i++) - 63; r |= (b & 31) << s; s += 5; } while (b >= 32); const d = r & 1 ? ~(r >> 1) : r >> 1; k ? lon += d : lat += d; }
    out.push([lon / 1e6, lat / 1e6]);
  }
  return out;
}
const dist = (a, b) => { const R = 6371000, p = Math.PI / 180, dl = (b[1] - a[1]) * p, dn = (b[0] - a[0]) * p * Math.cos((a[1] + b[1]) / 2 * p); return R * Math.hypot(dl, dn); };
const shape = decode(fx.route.trip.legs[0].shape), cum = [0];
for (let i = 1; i < shape.length; i++) cum.push(cum[i - 1] + dist(shape[i - 1], shape[i]));
const edges = fx.attrs.edges.map(x => [x.begin_shape_index, x.end_shape_index, x.speed_limit || 0]);   // what /api/limits returns

const lim = SL.build(edges, cum);
const total = cum[cum.length - 1];
const known = lim.filter(s => s.kmh).reduce((a, s) => a + s.to - s.from, 0);
console.log(`route ${(total / 1000).toFixed(1)} km, ${edges.length} edges -> ${lim.length} zones, limit known on ${(100 * known / total).toFixed(0)} %`);
assert.strictEqual(edges[edges.length - 1][1], shape.length - 1, "edge_walk indices must span the route shape");
assert(Math.abs(lim[lim.length - 1].to - total) < 1 && lim[0].from === 0, "zones cover the whole route");
for (let i = 1; i < lim.length; i++) assert(Math.abs(lim[i].from - lim[i - 1].to) < 1, "no gaps");
assert(known / total > 0.5, "most of the route has a limit");
// lookups agree with a linear scan at 500 points
for (let d = 0; d <= total; d += total / 500) {
  const s = lim.find(z => d >= z.from && d <= z.to + 1);
  assert.strictEqual(SL.at(lim, d), s ? s.kmh : null, "at " + d);
}
assert.strictEqual(SL.at(null, 10), null); assert.strictEqual(SL.at([], 10), null);
assert.deepStrictEqual(SL.build([[0, 1, 255], [1, 2, 0], [2, 3, 50], [3, 4, 50]], [0, 10, 20, 30, 40]),
  [{ from: 0, to: 20, kmh: null }, { from: 20, to: 40, kmh: 50 }], "unlimited/unknown -> null, equal neighbours merge");

// over-speed watch: threshold, 2 s dwell, one chime per zone, re-arm after back under, new zone re-arms
const w = new SL.Watch(); let t = 0; const st = (l, v) => w.step(l, v, 5, t += 500);
assert.deepStrictEqual(st(50, 54), { over: false, chime: false }, "within +5");
assert.deepStrictEqual(st(50, 60), { over: false, chime: false }, "dwell starts");
st(50, 60); st(50, 60); st(50, 60);
assert.deepStrictEqual(st(50, 60), { over: true, chime: true }, "2 s over -> warn + chime once");
assert.deepStrictEqual(st(50, 62), { over: true, chime: false }, "no nagging");
assert.deepStrictEqual(st(50, 48), { over: false, chime: false }, "back under");
st(50, 60); st(50, 60); st(50, 60); st(50, 60); assert.strictEqual(st(50, 60).chime, true, "re-armed after back under");
st(50, 60); assert.strictEqual(st(50, 62).chime, false);
st(30, 60); st(30, 60); st(30, 60); st(30, 60); assert.strictEqual(st(30, 60).chime, true, "new zone re-arms");
assert.deepStrictEqual(st(null, 200), { over: false, chime: false }, "unknown limit never warns");
console.log("speedlimit tests ok");
