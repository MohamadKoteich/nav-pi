// USB flow (Playwright) against a navd running with the fake lsblk/udisksctl (tests/fake-usb): insert toast, Settings card,
// import (folder -> destination, copy, media library refresh), eject + removal. Recipe (see docs/TESTING.md):
//   export FAKE_USB_STATE=/tmp/usbui/state.json NAV_DATA=/tmp/usbui/data STICK=/tmp/usbui/stick   (state starts with no stick: {"sticks":[],"mounted":{}})
//   LSBLK=tests/fake-lsblk UDISKSCTL=tests/fake-udisksctl USB_POLL=1 NAV_PORT=18080 APP_DIR=<build>/app EDITION_FILE=<build>/edition.json python3 <build>/navd/navd.py
//   node tools/ui-usb.mjs [base-url] [out-dir] [WxH]   (basic build: pass BASIC=1 — no Import button, no media)
import { createRequire } from "module";
import fs from "fs";
const require = createRequire(import.meta.url);
const { chromium } = require(process.env.PLAYWRIGHT_DIR || "playwright");
const base = process.argv[2] || "http://127.0.0.1:18080";
const out = process.argv[3] || new URL("./shots", import.meta.url).pathname;
const [w, h] = (process.argv[4] || "720x1280").split("x").map(Number);
const tag = (w > h ? "land" : "port") + (process.env.BASIC ? "-basic" : "");
const SP = process.env.FAKE_USB_STATE, DATA = process.env.NAV_DATA, STICK = process.env.STICK;
for (const f of ["Rock/a.mp3", "Rock/Live/b.flac", "Hörbücher/Dune/c.m4b", "Podcasts/d.opus", "loose.mp3", "Rock/cover.jpg"]) {
  fs.mkdirSync(`${STICK}/${f.split("/").slice(0, -1).join("/")}`, { recursive: true }); fs.writeFileSync(`${STICK}/${f}`, Buffer.alloc(300000, 7));
}
fs.rmSync(DATA + "/media", { recursive: true, force: true });
const state = { sticks: [], mounted: {}, calls: [] };
const save = () => fs.writeFileSync(SP, JSON.stringify(state));
save();
const b = await chromium.launch({ args: ["--use-angle=swiftshader", "--enable-unsafe-swiftshader"] });
const p = await b.newPage({ viewport: { width: w, height: h }, hasTouch: true });
const errs = []; p.on("response", r => r.status() >= 400 && r.url().includes("/api/usb") && errs.push("HTTP " + r.status() + " " + r.url()));   // /api/display 409 and tile 404s of this box are not ours p.on("pageerror", e => errs.push(e.message)); p.on("console", m => m.type() === "error" && !m.text().startsWith("Failed to load resource") && errs.push(m.text()));
const shot = async n => { await p.screenshot({ path: `${out}/usb-${tag}-${n}.png` }); console.log("shot", n); };
let bad = 0; const ok = (c, m) => { console.log(c ? "ok  " : "FAIL", m); if (!c) bad++; };
const grp = n => p.locator(`#usb-imp .usb-f:has(.n:text-is("${n}"))`);
const toast = async () => (await p.textContent("#toast")) || "";
await p.goto(base + "/"); await p.waitForTimeout(1500);
const st = JSON.parse(fs.readFileSync(SP));
st.sticks.push({ disk: "/dev/sdb", tran: "usb", parts: [{ dev: "/dev/sdb1", fstype: "vfat", label: "MUSIC", uuid: "AAAA-BBBB", size: 32000000000, dir: STICK }] });
fs.writeFileSync(SP, JSON.stringify(st));
const sawIn = await p.waitForFunction(() => /USB stick connected: MUSIC/.test(document.getElementById("toast").textContent), null, { timeout: 9000 }).then(() => true, () => false);
ok(sawIn, "insert toast (auto-mounted, polled)");
await p.click("#dock [data-go=settings]"); await p.click("#st-nav button[data-cat=connect]"); await p.waitForTimeout(1500);
await p.locator("#usb-card").scrollIntoViewIfNeeded(); await shot("1-card");
ok(await p.isVisible("#usb-card"), "usb card visible");
await p.waitForFunction(() => /FAT32/.test(document.getElementById("usb-list").textContent), null, { timeout: 5000 }).catch(() => {});
ok(/MUSIC/.test(await p.textContent("#usb-list")) && /FAT32/.test(await p.textContent("#usb-list")), "stick row: " + (await p.textContent("#usb-list")).slice(0, 80));
const apiList = await (await fetch(base + "/api/usb")).json();
ok(apiList.length === 1 && apiList[0].path === STICK && apiList[0].id === "AAAA-BBBB", "GET /api/usb " + JSON.stringify(apiList));
if (process.env.BASIC) {
  ok(await p.locator("#usb-list button.primary").count() === 0, "basic: no Import button");
} else {
  await p.locator("#usb-list button.primary").click(); await p.waitForTimeout(1200);
  await p.locator("#usb-imp").scrollIntoViewIfNeeded(); await shot("2-pick");
  ok(await p.locator("#usb-imp .usb-f").count() === 4, "4 folder groups");
  await 0;
  await grp("Podcasts").locator(".usb-dest button.on").waitFor();
  ok((await grp("Podcasts").locator(".usb-dest button.on").textContent()) === "Podcasts", "Podcasts folder suggests Podcasts");
  await grp("Rock").locator(".usb-dest button", { hasText: "Audiobooks" }).click();
  await grp("Loose files (top level)").locator(".usb-dest button", { hasText: "Skip" }).click();
  await shot("3-pick-changed");
  await p.locator("#usb-imp .qrow .primary").click(); await p.waitForTimeout(400); await shot("4-copying");
  await p.waitForFunction(() => /Imported|importiert/.test(document.getElementById("toast").textContent), null, { timeout: 15000 }).catch(() => {});
  ok(/Imported 4 files/.test(await toast()), "done toast: " + (await toast()));
  ok(fs.existsSync(`${DATA}/media/Audiobooks/Rock/a.mp3`) && fs.existsSync(`${DATA}/media/Audiobooks/Rock/Live/b.flac`), "Rock -> Audiobooks");
  ok(fs.existsSync(`${DATA}/media/Audiobooks/Hörbücher/Dune/c.m4b`) && fs.existsSync(`${DATA}/media/Podcasts/Podcasts/d.opus`), "Hörbücher -> Audiobooks, Podcasts -> Podcasts");
  ok(!fs.existsSync(`${DATA}/media/Music/loose.mp3`) && fs.existsSync(`${STICK}/loose.mp3`) && fs.existsSync(`${STICK}/Rock/a.mp3`), "skipped folder not copied; stick untouched");
  await shot("5-done");
  await p.click("#settings-back"); await p.waitForTimeout(500);
  await p.click('#dock [data-go="media"], [data-go="media"]'); await p.waitForTimeout(600);
  await p.click('.srcs [data-src="Audiobooks"]'); await p.waitForTimeout(900); await shot("6-media");
  ok((await p.textContent("#m-body")).includes("Rock"), "media library lists the imported folder");
  await p.click("#dock [data-go=settings]"); await p.click("#st-nav button[data-cat=connect]"); await p.waitForTimeout(1200);
}
await p.locator("#usb-list").scrollIntoViewIfNeeded();
await p.locator("#usb-list .acts .ghost").click(); await p.waitForTimeout(1200);
ok(/safe to remove/.test(await toast()), "eject toast: " + (await toast()));
await p.waitForTimeout(3500); await shot("7-ejected");
ok((await p.textContent("#usb-list")).includes("No USB stick"), "list empty after eject");
ok(JSON.parse(fs.readFileSync(SP)).calls.some(c => c[1] === "power-off"), "power-off called");
console.log(errs.length ? "PAGE ERRORS:\n" + errs.join("\n") : "no page errors");
await b.close(); process.exit(bad || errs.length ? 1 : 0);
