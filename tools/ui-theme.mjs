// Light / Dark / Auto (PN-31/32): screenshots of every view in light and dark + Auto checks (Playwright, headless Chromium).
//   node tools/ui-theme.mjs [base-url] [out-dir] [WxH]     (needs a served build; route flow needs local Valhalla, see ui-routes.mjs)
// Auto is tested with a fake clock + stored position (Munich): noon in June = light, 23:00 UTC = dark, polar-night Tromso = dark.
import { createRequire } from "module";
const require = createRequire(import.meta.url);
const { chromium } = require(process.env.PLAYWRIGHT_DIR || "playwright");
const base = process.argv[2] || "http://127.0.0.1:18080";
const out = process.argv[3] || new URL("./shots", import.meta.url).pathname;
const [w, h] = (process.argv[4] || "720x1280").split("x").map(Number);
const tag = w > h ? "land" : "port";
const b = await chromium.launch({ args: ["--use-angle=swiftshader", "--enable-unsafe-swiftshader", "--ignore-gpu-blocklist"] });
let fails = 0;
const check = (name, ok) => { if (!ok) fails++; console.log((ok ? "PASS " : "FAIL ") + name); };
const wait = (p, ms) => p.waitForTimeout(ms);

const ui = p => p.evaluate(() => document.documentElement.dataset.ui);

for (const mode of ["light", "dark"]) {
  const ctx = await b.newContext({ viewport: { width: w, height: h }, hasTouch: true });
  const p = await ctx.newPage(); const errs = [];
  p.on("pageerror", e => errs.push(e.message));
  p.on("console", m => m.type() === "error" && !/tiles|fonts|glyphs|502|404|409|nmcli|api\/(wifi|bt|media|gps)/.test(m.text() + (m.location().url || "")) && errs.push(m.text()));
  await p.addInitScript(m => localStorage.setItem("navpi.uiTheme", JSON.stringify(m)), mode);
  const shot = async n => { await p.screenshot({ path: `${out}/${tag}-${mode}-${n}.png` }); console.log("shot", mode, n); };
  await p.goto(base + "/"); await wait(p, 3500);
  check(mode + ": data-ui", (await ui(p)) === (mode === "light" ? "light" : "dark"));
  await shot("1-map");
  await p.click("#q"); await wait(p, 300);
  for (const ch of "leopoldstr") await p.click(`#kbd button:text-is("${ch}")`);
  await wait(p, 1500); await shot("2-search-keyboard");
  const rows = await p.locator("#search-results .row").count();
  if (rows) { await p.click("#search-results .row >> nth=0"); await wait(p, 4500); await shot("3-preview"); }
  else check(mode + ": search results", false);
  await p.click("#s-opts"); await wait(p, 500); await shot("4-route-options"); await p.click("#ro-done"); await wait(p, 300);
  await p.click("#s-sim"); await wait(p, 8000); await shot("5-navigating");
  await p.click("#btn-stop"); await wait(p, 600);
  await p.click("#dock [data-go=settings]"); await wait(p, 800); await shot("7-settings-top");
  const cats = await p.$$eval("#st-nav button", bs => bs.map(b => b.dataset.cat));
  for (const c of cats) { await p.click(`#st-nav button[data-cat=${c}]`); await wait(p, 400); await shot("8-settings-" + c); }
  await p.click("#st-nav button[data-cat=display]"); await wait(p, 300);
  check(mode + ": Settings > Screen marks mode", await p.locator(`#settings [data-ui-mode=${mode}]`).evaluate(e => e.classList.contains("on")));
  if (await p.locator("[data-pwr=reboot]").count()) {
    await p.click("#st-nav button[data-cat=system]"); await wait(p, 300);
    await p.locator("[data-pwr=reboot]").scrollIntoViewIfNeeded(); await p.click("[data-pwr=reboot]"); await wait(p, 500); await shot("9-power-dialog");
    await p.click(".pwr-box .no"); await wait(p, 300);
  }
  if (await p.locator("#dock [data-go=media]").count()) { await p.click("#dock [data-go=media]"); await wait(p, 1200); await shot("10-media"); }
  check(mode + ": no page errors" + (errs.length ? " " + errs.join(" | ") : ""), errs.length === 0);
  await ctx.close();
}

