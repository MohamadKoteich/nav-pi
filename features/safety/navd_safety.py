"""safety feature (PN-44/45/46): serves the offline safety data built by tools/build_safety.py
(<NAV_DATA>/<region>/safety/safety.json: speed cameras, level crossings, rest areas, low-emission zones).

GET  /api/safety/info               counts, build date, source (Settings shows the coverage)
GET  /api/safety/lez                low-emission zones [{name, bbox, rings, holes, tags}]
GET  /api/safety/near?lat=&lon=     nearest rest area / services within 50 km (break reminder without a route)
POST /api/safety/route  a Valhalla /route body -> the Valhalla answer, routed round low-emission zones ("Avoid
     low-emission zones"): the plain route first; zones it enters (and that hold no start / stop / destination) are
     sent as exclude_polygons (their outline simplified to ~200 m: Valhalla's time grows with the points), up to 3
     rounds. Adds {"safety": {"avoided": [names], "unavoidable": [names]}}. Needs Valhalla's
     service_limits.max_exclude_polygons_length raised (scripts/13-build-safety.sh).
POST /api/safety/along {shape, types}
     shape = polyline6 of the route, types ⊂ [cameras, crossings, rest]
     -> {cameras: [[i, t, d, maxspeed]], crossings: [[i, t, d]], rest: [[i, t, d, kind, name]]}
     i = shape segment, t = 0..1 along it, d = metres from the route. Cameras are sent only when asked
     (the app asks only when the driver switched the opt-in on).
"""
import json
import math
import os
import threading
import time
import urllib.error
import urllib.request

DATA = os.environ.get("NAV_DATA", "/srv/navdata")
VALHALLA_URL = os.environ.get("VALHALLA_URL", "http://127.0.0.1:8002")
AVOID_ROUNDS = 3
CELL = 0.01                       # grid cell (degrees) of the point index
TOL = {"cameras": 30.0, "crossings": 15.0, "rest": 350.0}   # metres from the route line
_lock = threading.Lock()
_cache = {"path": None, "mtime": None, "data": None, "grid": None}


def _path():
    region = os.environ.get("NAV_REGION") or os.path.basename(os.path.realpath(os.path.join(DATA, "current")))
    return os.path.join(DATA, region, "safety", "safety.json")


def load():
    """the data file (re-read when it changes), with a grid index per point type; None when not built"""
    p = _path()
    try:
        mt = os.path.getmtime(p)
    except OSError:
        return None
    with _lock:
        if _cache["path"] != p or _cache["mtime"] != mt:
            d = json.load(open(p))
            grid = {}
            for kind in ("cameras", "crossings", "rest"):
                g = grid[kind] = {}
                for n, it in enumerate(d.get(kind, [])):
                    g.setdefault((int(math.floor(it[0] / CELL)), int(math.floor(it[1] / CELL))), []).append(n)
            _cache.update(path=p, mtime=mt, data=d, grid=grid)
        return _cache["data"]


def decode6(s):
    pts, i, lat, lon = [], 0, 0, 0
    while i < len(s):
        for k in (0, 1):
            r = sh = 0
            while True:
                b = ord(s[i]) - 63
                i += 1
                r |= (b & 0x1f) << sh
                sh += 5
                if b < 0x20:
                    break
            d = ~(r >> 1) if r & 1 else r >> 1
            if k == 0:
                lat += d
            else:
                lon += d
        pts.append((lat / 1e6, lon / 1e6))
    return pts


def _proj(p, a, b):
    """point p onto segment a-b ((lat, lon) each), local flat frame -> (t, metres; negative = left of the direction)"""
    k = math.cos(math.radians(p[0]))
    ax, ay, bx, by, px, py = a[1] * k, a[0], b[1] * k, b[0], p[1] * k, p[0]
    dx, dy = bx - ax, by - ay
    L = dx * dx + dy * dy
    t = max(0.0, min(1.0, ((px - ax) * dx + (py - ay) * dy) / L)) if L else 0.0
    qx, qy = ax + dx * t, ay + dy * t
    d = math.hypot(px - qx, py - qy) * 111195.0
    return t, -d if dx * (py - ay) - dy * (px - ax) > 0 else d


def along(shape, kinds):
    """points of `kinds` near the route, each once (at its closest segment), in route order"""
    d = load()
    if d is None:
        return None
    out = {}
    for kind in kinds:
        if kind not in TOL:
            continue
        items, g, tol = d.get(kind, []), _cache["grid"][kind], TOL[kind]
        pad = tol / 111195.0
        best = {}
        for i in range(len(shape) - 1):
            a, b = shape[i], shape[i + 1]
            la0, la1 = min(a[0], b[0]) - pad, max(a[0], b[0]) + pad
            lo0, lo1 = min(a[1], b[1]) - pad * 2, max(a[1], b[1]) + pad * 2
            for cy in range(int(math.floor(la0 / CELL)), int(math.floor(la1 / CELL)) + 1):
                for cx in range(int(math.floor(lo0 / CELL)), int(math.floor(lo1 / CELL)) + 1):
                    for n in g.get((cy, cx), ()):
                        it = items[n]
                        t, dist = _proj((it[0], it[1]), a, b)
                        if kind == "rest" and dist < -40:
                            continue   # a rest area left of the road is the other carriageway's (right-hand traffic)
                        dist = abs(dist)
                        # first pass of the route wins: a later segment only if clearly closer and not far away along
                        if dist <= tol and (n not in best or dist < best[n][2] - 5 and i - best[n][0] < 3):
                            best[n] = (i, t, dist)
        rows = []
        for n, (i, t, dist) in best.items():
            it = items[n]
            rows.append([i, round(t, 3), round(dist)] + list(it[2:]))
        rows.sort(key=lambda r: (r[0], r[1]))
        out[kind] = rows
    return out


