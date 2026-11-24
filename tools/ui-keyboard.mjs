// On-screen keyboard (PN-KBD-03 floating panel: layouts, sizes, hold-for-variants, Shift, Caps Lock, both sign pages)
// + a USB keyboard, on the Wi-Fi password field (Playwright) against a navd running with the fake nmcli
// (tests/fake-nmcli). The password typed must reach navd exactly.
//   node tools/ui-keyboard.mjs [base-url] [out-dir] [WxH]
//   node tools/ui-keyboard.mjs --cdp [cdp-url] [out-dir]   the real Pi screen (ssh -N -L 19222:127.0.0.1:9222 nav@nav-pi.local):
//     /api/wifi/connect is answered in the page and never reaches navd, and only a secured, unsaved network's
//     Connect button is pressed (a saved or open one connects at once), so the Pi's Wi-Fi is never touched.
//     The keyboard layout/size the Pi had before the run is put back at the end.
import { createRequire } from "module";
const require = createRequire(import.meta.url);
const { chromium } = require(process.env.PLAYWRIGHT_DIR || "playwright");
const cdp = process.argv[2] === "--cdp";
const out = (cdp ? process.argv[4] : process.argv[3]) || new URL("./shots", import.meta.url).pathname;
let b, p, home, tag;
if (cdp) {
  b = await chromium.connectOverCDP(process.argv[3] || "http://127.0.0.1:19222");
  p = b.contexts()[0].pages().find(x => /:8080\//.test(x.url()));
  home = p.url(); tag = "pi";
  await p.route("**/api/wifi/connect", r => r.fulfill({ status: 503, contentType: "application/json", body: '{"error":"device test"}' }));
} else {
  const size = process.argv[4] || "1280x720";
  const [w, h] = size.split("x").map(Number);
  b = await chromium.launch({ args: ["--use-angle=swiftshader", "--enable-unsafe-swiftshader"] });
  p = await b.newPage({ viewport: { width: w, height: h }, hasTouch: true });
  home = (process.argv[2] || "http://127.0.0.1:18080") + "/"; tag = size;
}
const errs = []; p.on("pageerror", e => errs.push(e.message));
let bad = 0, n = 0; const ok = (c, m) => { n++; console.log(c ? "ok  " : "FAIL", m); if (!c) bad++; };
const sent = []; p.on("request", r => { if (r.url().endsWith("/api/wifi/connect")) sent.push(JSON.parse(r.postData() || "{}").password); });
const k = async label => p.click(`#kbd .kb-keys button:text-is(${JSON.stringify(label)})`);
const shift = () => p.click("#kbd button.sh");
const pw = () => p.inputValue("#wifi-pw");
const box = sel => p.evaluate(s => { const r = document.querySelector(s).getBoundingClientRect(); return { x: r.left, y: r.top, w: r.width, h: r.height, b: r.bottom, r: r.right }; }, sel);
const prefs = () => p.evaluate(() => [localStorage.getItem("navpi.kbdLayout"), localStorage.getItem("navpi.kbdSize")]);
// hold a key until its variants show; then slide onto `pick` and lift (slide=true) or lift and tap it
async function hold(ch, pick, slide = true, shot = null) {
  const kb = await box(`#kbd .kb-keys button[data-ch="${ch}"]`);
  await p.mouse.move(kb.x + kb.w / 2, kb.y + kb.h / 2); await p.mouse.down();
  await p.waitForTimeout(650);
  const v = p.locator(`#kbd .kb-pop button:text-is(${JSON.stringify(pick)})`);
  const shown = await v.isVisible();
  if (!shown) { await p.mouse.up(); return false; }
  if (shot) await p.screenshot({ path: `${out}/kbd-${tag}-${shot}.png` });
  const vb = await v.boundingBox();
  if (slide) { await p.mouse.move(vb.x + vb.width / 2, vb.y + vb.height / 2, { steps: 4 }); await p.mouse.up(); }
  else { await p.mouse.up(); await p.waitForTimeout(100); await p.mouse.click(vb.x + vb.width / 2, vb.y + vb.height / 2); }
  await p.waitForTimeout(100);
  return true;
}

let before = null;
async function openPassword(clean) {
  await p.goto(home); await p.waitForTimeout(cdp ? 3000 : 800);
  if (before === null) before = await prefs();
  if (clean) { await p.evaluate(() => { localStorage.removeItem("navpi.kbdLayout"); localStorage.removeItem("navpi.kbdSize"); }); }
  await p.locator("#dock [data-go=settings]").dispatchEvent("click"); await p.waitForTimeout(600);   // 800x480: the rail button may sit below the window (screen-size work)
  await p.click("#st-nav button[data-cat=connect]"); await p.waitForTimeout(cdp ? 4000 : 1500);
  const row = cdp ? p.locator("#wifi-list .row").filter({ has: p.locator(".st", { hasText: /^(Secured|Gesichert)$/ }) }).first()
                  : p.locator("#wifi-list .row", { hasText: "Pixel hotspot" });
  await row.locator("button.primary").click(); await p.waitForTimeout(400);
  await p.waitForSelector("#kbd.open", { timeout: 4000 }); await p.waitForTimeout(400);   // placement settles after the page scrolls
}
async function geometry(what, maxW, coverOk = false) {
  const vw = p.viewportSize ? (p.viewportSize() || {}).width : 0;
  const k = await box("#kbd"), f = await box("#wifi-pw");
  const view = await p.evaluate(() => [innerWidth, innerHeight]);
  const keyH = await p.evaluate(() => Math.min(...[...document.querySelectorAll("#kbd .kb-keys button.k")].map(b => b.getBoundingClientRect().height)));
  ok(k.x >= 0 && k.y >= 0 && k.r <= view[0] + 0.5 && k.b <= view[1] + 0.5, `${what}: panel inside the window (${Math.round(k.x)},${Math.round(k.y)} ${Math.round(k.w)}x${Math.round(k.h)})`);
  if (coverOk && !(f.b <= k.y || f.y >= k.b)) console.log(`note ${what}: too tall for this window, covers the field (allowed)`);
  else ok(f.b <= k.y || f.y >= k.b, `${what}: panel does not cover the field (field ${Math.round(f.y)}-${Math.round(f.b)}, panel ${Math.round(k.y)}-${Math.round(k.b)})`);
  if (maxW) ok(k.w <= maxW * view[0] + 1, `${what}: compact, ${Math.round(100 * k.w / view[0])} % of the width (<= ${maxW * 100} %)`);
  ok(keyH >= 47.5, `${what}: keys >= 48 px tall (${Math.round(keyH)})`);
  void vw;
}

// ---- default layout: letters + number column, floating, compact ----
await openPassword(true);
const land = await p.evaluate(() => innerWidth > innerHeight && innerWidth >= 1000);   // compactness asserted on wide screens
ok((await p.getAttribute("#kbd", "data-layout")) === "pad" && await p.isVisible("#kbd .kb-pad"), "default layout = letters + number column");
await geometry("pad", land ? 0.75 : 1);
await p.screenshot({ path: `${out}/kbd-${tag}-pad.png` });
ok(await p.isVisible("#kbd button.sh"), "Shift key present");

// "Ab#9 x\Z!" : Shift one-shot, signs page 1 + 2, space, Caps Lock; digits from the number column
await shift(); await k("A");
ok(!(await p.isVisible("#kbd button.sh.on")), "Shift released after one capital");
await k("b");
await k("?123"); await k("=\\<"); await k("#"); await k("ABC");
await p.click("#kbd .kb-pad button:text-is('9')");
await p.click("#kbd button.sp");
await k("x");
await k("?123"); await k("=\\<"); await k("\\"); await k("ABC");
await shift(); await shift(); await k("Z");
ok(await p.isVisible("#kbd button.sh.on"), "Caps Lock stays on");
await k("Q"); await p.click("#kbd button.bk");   // caps: Q, then Backspace removes it
await shift();
ok(!(await p.isVisible("#kbd button.sh.on")), "third Shift tap: off");
await k("?123"); await k("!"); await k("ABC");
// hold for variants: e -> é (slide), a -> ä (slide), s -> ß (lift, then tap)
ok(await hold("e", "é"), "hold e: variants popup shows é");
ok(await hold("a", "ä", true, "hold-a"), "hold a: variants popup shows ä");
ok(await hold("s", "ß", false), "hold s: ß picked by a tap after lifting");
await shift(); ok(await hold("o", "Ö"), "Shift + hold o: capital Ö offered");
await p.screenshot({ path: `${out}/kbd-${tag}-typed.png` });
ok((await pw()) === "Ab#9 x\\Z!éäßÖ", "on-screen: field holds Ab#9 x\\Z!éäßÖ  (" + JSON.stringify(await pw()) + ")");
await k("Connect"); await p.waitForTimeout(1500);
ok(sent.at(-1) === "Ab#9 x\\Z!éäßÖ", "on-screen: navd got the exact password");

// ---- options on the keyboard: letters only (+ ?123, digits by holding the top row), full width, size ----
await openPassword(false);
await p.click("#kbd button.op"); await p.waitForTimeout(200);
ok(await p.isVisible("#kbd .kb-menu"), "options key opens the layout/size menu on the keyboard");
await p.screenshot({ path: `${out}/kbd-${tag}-options.png` });
await p.click("#kbd .opt[data-v=letters]"); await p.waitForTimeout(200);
ok((await p.getAttribute("#kbd", "data-layout")) === "letters" && !(await p.isVisible("#kbd .kb-pad")), "letters only: no number column");
await geometry("letters", land ? 0.6 : 1);
await p.screenshot({ path: `${out}/kbd-${tag}-letters.png` });
ok(await hold("w", "2"), "letters only: hold w gives 2 (top row digits, like Android)");
await k("?123"); await k("7"); await k("ABC");
ok((await pw()) === "27", "letters only: digits from the hold + ?123 (" + JSON.stringify(await pw()) + ")");
await p.click("#kbd button.op"); await p.click("#kbd .opt[data-v=L]"); await p.waitForTimeout(150);
const hL = await p.evaluate(() => document.querySelector("#kbd .kb-menu button.opt").getBoundingClientRect().height);
await p.click("#kbd .opt[data-v=wide]"); await p.waitForTimeout(200);
const wk = await box("#kbd");
const vw = await p.evaluate(() => innerWidth);
ok((await p.getAttribute("#kbd", "data-layout")) === "wide" && wk.w >= vw - 20, `full width: panel spans the window (${Math.round(wk.w)} of ${vw})`);
ok(hL >= 60, `size L: taller keys (${Math.round(hL)} px)`);
await geometry("wide L", 0, (await p.evaluate(() => innerHeight)) < 600);   // full width + L on 800x480 cannot fit beside a field
await p.screenshot({ path: `${out}/kbd-${tag}-wide-L.png` });
ok(JSON.stringify(await prefs()) === JSON.stringify(['"wide"', '"L"']), "layout + size saved (navpi.kbdLayout / navpi.kbdSize) " + JSON.stringify(await prefs()));
// persists over a reload
await openPassword(false);
ok((await p.getAttribute("#kbd", "data-layout")) === "wide" && (await p.getAttribute("#kbd", "data-size")) === "L", "layout + size kept after a reload");
await p.click("#kbd button.op"); await p.click("#kbd .opt[data-v=M]"); await p.click("#kbd .opt[data-v=pad]"); await p.waitForTimeout(150);
ok((await p.getAttribute("#kbd", "data-layout")) === "pad", "back to letters + numbers from the keyboard");
await p.click("#kbd button.hd"); await p.waitForTimeout(150);
ok(!(await p.isVisible("#kbd.open")), "hide key closes the keyboard");

// ---- USB keyboard: type into the field, Enter connects ----
await openPassword(false);
ok(!(await p.getAttribute("#wifi-pw", "readonly")) && (await p.evaluate(() => document.activeElement.id)) === "wifi-pw", "field focused, not readonly");
await p.keyboard.type("Usb-Pass_2026 ok");
await k("x"); await p.keyboard.press("Backspace");   // mixing both still works
ok((await pw()) === "Usb-Pass_2026 ok", "USB keyboard typed into the field");
await p.keyboard.press("Enter"); await p.waitForTimeout(1500);
ok(sent.at(-1) === "Usb-Pass_2026 ok", "USB keyboard: Enter sent the exact password");

// ---- search field: a USB keyboard drives the suggestions like the keys do; panel not over the field ----
await p.goto(home); await p.waitForTimeout(cdp ? 3000 : 1500);
await p.waitForFunction(() => window.__map && window.__map.loaded(), null, { timeout: 30000 }).catch(() => {});   // the search field is wired once the map loaded
await p.click("#q"); await p.waitForTimeout(300);
{ const k2 = await box("#kbd"), f = await box("#q"); ok(f.b <= k2.y || f.y >= k2.b, "search: panel does not cover the search field"); }
await p.keyboard.type("Frei");
{ const q = await p.inputValue("#q"), open = await p.isVisible("#kbd.open"); ok(q === "Frei" && open, `search: USB typing lands in the field (${JSON.stringify(q)}, keyboard ${open ? "open" : "closed"})`); }
await p.screenshot({ path: `${out}/kbd-${tag}-search.png` });
await p.keyboard.press("Escape");
ok(!(await p.isVisible("#kbd.open")), "Escape closes the keyboard");

ok(errs.length === 0, "no page errors " + errs.join(" | "));
await p.evaluate(v => {   // put back what the device had
  const set = (key, val) => (val === null ? localStorage.removeItem(key) : localStorage.setItem(key, val));
  set("navpi.kbdLayout", v[0]); set("navpi.kbdSize", v[1]);
}, before || [null, null]);
if (cdp) { await p.goto(home); await p.unroute("**/api/wifi/connect"); }
await b.close();
console.log(bad ? `${bad} of ${n} FAILED` : `ALL PASS (${n})`);
process.exit(bad ? 1 : 0);
