// Unit test for features/core/solar.js against published sunrise/sunset times.   node tests/test_solar.js
"use strict";
const Solar = require("../features/core/solar.js");
let fails = 0;
const min = d => d.getUTCHours() * 60 + d.getUTCMinutes();
const hm = s => { const [h, m] = s.split(":").map(Number); return h * 60 + m; };
const fmt = m => Math.floor(m / 60) + ":" + String(m % 60).padStart(2, "0");
function near(name, got, want, tol) {   // UTC minutes of day, wrap-safe
  const diff = Math.abs(((got - want + 720 + 1440) % 1440) - 720);
  const ok = diff <= tol; if (!ok) fails++;
  console.log((ok ? "PASS " : "FAIL ") + name + " got " + fmt(got) + " want " + fmt(want));
}
// [place, lat, lon, date (noon UTC), sunrise UTC, sunset UTC]  (Helsinki/Sydney: timeanddate.com; Munich: independent NOAA sunrise-equation run; Quito: independent Wikipedia sunrise-equation run, +-1 min)
const CASES = [
  ["Munich 2026-06-21", 48.137, 11.575, "2026-06-21T12:00:00Z", "03:13", "19:17"],
  ["Munich 2026-12-21", 48.137, 11.575, "2026-12-21T12:00:00Z", "07:01", "15:22"],
  ["Helsinki 2026-06-21", 60.170, 24.938, "2026-06-21T12:00:00Z", "00:54", "19:50"],
  ["Helsinki 2026-12-21", 60.170, 24.938, "2026-12-21T12:00:00Z", "07:24", "13:12"],
  ["Sydney 2026-12-21", -33.869, 151.209, "2026-12-21T12:00:00Z", "18:41", "09:05"],
  ["Quito 2026-03-20", -0.18, -78.47, "2026-03-20T12:00:00Z", "11:17", "23:24"],
];
for (const [n, la, lo, d, r, s] of CASES) {
  const t = Solar.times(la, lo, new Date(d));
  if (!t.rise) { fails++; console.log("FAIL " + n + " no rise/set"); continue; }
  near(n + " rise", min(t.rise), hm(r), 4); near(n + " set", min(t.set), hm(s), 4);
}
function eq(name, a, b) { const ok = a === b; if (!ok) fails++; console.log((ok ? "PASS " : "FAIL ") + name + " (" + a + ")"); }
eq("Tromso June = polar day", Solar.times(69.65, 18.96, new Date("2026-06-21T12:00:00Z")).polar, "day");
eq("Tromso December = polar night", Solar.times(69.65, 18.96, new Date("2026-12-21T12:00:00Z")).polar, "night");
eq("Tromso midnight sun isDay at 00:30 UTC", Solar.isDay(69.65, 18.96, new Date("2026-06-21T00:30:00Z")), true);
eq("Tromso polar night isDay at noon", Solar.isDay(69.65, 18.96, new Date("2026-12-21T11:00:00Z")), false);
eq("Antarctica (-80) December = polar day", Solar.times(-80, 0, new Date("2026-12-21T12:00:00Z")).polar, "day");
eq("Munich isDay 2026-06-21 12:00 UTC", Solar.isDay(48.137, 11.575, new Date("2026-06-21T12:00:00Z")), true);
eq("Munich isDay 2026-06-21 22:30 UTC", Solar.isDay(48.137, 11.575, new Date("2026-06-21T22:30:00Z")), false);
eq("Munich isDay 2026-12-21 03:00 UTC", Solar.isDay(48.137, 11.575, new Date("2026-12-21T03:00:00Z")), false);
eq("Sydney isDay 2026-12-21 22:00 UTC (08:00 local)", Solar.isDay(-33.869, 151.209, new Date("2026-12-21T22:00:00Z")), true);
const f = Solar.times(-17.7, 178.0, new Date("2026-03-20T12:00:00Z")); eq("Fiji (date line) rise < set", f.rise < f.set, true);
console.log(fails ? fails + " FAILED" : "all passed"); process.exit(fails ? 1 : 0);