// Auto + switching (fake clock, Munich stored as last position)
async function autoCase(name, lat, lng, iso, want, mapWant) {
  const ctx = await b.newContext({ viewport: { width: w, height: h }, hasTouch: true });
  const p = await ctx.newPage(); const errs = [];
  p.on("pageerror", e => errs.push(e.message));
  await p.clock.install({ time: new Date(iso) });
  await p.addInitScript(([la, lo]) => localStorage.setItem("navpi.lastPos", JSON.stringify({ lat: la, lng: lo })), [lat, lng]);
  await p.goto(base + "/"); await p.clock.runFor(1000); await wait(p, 1500);
  check(name + " -> " + want, (await ui(p)) === want);
  if (mapWant) { await wait(p, 2500); const s = await p.evaluate(() => window.__map && window.__map.getStyle().layers.find(l => l.id === "background").paint["background-color"]);
    console.log("  map background", s); }
  check(name + ": no page errors" + (errs.length ? " " + errs.join(" | ") : ""), errs.length === 0);
  return { p, ctx, errs };
}
await (await autoCase("Auto Munich 21 Jun 12:00Z", 48.137, 11.575, "2026-06-21T12:00:00Z", "light", true)).ctx.close();
await (await autoCase("Auto Munich 21 Jun 23:00Z", 48.137, 11.575, "2026-06-21T23:00:00Z", "dark", true)).ctx.close();
await (await autoCase("Auto Munich 21 Dec 16:30Z (after sunset 15:22Z)", 48.137, 11.575, "2026-12-21T16:30:00Z", "dark")).ctx.close();
await (await autoCase("Auto Tromso 21 Dec noon (polar night)", 69.65, 18.96, "2026-12-21T11:00:00Z", "dark")).ctx.close();
await (await autoCase("Auto Tromso 21 Jun 23:00Z (midnight sun)", 69.65, 18.96, "2026-06-21T23:00:00Z", "light")).ctx.close();
// minute tick: dark just before sunrise, light a few minutes later (Munich 21 Jun, sunrise 03:13Z)
{
  const { p, ctx } = await autoCase("Auto tick: Munich 03:09Z", 48.137, 11.575, "2026-06-21T03:09:00Z", "dark");
  await p.clock.runFor(6 * 60 * 1000); await wait(p, 300);
  check("Auto tick: light at 03:15Z without reload", (await ui(p)) === "light");
  await ctx.close();
}
// switching in the UI: Auto -> Dark -> Light, map style follows, display event fires
{
  const ctx = await b.newContext({ viewport: { width: w, height: h }, hasTouch: true });
  const p = await ctx.newPage(); const errs = [];
  p.on("pageerror", e => errs.push(e.message));
  await p.goto(base + "/"); await wait(p, 3000);
  await p.evaluate(() => { window.__ev = 0; window.addEventListener("navpi:theme", () => window.__ev++); });
  const bg = () => p.evaluate(() => window.__map.getStyle().layers.find(l => l.id === "background").paint["background-color"]);
  await p.click("#dock [data-go=settings]"); await p.click("#st-nav button[data-cat=display]"); await wait(p, 500);
  await p.click("#settings [data-ui-mode=dark]"); await wait(p, 2500);
  const dark = await bg(); check("Settings Dark: UI dark", (await ui(p)) === "dark");
  await p.click("#settings [data-ui-mode=light]"); await wait(p, 2500);
  const light = await bg(); check("Settings Light: UI light", (await ui(p)) === "light");
  check("map style changed with the UI (" + dark + " -> " + light + ")", dark !== light);
  check("navpi:theme fired", (await p.evaluate(() => window.__ev)) >= 2);
  check("stored uiTheme", (await p.evaluate(() => localStorage.getItem("navpi.uiTheme"))) === '"light"');
  await p.click("#settings [data-ui-mode=auto]"); await wait(p, 500);
  check("Auto selected in Settings", await p.locator("#settings [data-ui-mode=auto]").evaluate(e => e.classList.contains("on")));
  check("Settings shows sunrise/sunset text: " + (await p.textContent(".ui-sun")), /\d/.test(await p.textContent(".ui-sun")));
  await p.reload(); await wait(p, 3000);
  check("setting survives reload (auto)", (await p.evaluate(() => localStorage.getItem("navpi.uiTheme"))) === '"auto"');
  check("no page errors" + (errs.length ? " " + errs.join(" | ") : ""), errs.length === 0);
  await ctx.close();
}
await b.close();
console.log(fails ? fails + " FAILED" : "all passed"); process.exit(fails ? 1 : 0);
