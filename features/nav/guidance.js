/* nav-pi guidance engine: follows a Valhalla route, independent of where positions come from
   (GPS or simulation). Pure logic, no map/DOM. */
"use strict";
const MANEUVER_ICON = {
  // Valhalla maneuver type -> [symbol, mirrored(left)]
  1: ["m-straight"], 2: ["m-turn"], 3: ["m-turn", 1], 4: ["m-dest"], 5: ["m-dest"], 6: ["m-dest"],
  7: ["m-straight"], 8: ["m-straight"], 9: ["m-slight"], 10: ["m-turn"], 11: ["m-sharp"],
  12: ["m-uturn"], 13: ["m-uturn", 1], 14: ["m-sharp", 1], 15: ["m-turn", 1], 16: ["m-slight", 1],
  17: ["m-straight"], 18: ["m-slight"], 19: ["m-slight", 1], 20: ["m-slight"], 21: ["m-slight", 1],
  22: ["m-straight"], 23: ["m-slight"], 24: ["m-slight", 1], 25: ["m-merge"], 26: ["m-round"], 27: ["m-slight"],
  28: ["m-straight"], 29: ["m-straight"], 37: ["m-merge"], 38: ["m-merge", 1],
};
// recorded voice pack (tools/build_voicepack.py): Valhalla maneuver type -> clip key
const CUE_ACTION = { 8: "straight", 9: "slight_right", 10: "turn_right", 11: "sharp_right", 12: "uturn", 13: "uturn",
  14: "sharp_left", 15: "turn_left", 16: "slight_left", 17: "ramp_straight", 18: "ramp_right", 19: "ramp_left",
  20: "exit_right", 21: "exit_left", 22: "keep_straight", 23: "keep_right", 24: "keep_left", 25: "merge",
  28: "ferry", 37: "merge_right", 38: "merge_left", 4: "arrive", 5: "arrive", 6: "arrive" };
const CUE_KMS = [1, 1.5, 2, 2.5, 3, 3.5, 4, 4.5, 5, 6, 7, 8, 9, 10];
function cueAction(m) {
  if (m.type === 26) { const n = m.roundabout_exit_count; return n >= 1 && n <= 8 ? "roundabout_" + n : "roundabout"; }
  return CUE_ACTION[m.type] || null;
}
function cueDist(d) {
  if (d < 1000) return "in_" + Math.max(50, Math.min(950, Math.round(d / 50) * 50)) + "m";
  const km = Math.round(d / 500) / 2;
  const k = CUE_KMS.reduce((a, b) => Math.abs(b - km) < Math.abs(a - km) ? b : a);
  return Math.abs(k - km) <= 0.5 ? "in_" + String(k).replace(".", "_") + "km" : null;
}
function maneuverSvg(type, cls) {
  const [sym, left] = MANEUVER_ICON[type] || ["m-straight"];
  return `<svg viewBox="0 0 48 48" class="${cls || ""}"${left ? ' style="transform:scaleX(-1)"' : ""}><use href="#${sym}"/></svg>`;
}

// all legs of a trip as one shape (PN-37 multi-stop); off[i] = index of leg i's first point in it
function tripShape(trip) {
  const shape = [], off = [];
  for (const leg of trip.legs) {
    const s = U.decodePolyline(leg.shape);
    off.push(Math.max(0, shape.length - 1));
    shape.push(...(shape.length ? s.slice(1) : s));   // a leg starts where the previous one ended
  }
  return { shape, off };
}

