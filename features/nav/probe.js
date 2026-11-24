/* ?probe=1 : measure frame rates on this device and report them to navd (/api/probe -> journal).
   Lets any browser on the Pi (Chromium, Firefox) be benchmarked the same way. */
if (new URLSearchParams(location.search).has("probe")) setTimeout(async () => {
  const rate = ms => new Promise(res => { let f = 0; const t0 = performance.now();
    const k = () => { f++; performance.now() - t0 < ms ? requestAnimationFrame(k) : res(+(f / (ms / 1000)).toFixed(1)); }; requestAnimationFrame(k); });
  const out = { ua: navigator.userAgent.replace(/^.*\) /, ""), pageFps: await rate(2000) };
  Shell.go("maps"); await Maps.init();
  const map = window.__map;
  map.jumpTo({ center: map.getCenter(), zoom: 15, pitch: 0, bearing: 0 });   // wherever the map is (the device's region)
  await new Promise(r => map.once("idle", r));
  out.idleMapFps = await rate(2000);
  map.repaint = true; out.repaintFps = await rate(3000); map.repaint = false;
  map.easeTo({ center: [7.835, 48.0], zoom: 16.8, pitch: 52, bearing: 120, duration: 5000 });
  out.animFps = await rate(5000);
  const c = document.createElement("canvas").getContext("webgl2"), e = c && c.getExtension("WEBGL_debug_renderer_info");
  out.gl = c ? (e ? c.getParameter(e.UNMASKED_RENDERER_WEBGL) : c.getParameter(c.RENDERER)) : "none";
  fetch("/api/probe", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(out) });
}, 1500);
