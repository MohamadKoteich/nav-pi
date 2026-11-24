// Wi-Fi flow (Playwright) against a navd running with the fake nmcli (tests/fake-nmcli, FAKE_NM_STATE reset first):
// status bar icon, Settings > Connections list, password on the on-screen keyboard, connect, forget, radio off.
//   node tools/ui-wifi.mjs [base-url] [out-dir] [WxH]
import { createRequire } from "module";
const require = createRequire(import.meta.url);
const { chromium } = require(process.env.PLAYWRIGHT_DIR || "playwright");
const base = process.argv[2] || "http://127.0.0.1:18080";
const out = process.argv[3] || new URL("./shots", import.meta.url).pathname;
const [w, h] = (process.argv[4] || "720x1280").split("x").map(Number);
const tag = w > h ? "land" : "port";
const b = await chromium.launch({ args: ["--use-angle=swiftshader", "--enable-unsafe-swiftshader"] });
const p = await b.newPage({ viewport: { width: w, height: h }, hasTouch: true });
const errs = []; p.on("pageerror", e => errs.push(e.message)); p.on("console", m => m.type() === "error" && !/\/api\/display$/.test(m.location().url || "") && errs.push(m.text()));   // 409 = no backlight on a PC
const shot = async n => { await p.screenshot({ path: `${out}/wifi-${tag}-${n}.png` }); console.log("shot", n); };
let bad = 0; const ok = (c, m) => { console.log(c ? "ok  " : "FAIL", m); if (!c) bad++; };
await p.goto(base + "/"); await p.waitForTimeout(2500); await shot("1-status");
ok(await p.isVisible("#wifi-chip"), "status bar Wi-Fi icon visible");
ok((await p.getAttribute("#wifi-chip", "class")).includes("ok") && (await p.getAttribute("#wifi-chip", "title")).includes("Home 5G"), "status bar icon: connected to Home 5G");
await p.click("#dock [data-go=settings]"); await p.click("#st-nav button[data-cat=connect]"); await p.waitForTimeout(1500); await shot("2-settings");
ok(await p.locator("#wifi-list .row").count() >= 5, "network rows listed");
await p.locator("#wifi-list .row", { hasText: "Pixel hotspot" }).locator("button.primary").click(); await p.waitForTimeout(400);
await shot("3-password");
ok(await p.isVisible("#kbd.open"), "on-screen keyboard open");
for (const ch of "wrongpass1") await p.click(`#kbd button:text-is("${ch}")`);
await p.click('#kbd button:text-is("Connect")'); await p.waitForTimeout(2500);
ok((await p.textContent("#toast")).length > 0, "wrong password -> toast: " + (await p.textContent("#toast")));
await shot("4-wrong");
await p.locator("#wifi-list .row", { hasText: "Pixel hotspot" }).locator("button.primary").click(); await p.waitForTimeout(300);
for (const ch of "correctpw1") await p.click(`#kbd button:text-is("${ch}")`);
await p.click("#wifi-go"); await p.waitForTimeout(3500); await shot("5-connected");
ok((await p.textContent("#wifi-status")).includes("Pixel hotspot"), "status shows Pixel hotspot: " + (await p.textContent("#wifi-status")));
ok(await p.evaluate(() => !document.body.innerHTML.includes("correctpw1") && !JSON.stringify(localStorage).includes("correctpw1")), "password not in DOM/localStorage");
await p.locator("#wifi-list .row", { hasText: "Pixel hotspot" }).locator("button.sq").click(); await p.waitForTimeout(300); await shot("6-forget-confirm");
await p.locator("#wifi-list .row", { hasText: "Pixel hotspot" }).locator("button.danger").click(); await p.waitForTimeout(1500);
ok(await p.locator("#wifi-list .row", { hasText: "Pixel hotspot" }).locator("button.sq").count() === 0, "forgotten");
await p.click("#wifi-power"); await p.waitForTimeout(1500); await shot("7-off");
ok((await p.getAttribute("#wifi-power", "aria-checked")) === "false", "radio off");
await p.click("#settings-back"); await p.waitForTimeout(800); await shot("8-status-off");
// the off state is shown, not hidden (features/wifi/wifi.js): a grey crossed Wi-Fi icon
ok(await p.isVisible("#wifi-chip") && (await p.getAttribute("#wifi-chip use", "href")) === "#i-wifi-off", "radio off: crossed Wi-Fi icon in the status bar");
console.log(errs.length ? "PAGE ERRORS:\n" + errs.join("\n") : "no page errors");
await b.close(); process.exit(bad || errs.length ? 1 : 0);
