// GPS status page + dead reckoning (PN-52), Playwright against a local navd that reads a FAKE gpsd (tests/fake_gpsd.py).
//   Start navd with GPSD_PORT=<gpsd port> (default 29470) and VALHALLA_URL=<valhalla>, then:
//   node tools/ui-gps.mjs [base-url] [out-dir] [WxH]       env: GPSD_PORT, GPSD_CTL (control port), PLAYWRIGHT_DIR
// The test routes Munich Hauptbahnhof -> Garching through navd (/api/route), starts the fake gpsd with that road as the path,
// then checks: no receiver -> status page + tile; fix -> sky plot, bars, compass, values; guidance with the real GPS,
// fix lost (tunnel) -> grey estimated arrow + chip "GPS estimate", close to where the car really is; fix back -> snaps.
import { createRequire } from "module";
import { spawn } from "child_process";
import net from "net";
import fs from "fs";
const require = createRequire(import.meta.url);
const { chromium } = require(process.env.PLAYWRIGHT_DIR || "playwright");
const base = process.argv[2] || "http://127.0.0.1:18095";
const out = process.argv[3] || new URL("./shots", import.meta.url).pathname;
const [w, h] = (process.argv[4] || "720x1280").split("x").map(Number);
const tag = w > h ? "land" : "port";
const GP = +(process.env.GPSD_PORT || 29470), CP = +(process.env.GPSD_CTL || 29471);
const root = new URL("..", import.meta.url).pathname;
let fails = 0;
const check = (n, ok) => { if (!ok) fails++; console.log((ok ? "PASS " : "FAIL ") + n); };
const sleep = ms => new Promise(r => setTimeout(r, ms));
fs.mkdirSync(out, { recursive: true });

function decode(str) {   // Valhalla polyline6 -> [[lon, lat]]
  let i = 0, lat = 0, lon = 0; const o = [];
  while (i < str.length) {
    for (const k of [0, 1]) { let s = 0, r = 0, b; do { b = str.charCodeAt(i++) - 63; r |= (b & 31) << s; s += 5; } while (b >= 32); const d = r & 1 ? ~(r >> 1) : r >> 1; k ? lon += d : lat += d; }
    o.push([lon / 1e6, lat / 1e6]);
  }
  return o;
}
const dist = (a, b) => { const R = 6371000, p = Math.PI / 180, dl = (b[1] - a[1]) * p, dn = (b[0] - a[0]) * p * Math.cos((a[1] + b[1]) / 2 * p); return R * Math.hypot(dl, dn); };
function ctl(cmd) {
  return new Promise((res, rej) => { const c = net.connect(CP, "127.0.0.1", () => c.write(cmd + "\n")); c.setTimeout(3000, () => rej(new Error("ctl timeout")));
    c.on("data", d => { res(String(d).trim()); c.end(); }); c.on("error", rej); });
}

// 1. a real road from navd (Valhalla) is the fake gpsd's path
const A = { lat: 48.1402, lon: 11.5600 }, B = { lat: 48.2490, lon: 11.6510, name: "Garching" };
const rr = await fetch(base + "/api/route", { method: "POST", headers: { "Content-Type": "application/json" },
  body: JSON.stringify({ locations: [A, B], costing: "auto", directions_options: { language: "en-US" } }) }).then(r => r.json());
const path = decode(rr.trip.legs[0].shape);
fs.writeFileSync("/tmp/ui-gps-path.json", JSON.stringify(path));
const fake = spawn("python3", [root + "tests/fake_gpsd.py", "--port", String(GP), "--control", String(CP), "--path", "/tmp/ui-gps-path.json", "--speed", "15", "--state", "unplugged"], { stdio: "inherit" });
await sleep(1200);

