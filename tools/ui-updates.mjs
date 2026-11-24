// Updates flow (Playwright, PN-22/23) against a local navd with fake dirs + fake systemctl. Recipe:
//   T=/tmp/updui; rm -rf $T; mkdir -p $T/data $T/stick $T/state
//   python3 tools/build_edition.py --edition audio --hardware 50-rpi5-8gb --out $T/build >/dev/null
//   UPD_T=$T node tools/ui-updates.mjs --fixtures         (creates the installed region + the stick bundles, then exits)
//   NAV_DATA=$T/data NAV_UPDATE_DIRS=$T/stick NAV_STATE_DIR=$T/state NAV_SYSTEMCTL=$PWD/tests/fake-systemctl FAKE_SYSTEMCTL_LOG=$T/sysctl.log \
//     NAV_UPDATE_RESERVE=1000 NAV_PORT=18080 APP_DIR=$T/build/app EDITION_FILE=$T/build/edition.json python3 $T/build/navd/navd.py &
//   UPD_T=$T node tools/ui-updates.mjs [base-url] [out-dir] [WxH]        (kill navd by PID afterwards)
import { createRequire } from "module";
import fs from "fs";
import { execFileSync } from "child_process";
const require = createRequire(import.meta.url);
const T = process.env.UPD_T || "/tmp/updui", ROOT = new URL("..", import.meta.url).pathname;
if (process.argv[2] === "--fixtures") {
  // installed germany (OSM 2026-09-10) + a newer bundle on the "stick" + an absurdly big one (declared sizes x 1e6: does not fit)
  execFileSync("python3", ["-c", `
import json, os, shutil, sys
sys.path.insert(0, "${ROOT}tools")
import make_update_manifest as mk
T = "${T}"
def region(d, name, base, osm, size):
    for p, data in (("map/%s.pmtiles" % name, os.urandom(size)), ("map/BUILD-INFO", "region=%s bbox=5,47,15,55\\n  planetiler:osm:osmosisreplicationtime %sT04:00:00Z\\nbuilt=%sT10:00:00\\n" % (base, osm, osm)),
                    ("search/places.sqlite", os.urandom(size)), ("valhalla/valhalla_tiles.tar", os.urandom(size)), ("valhalla/valhalla.json", "{}")):
        os.makedirs(os.path.dirname(d + "/" + p), exist_ok=True)
        with open(d + "/" + p, "wb" if isinstance(data, bytes) else "w") as f: f.write(data)
region(T + "/data/germany-20260910", "germany-20260910", "germany", "2026-09-10", 400000)
os.symlink("germany-20260910", T + "/data/current")
src = T + "/src"; region(src, "germany", "germany", "2026-12-01", 3000000)
files, meta = mk.plan_map(src, "germany"); mk.pack(src, files, meta, T + "/stick/navpi-map-germany-2026-12-01")
m = json.load(open(T + "/stick/navpi-map-germany-2026-12-01/manifest.json")); m["region"] = "bigland"
for f in m["files"]: f["size"] *= 10 ** 6
m["files"][0]["path"] = "map/bigland.pmtiles"
os.makedirs(T + "/stick/navpi-map-big"); json.dump(m, open(T + "/stick/navpi-map-big/manifest.json", "w"))
`], { stdio: "inherit" });
  process.exit(0);
}
const { chromium } = require(process.env.PLAYWRIGHT_DIR || "playwright");
const base = process.argv[2] || "http://127.0.0.1:18080";
const out = process.argv[3] || new URL("./shots", import.meta.url).pathname;
const [w, h] = (process.argv[4] || "720x1280").split("x").map(Number);
const tag = w > h ? "land" : "port";
const CUR = () => fs.readlinkSync(T + "/data/current");
const b = await chromium.launch({ args: ["--use-angle=swiftshader", "--enable-unsafe-swiftshader"] });
const p = await b.newPage({ viewport: { width: w, height: h }, hasTouch: true });
const errs = [];
p.on("pageerror", e => errs.push(e.message));
p.on("console", m => m.type() === "error" && !m.text().startsWith("Failed to load resource") && errs.push(m.text()));
p.on("response", r => r.status() >= 400 && r.url().includes("/api/") && !/\/api\/(display|update)/.test(r.url()) && errs.push("HTTP " + r.status() + " " + r.url()));
const shot = async n => { await p.screenshot({ path: `${out}/updates-${tag}-${n}.png` }); console.log("shot", n); };
let bad = 0; const ok = (c, m) => { console.log(c ? "ok  " : "FAIL", m); if (!c) bad++; };
const openSettings = async () => { await p.click("#dock [data-go=settings]"); await p.click("#st-nav button[data-cat=system]"); await p.waitForTimeout(1200); await p.locator("#upd-card").scrollIntoViewIfNeeded(); };
const txt = async s => (await p.textContent(s)) || "";
const sysctl = () => fs.existsSync(T + "/sysctl.log") ? fs.readFileSync(T + "/sysctl.log", "utf8") : "";
await p.goto(base + "/"); await p.waitForTimeout(1500);
await openSettings(); await shot("1-card");
ok(/germany, OpenStreetMap 2026-09-10/.test(await txt("#upd-installed")), "installed map shown: " + await txt("#upd-installed"));
ok(await p.locator("#upd-regions .row").count() === 1, "one region listed");
// --- check: finds the new bundle and the big one
await p.click("#upd-check"); await p.waitForTimeout(1500); await shot("2-found");
const rows = p.locator("#upd-bundles .row");
ok(await rows.count() === 2, "two bundles found: " + await rows.count());
const good = rows.filter({ hasText: "Map germany" });
const gt = (await good.textContent()).replace(/\s+/g, " ");
ok(/OpenStreetMap 2026-12-01/.test(gt) && /newer than installed/.test(gt) && /2026-09-10/.test(gt), "dates + newer: " + gt);
// --- not enough space: explanation dialog, no Install button
await rows.filter({ hasText: "bigland" }).locator("button").click(); await p.waitForTimeout(500); await shot("3-nospace");
const dlg = await txt(".pwr-box");
ok(/Not enough free space/.test(dlg) && /does not fit even after deleting/.test(dlg) && await p.locator(".pwr-box .go").count() === 0, "too big: refused with explanation");
await p.click(".pwr-box .no"); await p.waitForTimeout(300);
// --- driving (guidance active): everything disabled
await p.evaluate(() => document.body.classList.add("navigating")); await p.waitForTimeout(5600);
ok(await p.isVisible("#upd-parked"), "parked-only notice shown while navigating");
ok(await p.locator("#upd-bundles button:not([disabled])").count() === 0 && await p.isDisabled("#upd-os"), "install + OS buttons disabled while navigating");
const r = await p.evaluate(async () => (await fetch("/api/update/os/start", { method: "POST", body: JSON.stringify({ guiding: true }) })).status);
ok(r === 409, "server refuses while guiding: HTTP " + r);
await p.evaluate(() => document.body.classList.remove("navigating")); await p.waitForTimeout(5600);
// --- install (side by side): copy, verify, ready
await p.click("#upd-check"); await p.waitForTimeout(1200);
await good.locator("button").click(); await p.waitForTimeout(500); await shot("4-confirm");
ok(/free/.test(await txt(".pwr-box")) && /roll back/.test(await txt(".pwr-box")), "confirm explains space + rollback: " + (await txt(".pwr-box p")));
await p.click(".pwr-box .go");
await p.waitForSelector("#upd-job:not([hidden])", { timeout: 5000 });
await p.waitForFunction(() => /Switch to the new map/.test(document.getElementById("upd-job").textContent), null, { timeout: 30000 });
await shot("6-ready");
ok(CUR() === "germany-20260910", "not switched before the user taps Switch");
ok(fs.existsSync(T + "/data/germany-20261201/map/germany-20261201.pmtiles"), "new region folder copied (pmtiles renamed to folder name)");
await p.locator("#upd-job-b button.primary").click();
await p.waitForTimeout(800);
ok(CUR() === "germany-20261201", "current repointed: " + CUR());
ok(/restart nav-pi-tiles.service/.test(sysctl()) && /restart nav-pi-valhalla.service/.test(sysctl()), "tiles + valhalla restart requested");
await p.waitForNavigation({ timeout: 15000 }).catch(() => {}); await p.waitForTimeout(1500);   // the page reloads when navd answers again
await openSettings(); await shot("7-after-switch");
ok(await p.locator("#upd-regions .row").count() === 2 && !(await p.isHidden("#upd-rollback")), "two regions + Roll back offered");
// --- roll back
await p.click("#upd-rollback"); await p.waitForTimeout(400); await p.click(".pwr-box .go"); await p.waitForTimeout(1000);
ok(CUR() === "germany-20260910", "rolled back: " + CUR());
await p.waitForNavigation({ timeout: 15000 }).catch(() => {}); await p.waitForTimeout(1500);
await openSettings();
// --- delete the non-current region
await p.locator("#upd-regions .row", { hasText: "germany-20261201" }).locator("button").click(); await p.waitForTimeout(400); await shot("8-delete-ask");
await p.click(".pwr-box .go"); await p.waitForTimeout(1500);
ok(!fs.existsSync(T + "/data/germany-20261201") && await p.locator("#upd-regions .row").count() === 1, "old region deleted, current kept");
// --- OS update: state from the fake unit's files + confirm dialog starts the unit
fs.writeFileSync(T + "/state/os-update.state", "done 2026-12-02T10:00:00\n");
fs.writeFileSync(T + "/state/os-update.log", "== apt update\nHit:1 http://deb.debian.org bookworm InRelease\n== apt upgrade\n0 upgraded\n== finished\n");
await p.waitForTimeout(5600); await p.locator("#upd-os").scrollIntoViewIfNeeded(); await shot("9-os");
ok(/up to date/.test(await txt("#upd-os-t")) && /finished/.test(await txt("#upd-os-log")), "OS state + log tail shown");
await p.click("#upd-os"); await p.waitForTimeout(400); await p.click(".pwr-box .go"); await p.waitForTimeout(1000);
ok(/start --no-block nav-pi-os-update.service/.test(sysctl()), "OS unit start requested via systemctl");
await b.close();
console.log(errs.length ? "PAGE ERRORS:\n" + errs.join("\n") : "no page errors");
console.log(bad || errs.length ? "FAILED" : "ALL OK");
process.exit(bad || errs.length ? 1 : 0);
