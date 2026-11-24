// Drive the head unit on the real Pi screen over CDP (ssh -L 19222:127.0.0.1:9222 nav@nav-pi.local).
//   node tools/device-probe.mjs [cdp-url]  -> GPU info + frame rate while the map pans/zooms
import { createRequire } from "module";
const require = createRequire(import.meta.url);
const { chromium } = require(process.env.PLAYWRIGHT_DIR || "playwright");
const b = await chromium.connectOverCDP(process.argv[2] || "http://127.0.0.1:19222");
const p = b.contexts()[0].pages()[0];
const gl = await p.evaluate(() => {
  const c = document.createElement("canvas"), g = c.getContext("webgl2");
  if (!g) return "NO WEBGL2";
  const e = g.getExtension("WEBGL_debug_renderer_info");
  return e ? g.getParameter(e.UNMASKED_RENDERER_WEBGL) : g.getParameter(g.RENDERER);
});
console.log("WebGL2 renderer:", gl);
await p.click("#dock [data-go=maps]"); await p.waitForTimeout(3000);
const fps = await p.evaluate(async () => {
  const m = document.querySelector("#map");
  // fly over Munich like a drive: zoom 15 -> 17, pitch 50, rotate
  const map = window.__map;
  let frames = 0, t0 = performance.now(), worst = 0, last = t0;
  const tick = now => { frames++; worst = Math.max(worst, now - last); last = now; if (now - t0 < 8000) requestAnimationFrame(tick); };
  requestAnimationFrame(tick);
  map.jumpTo({ center: [11.575, 48.137], zoom: 15, pitch: 0, bearing: 0 });
  await new Promise(r => setTimeout(r, 1000));
  map.easeTo({ center: [7.835, 48.0], zoom: 16.8, pitch: 52, bearing: 120, duration: 6500 });
  await new Promise(r => setTimeout(r, 7200));
  return { fps: (frames / ((performance.now() - t0) / 1000)).toFixed(1), worstFrameMs: worst.toFixed(0) };
});
console.log("map animation:", fps);
await b.close();