def nearest_rest(lat, lon, max_km=50.0):
    d = load()
    if d is None:
        return None
    best = None
    k = math.cos(math.radians(lat))
    for it in d.get("rest", []):
        km = math.hypot(it[0] - lat, (it[1] - lon) * k) * 111.195
        if km <= max_km and (best is None or km < best[0]):
            best = (km, it)
    if not best:
        return {}
    km, it = best
    return {"lat": it[0], "lon": it[1], "kind": it[2], "name": it[3], "km": round(km, 1)}


def info(h=None, q=None, j=None):
    d = load()
    if d is None:
        return {"available": False}
    return {"available": True, "built": d.get("built"), "source": d.get("source"), "coverage": d.get("coverage", ""),
            "osm_date": d.get("osm_date", ""), "counts": d.get("counts", {})}


def lez(h, q, j):
    d = load()
    if d is None:
        return {"zones": []}
    return {"zones": [{k: z[k] for k in ("name", "sticker", "bbox", "rings", "holes", "tags") if k in z} for z in d.get("lez", [])]}


def near(h, q, j):
    try:
        lat, lon = float(q["lat"][0]), float(q["lon"][0])
    except (KeyError, ValueError, IndexError):
        return {"error": "lat, lon missing"}, 400
    r = nearest_rest(lat, lon)
    return r if r is not None else ({"error": "no safety data"}, 404)


def do_along(h, q, j):
    shape = str(j.get("shape", ""))
    if not shape:
        return {"error": "shape missing"}, 400
    r = along(decode6(shape), [k for k in j.get("types", []) if isinstance(k, str)])
    return r if r is not None else ({"error": "no safety data"}, 404)


def _pip(lon, lat, ring):
    inside, j = False, len(ring) - 1
    for i in range(len(ring)):
        a, b = ring[i], ring[j]
        if (a[1] > lat) != (b[1] > lat) and lon < (b[0] - a[0]) * (lat - a[1]) / (b[1] - a[1]) + a[0]:
            inside = not inside
        j = i
    return inside


def in_zone(lon, lat, z):
    b = z["bbox"]
    if not (b[0] <= lon <= b[2] and b[1] <= lat <= b[3]):
        return False
    return any(_pip(lon, lat, r) for r in z["rings"]) and not any(_pip(lon, lat, r) for r in z.get("holes", []))


def active_zones(d):
    today = time.strftime("%Y-%m-%d")
    out = []
    for z in (d or {}).get("lez", []):
        t = z.get("tags", {})
        if t.get("end_date", "9999") >= today and t.get("start_date", "0000") <= today:
            out.append(z)
    return out


def entered(trip, zones, skip):
    """indices of the zones the trip's shape enters, leaving out `skip`"""
    hit = set()
    for leg in trip.get("legs", []):
        for lat, lon in decode6(leg.get("shape", "")):
            for k, z in enumerate(zones):
                if k not in skip and k not in hit and in_zone(lon, lat, z):
                    hit.add(k)
    return hit


def _valhalla(body):
    req = urllib.request.Request(VALHALLA_URL + "/route", json.dumps(body).encode(), {"Content-Type": "application/json"})
    try:
        with urllib.request.urlopen(req, timeout=180) as r:
            return r.status, json.load(r)
    except urllib.error.HTTPError as e:
        try:
            return e.code, json.load(e)
        except ValueError:
            return e.code, {"error": "Valhalla HTTP %d" % e.code}
    except OSError as e:
        return 502, {"error": "upstream unavailable: %s" % e}


def route_avoid(h, q, j):
    zones = active_zones(load())
    if not zones or not isinstance(j.get("locations"), list):
        return h.proxy(VALHALLA_URL + "/route", h.raw_body)
    locs = [l for l in j["locations"] if isinstance(l, dict) and "lat" in l and "lon" in l]
    skip = {k for k, z in enumerate(zones) if any(in_zone(l["lon"], l["lat"], z) for l in locs)}
    excl, r = set(), None
    for _ in range(AVOID_ROUNDS + 1):
        body = dict(j)
        if excl:
            body["exclude_polygons"] = [ring for k in sorted(excl) for ring in zones[k].get("avoid") or zones[k]["rings"]]
        code, r = _valhalla(body)
        if code != 200 or "trip" not in r:
            return r, code if code != 200 else 502
        new = entered(r["trip"], zones, skip | excl)
        if not new:
            break
        excl |= new
    r["safety"] = {"avoided": [zones[k].get("name", "") for k in sorted(excl)], "unavoidable": [zones[k].get("name", "") for k in sorted(skip)]}
    return r


def register(app):
    app.get("/api/safety/info", info)
    app.get("/api/safety/lez", lez)
    app.get("/api/safety/near", near)
    app.post("/api/safety/along", do_along)
    app.post("/api/safety/route", route_avoid)
    app.status("safety", lambda: (info() or {}).get("counts") or "no data")
