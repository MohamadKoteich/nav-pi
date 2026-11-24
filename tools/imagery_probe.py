#!/usr/bin/env python3
"""ONE real tile per imagery provider (needs internet): checks that the URLs built by features/imagery answer with an
image. Use it rarely, by hand, after a provider change — never in tests (tests use a fake fetcher).
    python3 tools/imagery_probe.py [--png] [provider-id ...]        (no ids = every provider, one request each)
A provider passes when the answer is 200 with an image/* Content-Type (a WMS error comes back as XML)."""
import os
import sys
import urllib.request

sys.path.insert(0, os.path.join(os.path.dirname(os.path.abspath(__file__)), "..", "features", "imagery"))
import navd_imagery_plan as P  # noqa: E402

args = sys.argv[1:]
fmt = "image/png" if "--png" in args else "image/jpeg"
ids = [a for a in args if not a.startswith("--")]
# a city centre inside each provider's area (lon, lat, zoom): the tile must contain real imagery
SPOTS = {"bavaria": (11.575, 48.137, 16), "france": (2.35, 48.857, 16), "s2cloudless": (11.575, 48.137, 10),
         "bw": (9.18, 48.776, 16), "nrw": (6.958, 50.941, 16), "hesse": (8.682, 50.11, 16),
         "lower-saxony": (9.735, 52.374, 16), "bremen": (8.807, 53.076, 16), "schleswig-holstein": (10.137, 54.323, 16),
         "mecklenburg": (12.14, 54.088, 16), "berlin": (13.405, 52.52, 16), "brandenburg": (13.064, 52.396, 16),
         "saxony": (13.738, 51.05, 16), "thuringia": (11.03, 50.978, 16), "rhineland-palatinate": (8.271, 49.999, 16),
         "saarland": (6.997, 49.234, 16), "austria": (16.372, 48.209, 16), "netherlands": (4.9, 52.373, 16),
         "flanders": (4.4, 51.22, 16), "wallonia": (5.57, 50.633, 16), "luxembourg": (6.13, 49.611, 16),
         "czechia": (14.42, 50.087, 16), "spain": (-3.703, 40.417, 16)}
bad = 0
for p in P.PROVIDERS:
    if ids and p["id"] not in ids:
        continue
    lon, lat, z = SPOTS[p["id"]]
    x, y = P.tile(lon, lat, z)
    url = P.tile_url(p, z, x, y, fmt)
    try:
        req = urllib.request.Request(url, headers={"User-Agent": "nav-pi/1.0 (offline car navigator; one-tile check)"})
        with urllib.request.urlopen(req, timeout=30) as r:
            data, ctype = r.read(), r.headers.get("Content-Type", "")
        print("%-20s %s %-12s %7d bytes  magic %r" % (p["id"], r.status, ctype, len(data), data[:4]))
        bad += not ctype.startswith("image/")
    except OSError as e:
        print("%-20s FAILED %s" % (p["id"], e))
        bad += 1
sys.exit(1 if bad else 0)