const b = await chromium.launch({ args: ["--use-angle=swiftshader", "--enable-unsafe-swiftshader", "--ignore-gpu-blocklist"] });
const p = await b.newPage({ viewport: { width: w, height: h }, hasTouch: true });
const errs = [];
p.on("pageerror", e => errs.push(e.message));
p.on("console", m => m.type() === "error" && !/tiles|fonts|glyphs|502|404|api\/display|api\/speak/.test(m.text() + (m.location().url || "")) && errs.push(m.text() + " @ " + m.location().url));
const shot = n => p.screenshot({ path: `${out}/${tag}-gps-${n}.png`, timeout: 90000 }).catch(e => console.log("shot " + n + " skipped"));
const txt = s => p.$eval(s, e => e.textContent);
await p.addInitScript(() => { window.__pos = []; addEventListener("navpi:pos", e => window.__pos.push({ src: e.detail.src, lng: e.detail.lng, lat: e.detail.lat, t: Date.now(), conf: e.detail.conf })); });
try {
  await p.goto(base + "/"); await p.waitForTimeout(3500);   // navd connects to the fake gpsd within 3 s

  // A: no receiver
  check("status bar: No GPS", (await txt("#gps-text")) === "No GPS");
  await p.click("#dock [data-go=gps]"); await p.waitForTimeout(1500);
  check("GPS page (rail) shows the GPS card", await p.$eval("#gps", e => e.classList.contains("active")) && await p.isVisible("#gps-card"));
  check("card header: No receiver", (await txt("#gps-state")) === "No receiver");
  check("page says No GPS receiver connected", await p.isVisible("#gps-none") && (await txt("#gps-none")).includes("No GPS receiver connected") && (await txt("#gps-none")).includes("u-blox USB"));
  check("no sky plot without a receiver", !(await p.isVisible("#gps-body")));
  await shot("2-settings-none");

  // B: fix
  await ctl("fix"); await p.waitForTimeout(2500);
  check("No-receiver notice gone", !(await p.isVisible("#gps-none")));
  check("status shows 3D fix", (await txt("#gps-state")) === "3D fix");
  check("sky plot: 12 satellites, 8 used", await p.locator("#gps-sky g.sat").count() === 12 && await p.locator("#gps-sky g.sat.used").count() === 8);
  check("signal bars: 12, 8 used", await p.locator("#gps-bars .b").count() === 12 && await p.locator("#gps-bars .b.used").count() === 8);
  const vals = await txt("#gps-vals");
  check("values: satellites 8 / 12, accuracy +-4 m, speed 54 km/h", vals.includes("8 / 12") && vals.includes("±4 m") && vals.includes("54 km/h"));
  check("values: receiver u-blox /dev/ttyACM0, GPS time in UTC", vals.includes("u-blox") && vals.includes("/dev/ttyACM0") && /\d\d:\d\d:\d\d UTC/.test(vals));
  check("compass: heading text + needle", /^\d+° /.test(await txt("#gps-hd")) && await p.locator("#gps-needle").count() === 1);
  await shot("3-settings-fix");
  await p.click("#dock [data-go=maps]"); await p.waitForTimeout(500);

  // C: guidance with the real GPS, then a tunnel
  await p.evaluate(d => { Maps.preview(d); }, { name: B.name, ctx: "test", lat: B.lat, lon: B.lon });
  await p.waitForSelector("#s-go", { state: "visible", timeout: 30000 }); await p.waitForTimeout(800);
  await p.click("#s-go"); await p.waitForTimeout(6000);
  check("guidance runs on the real GPS (positions src=gps)", await p.evaluate(() => window.__pos.slice(-3).every(x => x.src === "gps")));
  check("chip says GPS", (await txt("#gps-text")) === "GPS");
  await ctl("loss"); await p.waitForTimeout(6000);
  const est = await p.evaluate(() => window.__pos.filter(x => x.src === "est"));
  check("estimated positions arrive during the fix loss (" + est.length + ")", est.length >= 4);
  check("chip says GPS estimate", (await txt("#gps-text")) === "GPS estimate");
  check("grey arrow (puck.est)", await p.locator(".puck.est").count() === 1);
  check("confidence decays", est.length > 2 && est.at(-1).conf < est[0].conf && est.at(-1).conf > 0.5);
  const truth = (await ctl("pos")).split(" ").map(Number);
  const e = est.at(-1);
  const err = dist([e.lng, e.lat], truth);
  check("estimate is near the real car (error " + err.toFixed(0) + " m)", err < 60);
  await p.click("#dock [data-go=gps]"); await p.waitForTimeout(1500);
  check("GPS page: GPS estimate", (await txt("#gps-state")) === "GPS estimate");
  await shot("5-estimate-page");
  await p.click("#dock [data-go=maps]"); await p.waitForTimeout(400);
  await shot("6-estimate-map");
  await ctl("fix"); await p.waitForTimeout(3000);
  const back = await p.evaluate(() => window.__pos.slice(-2));
  check("fix back: real positions again, no grey arrow", back.every(x => x.src === "gps") && await p.locator(".puck.est").count() === 0);
  check("chip says GPS again", (await txt("#gps-text")) === "GPS");
  const snap = dist([back[1].lng, back[1].lat], (await ctl("pos")).split(" ").map(Number));
  check("snapped to the real position (" + snap.toFixed(0) + " m)", snap < 40);

  // D: German
  await p.evaluate(() => { setLang("de"); Shell.relang(); });
  await p.click("#dock [data-go=gps]"); await p.waitForTimeout(1500);
  check("German GPS page: 3D-Fix", (await txt("#gps-state")) === "3D-Fix");
  await p.evaluate(() => setLang("en"));
} catch (e) { fails++; console.log("FAIL exception: " + e.message); await shot("x-error"); }
console.log(errs.length ? "PAGE ERRORS:\n" + errs.join("\n") : "no page errors");
await b.close(); fake.kill();
process.exit(fails || errs.length ? 1 : 0);
