/* nav-pi: sunrise/sunset offline (NOAA solar calculator formulas, no library). Solar.times(lat, lon, date) ->
   {rise: Date|null, set: Date|null, polar: "day"|"night"|null}; Solar.isDay(lat, lon, date) -> boolean.
   Accuracy about 1-2 min up to ~72 deg latitude; sun centre 0.833 deg below the horizon (refraction + disc). */
"use strict";
const Solar = (() => {
  const rad = d => d * Math.PI / 180, deg = r => r * 180 / Math.PI;
  function sunAt(T) {   // T: Julian centuries since J2000 -> {decl (rad), eq (min)}
    const L0 = (280.46646 + T * (36000.76983 + T * 0.0003032)) % 360;
    const M = rad(357.52911 + T * (35999.05029 - 0.0001537 * T));
    const e = 0.016708634 - T * (0.000042037 + 0.0000001267 * T);
    const C = Math.sin(M) * (1.914602 - T * (0.004817 + 0.000014 * T)) + Math.sin(2 * M) * (0.019993 - 0.000101 * T) + Math.sin(3 * M) * 0.000289;
    const om = rad(125.04 - 1934.136 * T);
    const lam = rad(L0 + C - 0.00569 - 0.00478 * Math.sin(om));
    const eps = rad(23 + (26 + (21.448 - T * (46.815 + T * (0.00059 - T * 0.001813))) / 60) / 60 + 0.00256 * Math.cos(om));
    const y = Math.tan(eps / 2) ** 2, l0 = rad(L0);
    const eq = 4 * deg(y * Math.sin(2 * l0) - 2 * e * Math.sin(M) + 4 * e * y * Math.sin(M) * Math.cos(2 * l0)
      - 0.5 * y * y * Math.sin(4 * l0) - 1.25 * e * e * Math.sin(2 * M));
    return { decl: Math.asin(Math.sin(eps) * Math.sin(lam)), eq };
  }
  // sunrise hour angle in degrees, or "day" / "night" when the sun never sets / never rises
  function hourAngle(lat, decl) {
    const c = Math.cos(rad(90.833)) / (Math.cos(rad(lat)) * Math.cos(decl)) - Math.tan(rad(lat)) * Math.tan(decl);
    return c > 1 ? "night" : c < -1 ? "day" : deg(Math.acos(c));
  }
  function times(lat, lon, date) {
    const d0 = new Date(date.getTime() + lon / 15 * 3600e3);           // local solar date = UTC date shifted by longitude
    const day0 = Date.UTC(d0.getUTCFullYear(), d0.getUTCMonth(), d0.getUTCDate());
    const jd0 = day0 / 86400e3 + 2440587.5;                             // Julian day at 0h UT
    const at = min => sunAt((jd0 + min / 1440 - 2451545) / 36525);
    let s = at(720 - 4 * lon), noon = 720 - 4 * lon - s.eq;             // solar noon, two passes
    s = at(noon); noon = 720 - 4 * lon - s.eq;
    const ha0 = hourAngle(lat, s.decl);
    if (typeof ha0 === "string") return { rise: null, set: null, polar: ha0 };
    const ev = sign => {                                                // refine at the event time itself
      let m = noon + sign * 4 * ha0;
      for (let i = 0; i < 2; i++) {
        const q = at(m), ha = hourAngle(lat, q.decl);
        if (typeof ha === "string") return ha;
        m = 720 - 4 * lon - q.eq + sign * 4 * ha;
      }
      return new Date(day0 + m * 60000);
    };
    const rise = ev(-1), set = ev(1);
    if (typeof rise === "string" || typeof set === "string") return { rise: null, set: null, polar: typeof rise === "string" ? rise : set };
    return { rise, set, polar: null };
  }
  function isDay(lat, lon, date) {
    const t = times(lat, lon, date);
    return t.polar ? t.polar === "day" : date >= t.rise && date < t.set;
  }
  return { times, isDay };
})();
if (typeof module !== "undefined") module.exports = Solar;