// PN-48 "major turns only": which maneuvers are still announced.
// Major = every ramp, exit, fork/keep and merge (Valhalla types 17-25, 37, 38), roundabouts (26), ferries (28, 29),
// U-turns (12, 13), and a turn or continue (7-11, 14-16) onto a numbered road (A 5, B 3, L 605, E 35, D 1083 …)
// that the road before was not. Start, arrival and stops are always spoken. Everything else (turns into named
// streets in town) shows in the banner but is not spoken.
const REF_RE = /^[A-Z]{1,3} ?\d/;
function isMajor(m, prev) {
  const t = m.type;
  if ((t >= 17 && t <= 25) || t === 37 || t === 38 || t === 26 || t === 28 || t === 29 || t === 12 || t === 13) return true;
  if (!((t >= 7 && t <= 11) || (t >= 14 && t <= 16))) return false;
  const refs = n => (n || []).filter(x => REF_RE.test(x));
  const before = new Set(refs(prev && prev.street_names));
  return refs(m.street_names).some(r => !before.has(r));
}

class Guidance {
  // opt.walk: a pedestrian route (PN-39 back to the car): no speed limits
  constructor(trip, opt = {}) {
    const { shape, off } = tripShape(trip), legs = trip.legs;
    this.shape = shape;
    this.cum = [0];
    for (let i = 1; i < this.shape.length; i++) this.cum.push(this.cum[i - 1] + U.dist(this.shape[i - 1], this.shape[i]));
    this.total = this.cum[this.cum.length - 1];
    // one maneuver list for all legs; the destination maneuver of a leg that is not the last one is a stop
    this.man = [];
    legs.forEach((leg, li) => leg.maneuvers.forEach(m => this.man.push({ ...m, at: this.cum[off[li] + m.begin_shape_index], said: 0,
      leg: li, pt: this.shape[off[li] + m.begin_shape_index],
      stop: li < legs.length - 1 && m.type >= 4 && m.type <= 6 ? li + 1 : 0 })));
    this.legShapes = legs.map(l => l.shape);
    this.stops = off.slice(1).map(i => this.cum[i]);   // metres along the shape of each intermediate stop
    this.passed = 0;                                    // stops reached so far
    this.totalTime = trip.summary.time;
    this.seg = 0;
    this.off = 0;
    this.arrived = false;
    this.limits = null;   // [{from,to,kmh}] along the shape, filled in async (speedlimit.js); null = not loaded
    if (opt.walk || typeof SpeedLimits === "undefined") this.limits = [];
    else if (legs.length === 1) SpeedLimits.load(this, legs[0].shape);
    else {  // per leg, on that leg's slice of the distance axis, then joined in order
      const parts = legs.map((l, i) => ({ cum: this.cum.slice(off[i]), limits: null }));
      Promise.all(parts.map((p, i) => SpeedLimits.load(p, legs[i].shape))).then(() => { this.limits = parts.flatMap(p => p.limits || []); });
    }
    // PN-36/40 lanes + junction shape per maneuver (lanes.js -> /api/lanes), filled in async; none for a walk
    if (!opt.walk && typeof Lanes !== "undefined") Lanes.load(this);
  }
  // pos [lon,lat], speed m/s -> state
  update(pos, speed) {
    let best = null;
    const lo = Math.max(0, this.seg - 3), hi = Math.min(this.shape.length - 1, this.seg + 80);
    for (let i = lo; i < hi; i++) {
      const p = U.project(pos, this.shape[i], this.shape[i + 1]);
      if (!best || p.d < best.d) best = { ...p, i };
    }
    if (!best) return { offRoute: true };
    const thresh = 35 + Math.min(40, (speed || 0) * 1.5);
    if (best.d > thresh) this.off++; else { this.off = 0; this.seg = best.i; }
    const s = this.seg === best.i ? best : { i: this.seg, t: 0, pt: this.shape[this.seg] };
    const along = this.cum[s.i] + (this.cum[s.i + 1] - this.cum[s.i]) * s.t;
    // current maneuver = last one that begins at or before this point; next = the one after
    let k = 0;
    while (k + 1 < this.man.length && this.man[k + 1].at <= along + 1) k++;
    const next = this.man[k + 1] || this.man[k];
    const after = this.man[k + 2];
    const toNext = Math.max(0, next.at - along);
    const remain = Math.max(0, this.total - along);
    // remaining time: rest of current maneuver (proportional) + all later maneuvers
    const cur = this.man[k];
    const curLen = Math.max(1, (next.at - cur.at));
    let rt = cur.time * Math.min(1, toNext / curLen);
    for (let j = k + 1; j < this.man.length; j++) rt += this.man[j].time;
    if (remain < 30 && !this.arrived) this.arrived = true;
    let reached = 0;   // PN-37: number of the stop reached at this update (once per stop), 0 = none
    while (this.passed < this.stops.length && along >= this.stops[this.passed] - 30) reached = ++this.passed;
    const ahead = this.shape[Math.min(this.shape.length - 1, s.i + 1)];
    return {
      offRoute: this.off >= 3, snapped: s.pt, routeBearing: U.bearing(s.pt, ahead === s.pt ? this.shape[s.i] : ahead),
      along, limit: typeof SpeedLimits !== "undefined" ? SpeedLimits.at(this.limits, along) : null, remain, remainTime: rt, toNext, next, after, nextIndex: k + 1, arrived: this.arrived, reached,
      say: this.voice(next, toNext, speed || 0, k + 1),
    };
  }
  // announcement for the upcoming maneuver, at most once per stage
  voice(m, d, v, idx) {
    if (idx === 0 || !m) return null;
    // PN-48 voice options (features/voice/voice.js): mute is applied in U.speak; here: short style, major turns only
    const vo = typeof VoiceOpts !== "undefined" ? VoiceOpts.get() : { style: "full", turns: "all" };
    if (vo.turns === "major" && !m.stop && !(m.type >= 4 && m.type <= 6) && !isMajor(m, this.man[idx - 1])) { m.said = 2; return null; }
    const short = vo.style === "short";
    const far = v > 25 ? 2000 : v > 14 ? 1000 : 400;     // motorway / rural / town
    const near = Math.max(60, v * 6);                      // ~6 s before the turn
    // short: the first sentence of Valhalla's succinct form ("Turn left.") - no street names, no "Then …" second cue
    const pre = short ? ((m.verbal_succinct_transition_instruction || m.verbal_pre_transition_instruction || m.instruction || "").trim().split(/(?<=\.)\s+/)[0])
      : (m.verbal_pre_transition_instruction || m.instruction || "").trim();
    // lowercase only a leading instruction word, never a street or place name
    const lower = s => /^(Rechts|Links|Leicht|Scharf|Geradeaus|Auf|In|Halten|Wenden|Weiter|Den|Die|Der|Das|Am|Im|Bei|Nehmen|Fahren|Bleiben|Ausfahrt|Abfahrt|Turn|Bear|Keep|Make|Take|Continue|Merge|Enter|Exit|Head|Drive|Go|Stay)\b/.test(s)
      ? s.charAt(0).toLowerCase() + s.slice(1) : s;
    const act = cueAction(m), dk = cueDist(d);
    if (m.said < 2 && d <= near) {
      m.said = 2;
      if (m.stop) return { text: T("say.stop"), cue: ["stop_reached"] };   // an intermediate stop: the drive goes on
      return { text: pre, cue: act ? [m.type >= 4 && m.type <= 6 ? "arrived" : "now_" + act] : null };
    }
    if (m.stop) return null;  // no early "destination ahead" for a stop
    const prevLen = idx > 0 ? m.at - this.man[idx - 1].at : 1e9;
    if (short && v <= 20) return null;   // short style: in town and on rural roads one prompt per maneuver (the near one)
    if (m.said < 1 && d <= far && d > near * 2 && prevLen > far * 0.6) {
      m.said = 1;
      const alert = short ? pre : (m.verbal_transition_alert_instruction || pre).trim();
      const text = LANG === "de" ? "In " + U.spokenDist(d) + " " + lower(alert) : "In " + U.spokenDist(d) + ", " + lower(alert);
      return { text, cue: act && dk ? [dk, act] : null };
    }
    return null;
  }
}
