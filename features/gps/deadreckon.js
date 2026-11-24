/* gps feature: dead reckoning along the route (tunnels). While guidance is running and the GPS fix is lost, the position
   is estimated by moving along the route at the last speed; the app shows it as an estimate (grey arrow, chip "GPS estimate")
   and snaps back when a real fix returns. Limits: only with a route, only if the car was moving (>= MIN_V), speed capped,
   at most MAX_S seconds / MAX_M metres since the last real fix, confidence falls linearly from 1 to 0 with the larger of
   the two shares. Pure logic + one timer; no DOM. maps.js feeds it (DeadReckon.update) and gives it the guide and a
   callback (DeadReckon.attach). Works with U.project / U.dist / U.bearing (core util). */
"use strict";
const DeadReckon = (() => {
  const MIN_V = 2.5, MAX_V = 40, MAX_S = 120, MAX_M = 3000, TICK_MS = 1000;
  let hooks = null, last = null, timer = null, active = false, conf = 0;
  const clock = () => (DeadReckon.now ? DeadReckon.now() : Date.now());

  function attach(h) { hooks = h; }            // {guide: () => Guidance | null, emit: pos => void}
  // metres along the guide's shape of a real fix (searches near the current segment, like Guidance.update)
  function alongOf(g, p) {
    let best = null;
    const lo = Math.max(0, g.seg - 3), hi = Math.min(g.shape.length - 1, g.seg + 80);
    for (let i = lo; i < hi; i++) {
      const r = U.project(p, g.shape[i], g.shape[i + 1]);
      if (!best || r.d < best.d) best = { i, t: r.t, d: r.d };
    }
    if (!best || best.d > 60) return null;          // not on the route: nothing to follow
    return g.cum[best.i] + (g.cum[best.i + 1] - g.cum[best.i]) * best.t;
  }
  function pointAt(g, along) {   // [lon,lat] and heading at a distance along the shape
    const a = Math.max(0, Math.min(g.total, along));
    let lo = 0, hi = g.cum.length - 1;
    while (hi - lo > 1) { const m = (lo + hi) >> 1; if (g.cum[m] <= a) lo = m; else hi = m; }
    const s = g.cum[hi] - g.cum[lo] || 1, t = (a - g.cum[lo]) / s;
    const A = g.shape[lo], B = g.shape[hi];
    return { lng: A[0] + (B[0] - A[0]) * t, lat: A[1] + (B[1] - A[1]) * t, track: U.bearing(A, B) };
  }
  function stop() {
    if (timer) clearInterval(timer);
    timer = null;
    if (active) { active = false; conf = 0; window.dispatchEvent(new CustomEvent("navpi:gps-est", { detail: { on: false } })); }
  }
  function step() {
    const g = hooks && hooks.guide && hooks.guide();
    if (!last || !g || !g.shape) { last = null; return stop(); }
    const dt = (clock() - last.at) / 1000;
    const d = Math.min(last.v * dt, MAX_M + 1);
    if (dt > MAX_S || d > MAX_M || last.along + d >= g.total) { last = null; return stop(); }
    conf = Math.max(0, 1 - Math.max(dt / MAX_S, d / MAX_M));
    const p = pointAt(g, last.along + d);
    if (!active) { active = true; window.dispatchEvent(new CustomEvent("navpi:gps-est", { detail: { on: true } })); }
    hooks.emit({ lng: p.lng, lat: p.lat, speed: last.v, track: p.track, src: "est", conf });
  }
  // fix = {lng, lat, speed, track} for a real fix, null when the fix is gone
  function update(fix) {
    if (fix) {
      stop();
      const g = hooks && hooks.guide && hooks.guide();
      const along = g && g.shape ? alongOf(g, [fix.lng, fix.lat]) : null;
      last = along != null && (fix.speed || 0) >= MIN_V ? { at: clock(), v: Math.min(MAX_V, fix.speed), along } : null;
    } else if (last && !timer) {
      step();
      if (last) timer = setInterval(step, TICK_MS);
    }
  }
  return { attach, update, stop, step, on: () => active, conf: () => conf, MAX_S, MAX_M, MIN_V, MAX_V };
})();
if (typeof window !== "undefined") window.DeadReckon = DeadReckon;
