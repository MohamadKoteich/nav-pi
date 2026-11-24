// Unit test for features/safety/safety.js (pure part): curves from a route shape, zones, break reminder, encoder, alert pick.
//   node tools/test-safety.mjs
import { createRequire } from "module";
import assert from "assert";
const require = createRequire(import.meta.url);
const S = require("../features/safety/safety.js");

const LAT0 = 48, KX = 111320 * Math.cos(LAT0 * Math.PI / 180), KY = 110540;
const ll = ([x, y]) => [11.5 + x / KX, LAT0 + y / KY];          // local metres -> [lon, lat]
const dist = (a, b) => Math.hypot((b[0] - a[0]) * KX, (b[1] - a[1]) * KY);
function route(xy) { const shape = xy.map(ll), cum = [0]; for (let i = 1; i < shape.length; i++) cum.push(cum[i - 1] + dist(shape[i - 1], shape[i])); return { shape, cum }; }
// straight north 1000 m, a right-hand arc of radius r over `deg` degrees, then straight on (OSM-like: a point every ~5 m on the arc)
function arc(r, deg, step = 5) {
  const xy = [];
  for (let y = 0; y <= 1000; y += 100) xy.push([0, y]);
  const n = Math.ceil(r * deg * Math.PI / 180 / step);
  for (let k = 1; k <= n; k++) { const a = (deg * Math.PI / 180) * k / n; xy.push([r - r * Math.cos(a), 1000 + r * Math.sin(a)]); }
  const a = deg * Math.PI / 180, ex = r - r * Math.cos(a), ey = 1000 + r * Math.sin(a);
  for (let d = 100; d <= 1000; d += 100) xy.push([ex + d * Math.sin(a), ey + d * Math.cos(a)]);
  return route(xy);
}
let n = 0; const ok = (name, f) => { f(); n++; console.log("PASS " + name); };

ok("90 degree curve, radius 60 m -> one right curve, ~40 km/h, starts near 1000 m", () => {
  const { shape, cum } = arc(60, 90);
  const c = S.curves(shape, cum, []);
  assert.strictEqual(c.length, 1, JSON.stringify(c));
  assert.strictEqual(c[0].dir, 1);
  assert(c[0].r >= 50 && c[0].r <= 75, "radius " + c[0].r);
  assert(c[0].kmh >= 30 && c[0].kmh <= 45, "kmh " + c[0].kmh);
  assert(c[0].at >= 900 && c[0].at <= 1050, "at " + c[0].at);
});
ok("mirror: left curve", () => {
  const { shape, cum } = arc(60, 90);
  const m = shape.map(p => [2 * 11.5 - p[0], p[1]]);
  const c = S.curves(m, cum, []);
  assert.strictEqual(c.length, 1); assert.strictEqual(c[0].dir, -1);
});
ok("gentle curve (radius 400 m) is not sharp", () => {
  const { shape, cum } = arc(400, 60);
  assert.deepStrictEqual(S.curves(shape, cum, []), []);
});
ok("a 15 degree kink in the data is not a curve", () => {
  const { shape, cum } = route([[0, 0], [0, 500], [0, 1000], [130, 1485], [260, 1970]]);
  assert.deepStrictEqual(S.curves(shape, cum, []), []);
});
ok("a sharp bend at a turn maneuver is left to the turn instruction", () => {
  const { shape, cum } = arc(20, 90);
  assert.strictEqual(S.curves(shape, cum, []).length, 1);
  assert.strictEqual(S.curves(shape, cum, [{ type: 10, at: 1010 }]).length, 0);
  assert.strictEqual(S.curves(shape, cum, [{ type: 8, at: 1010 }]).length, 1, "a 'continue' maneuver does not hide it");
});
ok("roundabout span is excluded", () => {
  const { shape, cum } = arc(20, 270);
  assert.strictEqual(S.curves(shape, cum, [{ type: 26, at: 990 }, { type: 27, at: 1095 }]).length, 0);
});

