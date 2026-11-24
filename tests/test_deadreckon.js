// Unit test for features/gps/deadreckon.js (tunnel estimate along the route) with the real core/util.js.   node tests/test_deadreckon.js
"use strict";
const vm = require("vm"), fs = require("fs"), path = require("path");
const root = path.join(__dirname, "..", "features");
let fails = 0;
const ok = (name, c) => { if (!c) fails++; console.log((c ? "PASS " : "FAIL ") + name); };

function make() {
  const events = [];
  const ctx = vm.createContext({ console, Math, Date, setInterval: () => 1, clearInterval: () => {}, localStorage: { getItem: () => null, setItem() {} },
    document: {}, location: { origin: "http://x" } });
  ctx.window = ctx;
  ctx.CustomEvent = class { constructor(t, o) { this.type = t; this.detail = o && o.detail; } };
  ctx.dispatchEvent = e => events.push(e);
  vm.runInContext(fs.readFileSync(path.join(root, "core", "util.js"), "utf8"), ctx);
  vm.runInContext(fs.readFileSync(path.join(root, "gps", "deadreckon.js"), "utf8"), ctx);
  return { ctx, events, DR: vm.runInContext("DeadReckon", ctx), U: vm.runInContext("U", ctx) };
}
// a straight route north from Munich, 6 km, as the Guidance object exposes it (shape, cum, total, seg)
function route(U) {
  const shape = [], n = 60;
  for (let i = 0; i <= n; i++) shape.push([11.575, 48.14 + i * 0.0009]);   // ~100 m per point
  const cum = [0];
  for (let i = 1; i < shape.length; i++) cum.push(cum[i - 1] + U.dist(shape[i - 1], shape[i]));
  return { shape, cum, total: cum[cum.length - 1], seg: 0 };
}
function scene(speed, fixAt = 1000) {
  const s = make(), g = route(s.U);
  let t = 1e6, nav = true; const out = [];
  s.DR.now = () => t;
  s.DR.attach({ guide: () => (nav ? g : null), emit: p => out.push(p) });
  const fix = { lng: 11.575, lat: 48.14 + fixAt / 111195, speed, track: 0 };
  return { ...s, g, out, tick: sec => { t += sec * 1000; }, nav: v => { nav = v; }, fix };
}

{ // moving, then the fix is lost: the estimate follows the route at the last speed
  const s = scene(15);
  s.DR.update(s.fix);
  ok("no estimate while a fix is there", s.out.length === 0 && !s.DR.on());
  s.tick(10); s.DR.update(null);
  const p = s.out.at(-1);
  ok("estimate emitted, marked est", p && p.src === "est" && s.DR.on());
  ok("estimate is on the route (lon)", Math.abs(p.lng - 11.575) < 1e-9);
  const ahead = s.U.dist([11.575, s.fix.lat], [p.lng, p.lat]);
  ok("moved 150 m in 10 s at 15 m/s (got " + ahead.toFixed(1) + ")", Math.abs(ahead - 150) < 1.5);
  ok("heading = route bearing (north)", Math.abs(p.track) < 0.5 || Math.abs(p.track - 360) < 0.5);
  ok("confidence decays, < 1 and > 0.8 (got " + p.conf.toFixed(3) + ")", p.conf < 1 && p.conf > 0.8);
  s.tick(30); s.DR.step();
  const q = s.out.at(-1);
  ok("later estimate is further, less confident", q.lat > p.lat && q.conf < p.conf);
  ok("event on was sent once", s.events.filter(e => e.type === "navpi:gps-est" && e.detail.on).length === 1);
  s.DR.update(s.fix);   // the fix returns: snap back = DR stops, the real fix takes over in maps.js
  ok("fix returns: estimating stops, event off", !s.DR.on() && s.events.at(-1).detail.on === false);
}
{ // time limit: 120 s
  const s = scene(10);
  s.DR.update(s.fix); s.tick(119); s.DR.update(null);
  ok("still estimating at 119 s", s.DR.on());
  s.tick(2); s.DR.step();
  ok("stops after 120 s", !s.DR.on());
  const n = s.out.length; s.DR.update(null); s.DR.step();
  ok("stays stopped until a real fix", s.out.length === n && !s.DR.on());
}
{ // distance limit: 3 km (speed capped at 40 m/s -> 75 s)
  const s = scene(60);   // 60 m/s is capped to 40
  s.DR.update(s.fix); s.tick(10); s.DR.update(null);
  const d = s.U.dist([11.575, s.fix.lat], [s.out.at(-1).lng, s.out.at(-1).lat]);
  ok("speed capped at 40 m/s (got " + d.toFixed(0) + " m in 10 s)", Math.abs(d - 400) < 4);
  s.tick(70); s.DR.step();
  ok("stops after 3 km", !s.DR.on());
}
{ // no estimate when standing, off the route, without a route, or when navigation ended
  let s = scene(1.0); s.DR.update(s.fix); s.tick(5); s.DR.update(null);
  ok("standing still: nothing to estimate", s.out.length === 0 && !s.DR.on());
  s = scene(15); s.DR.update({ ...s.fix, lng: 11.5770 }); s.tick(5); s.DR.update(null);   // ~150 m beside the route
  ok("fix off the route: no estimate", s.out.length === 0);
  s = scene(15); s.nav(false); s.DR.update(s.fix); s.tick(5); s.DR.update(null);
  ok("no route: no estimate", s.out.length === 0);
  s = scene(15); s.DR.update(s.fix); s.tick(5); s.DR.update(null); s.nav(false); s.tick(2); s.DR.step();
  ok("navigation ended: estimating stops", !s.DR.on());
  s = scene(15, 5800); s.DR.update(s.fix); s.tick(30); s.DR.update(null);
  ok("route end: nothing beyond the destination", s.out.length === 0 && !s.DR.on());
}
console.log(fails ? fails + " FAILED" : "all passed");
process.exit(fails ? 1 : 0);
