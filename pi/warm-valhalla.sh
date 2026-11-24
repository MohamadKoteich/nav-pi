#!/bin/bash
# ExecStartPost of nav-pi-valhalla: one tiny route so the first real route is not cold (3.4 s cold vs 0.5 s warm,
# measured 2026-11-22). Detaches at once, never blocks the unit start, never fails it.
( setsid python3 - >/dev/null 2>&1 <<'PY' &
import json, time, urllib.request
try:
    text = open("/srv/navdata/current/map/BUILD-INFO").read()
    w, s, e, n = [float(v) for v in text.split("bbox=", 1)[1].split()[0].split(",")]
    lon, lat = (w + e) / 2, (s + n) / 2
except Exception:
    lon, lat = 10.45, 51.16
body = json.dumps({"locations": [{"lat": lat, "lon": lon}, {"lat": lat + 0.02, "lon": lon + 0.02}], "costing": "auto"}).encode()
for _ in range(30):   # valhalla needs a few seconds to listen
    try:
        urllib.request.urlopen(urllib.request.Request("http://127.0.0.1:8002/route", body, {"Content-Type": "application/json"}), timeout=60).read()
        break
    except urllib.error.HTTPError:
        break          # "no route here" still loaded the tiles around the point
    except Exception:
        time.sleep(2)
PY
) >/dev/null 2>&1
exit 0