const sq = (w, s, e, nn) => [[w, s], [e, s], [e, nn], [w, nn], [w, s]];
const zone = { name: "Z", bbox: [11.6, 47.9, 11.7, 48.0], rings: [sq(11.6, 47.9, 11.7, 48.0)], holes: [], tags: {} };
ok("point in zone, hole, bbox", () => {
  assert(S.inZone([11.65, 47.95], zone)); assert(!S.inZone([11.55, 47.95], zone));
  const h = { ...zone, holes: [sq(11.64, 47.94, 11.66, 47.96)] };
  assert(!S.inZone([11.65, 47.95], h)); assert(S.inZone([11.61, 47.91], h));
});
ok("route entering a zone: one entry at the boundary", () => {
  const xs = []; for (let x = 11.5; x <= 11.8; x += 0.01) xs.push([x, 47.95]);
  const cum = [0]; for (let i = 1; i < xs.length; i++) cum.push(cum[i - 1] + dist(xs[i - 1], xs[i]));
  const e = S.lezEntries(xs, cum, [zone]);
  assert.strictEqual(e.length, 1); assert(Math.abs(e[0].at - cum[10]) < cum[1] * 1.5, "at " + e[0].at);
  assert.strictEqual(S.lezEntries(xs, cum, [{ ...zone, tags: { end_date: "2020-01-01" } }]).length, 0, "an ended zone is ignored");
});
ok("break reminder: due after the interval of driving, reset by a 15 min stop", () => {
  const b = new S.BreakWatch(), H = 3600000;
  let t = 0, due = 0;
  for (; t <= 2 * H + 60000; t += 30000) if (b.step(25, t, 2 * H).due) due++;
  assert.strictEqual(due, 1, "once at 2 h");
  for (let k = 0; k < 40; k++) { t += 30000; b.step(0, t, 2 * H); }   // 20 min stopped
  assert(b.drive === 0, "reset after the stop");
  let again = 0; for (let k = 0; k < 100; k++) { t += 30000; if (b.step(25, t, 2 * H).due) again++; }
  assert.strictEqual(again, 0, "50 min after the break: nothing");
  const c = new S.BreakWatch(); let cnt = 0; for (let u = 0; u <= 3 * H; u += 30000) if (c.step(25, u, 2 * H).due) cnt++;
  assert.strictEqual(cnt, 3, "at 2 h, 2.5 h, 3 h (every 30 min after the first)");
});
ok("polyline6 encoder", () => {
  const p = [[11.55, 48.14], [11.551234, 48.140001], [-0.5, 51.5]];
  const s = S.encode6(p);
  let i = 0, lat = 0, lon = 0; const out = [];
  while (i < s.length) { for (const k of [0, 1]) { let sh = 0, r = 0, b; do { b = s.charCodeAt(i++) - 63; r |= (b & 31) << sh; sh += 5; } while (b >= 32); const d = r & 1 ? ~(r >> 1) : r >> 1; k ? lon += d : lat += d; } out.push([lon / 1e6, lat / 1e6]); }
  assert.deepStrictEqual(out, p);
});
ok("pick: nearest hazard in its warn distance; curves only when too fast", () => {
  const list = [{ type: "crossing", at: 1150 }, { type: "curve", at: 1100, kmh: 40 }, { type: "camera", at: 5000 }];
  assert.strictEqual(S.pick(list, 1000, 25, 90).h.type, "curve");
  assert.strictEqual(S.pick(list, 1000, 12, 43).h.type, "crossing", "43 km/h is fine for a 40 km/h curve");
  assert.strictEqual(S.pick(list, 0, 25, 90), null, "too far for anything");
  assert.strictEqual(S.pick(list, 1200, 25, 90), null, "passed");
});
ok("merge: points of one crossing / camera pair become one alert, different types stay", () => {
  const m = S.merge([{ type: "crossing", at: 1007 }, { type: "crossing", at: 1000 }, { type: "camera", at: 1010 }, { type: "crossing", at: 1200 }, { type: "camera", at: 1021 }]);
  assert.deepStrictEqual(m.map(h => h.type + h.at), ["crossing1000", "camera1010", "crossing1200"]);
});
console.log(n + " passed");
