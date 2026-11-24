"""nav feature: map tiles (proxied to pmtiles serve), map glyphs, routing (Valhalla) and offline search."""
import json, math, os, queue, shutil, socket, sqlite3, subprocess, threading, time  # noqa: F401,E401

DATA = os.environ.get("NAV_DATA", "/srv/navdata")
REGION = os.environ.get("NAV_REGION") or os.path.basename(os.path.realpath(os.path.join(DATA, "current")))  # set by navd core
TILES_URL = os.environ.get("TILES_URL", "http://127.0.0.1:8081")
VALHALLA_URL = os.environ.get("VALHALLA_URL", "http://127.0.0.1:8002")
_COLS = {}  # db -> columns of places_fts (indexes before 2026-11-11 have no alt / cell)


_LETTERS = str.maketrans({"ß": "ss", "ø": "o", "æ": "ae", "ł": "l", "đ": "d", "þ": "th", "ð": "d", "œ": "oe", "ı": "i"})


def _fold(s):
    """lower case without accents (as the index tokenizer sees it) and ß ø ł … spelled out (tools/build_search.py)"""
    import unicodedata
    return "".join(c for c in unicodedata.normalize("NFD", s.lower()) if not unicodedata.combining(c)).translate(_LETTERS)


def _label(name, alt, toks):
    """the name to show: the local one, or 'Athens (Αθήνα)' when the query matched another spelling"""
    f = _fold(name)
    if not alt or any(t in f for t in toks):
        return name
    for a in alt.split("||")[0].split("|"):   # after "||": the context town's spellings
        if a and any(t in _fold(a) for t in toks):
            return "%s (%s)" % (a.title() if a.islower() else a, name)
    return name


def _context(town, alt):
    """the context town in Latin letters (PN-65): 'Athens' instead of 'Αθήνα' — first of its spellings after '||'"""
    if not town or not any(c.isalpha() and ord(c) > 0x24F for c in town) or not alt or "||" not in alt:
        return town
    for a in alt.split("||", 1)[1].split("|"):
        if a and not any(c.isalpha() and ord(c) > 0x24F for c in a):
            return a.title() if a.islower() else a
    return town


def search(q, lat=None, lon=None, limit=12):
    db = os.path.join(DATA, REGION, "search", "places.sqlite")
    if not os.path.exists(db) or not q.strip():
        return []
    words = [t.replace('"', "") for t in q.split() if t]
    if not words:
        return []
    con = sqlite3.connect("file:%s?mode=ro" % db, uri=True)
    if db not in _COLS:
        _COLS[db] = {r[1] for r in con.execute("PRAGMA table_info(places_fts)")}
    cols = _COLS[db]
    sql = ("SELECT p.name, p.kind, p.context, p.lat, p.lon, p.rank, %s FROM places_fts f "
           "JOIN places p ON p.id = f.rowid WHERE places_fts MATCH ? %%s LIMIT 400") % ("p.alt" if "alt" in cols else "''")
    box = (lat - .6, lat + .6, lon - .9, lon + .9) if lat is not None else None

    def run(terms):
        rows = []
        if "cell" in cols:
            terms = "{name context alt} : (%s)" % terms
        if box and "cell" in cols:  # nearby first (~70 km), so common names still find the local one
            cells = " OR ".join("g%03d%03d" % (a, o) for a in range(int(box[0] + 90), int(box[1] + 90) + 1)
                                for o in range(int(box[2] + 180), int(box[3] + 180) + 1))
            rows = con.execute(sql % "AND p.lat BETWEEN ? AND ? AND p.lon BETWEEN ? AND ?",
                               ("%s AND cell : (%s)" % (terms, cells),) + box).fetchall()
        elif box:
            rows = con.execute(sql % "AND p.lat BETWEEN ? AND ? AND p.lon BETWEEN ? AND ?", (terms,) + box).fetchall()
        return rows + con.execute(sql % "", (terms,)).fetchall()
    try:
        # finished words match whole, only the last one as a prefix (typing): prefix terms like "de"*
        # merge huge lists — "Rue de Rivoli Paris" took 465 ms on the build PC with every word a prefix
        rows = run(" ".join(['"%s"' % w for w in words[:-1]] + ['"%s"*' % words[-1]]))
        if not rows and len(words) > 1:  # "Haupt Freib": words not finished
            rows = run(" ".join('"%s"*' % w for w in words))
    finally:
        con.close()
    rows = list({(r[0], r[2], round(r[3], 3), round(r[4], 3)): r for r in rows}.values())
    toks = [_fold(t) for t in q.split() if t]

    PLACE = {"city": 3, "town": 2, "village": 1}

    def score(r):
        s = -r[5] * (1.5 if r[1] in PLACE else 1)  # population rank / street size
        s -= PLACE.get(r[1], 0) * 3
        if lat is not None:
            km = math.hypot(r[3] - lat, (r[4] - lon) * math.cos(math.radians(lat))) * 111
            s += min(km / 5, 40)  # nearer is better, up to 200 km
        name = _fold(r[0])
        alts = [_fold(a) for a in r[6].split("||")[0].split("|")] if r[6] else []
        if name == _fold(q.strip()):
            s -= 25
        elif _fold(q.strip()) in alts:
            s -= 5  # an alternative name ("Munich" for München) counts, but less than a place's own name
        if not any(t in name or any(t in a for a in alts) for t in toks):
            s += 12  # matched only through the town name
        return s
    rows.sort(key=score)
    return [dict(name=_label(r[0], r[6], toks), kind=r[1], context=_context(r[2], r[6]), lat=r[3], lon=r[4]) for r in rows[:limit]]




def tiles(h, q, j):
    return h.proxy(TILES_URL + h.path_only[len("/tiles"):])


def fonts(h, q, j):
    import urllib.request
    base = os.path.join(DATA, "fonts")
    p = os.path.normpath(os.path.join(base, urllib.request.unquote(h.path_only[len("/fonts/"):])))
    if not p.startswith(base) or not os.path.isfile(p):
        return {"error": "not found"}, 404
    with open(p, "rb") as f:
        return h.send_bytes(f.read(), "application/x-protobuf")


def do_search(h, q, j):
    f = lambda k: float(q[k][0]) if k in q else None  # noqa: E731
    return search(q.get("q", [""])[0], f("lat"), f("lon"))


def route(h, q, j):
    return h.proxy(VALHALLA_URL + "/route", h.raw_body)


def _decode6(s):
    pts, i, lat, lon = [], 0, 0, 0
    while i < len(s):
        for k in (0, 1):
            r = sh = 0
            while True:
                b = ord(s[i]) - 63; i += 1
                r |= (b & 0x1f) << sh; sh += 5
                if b < 0x20:
                    break
            d = ~(r >> 1) if r & 1 else r >> 1
            if k == 0:
                lat += d
            else:
                lon += d
        pts.append((lat, lon))
    return pts


def _encode6(pts):
    out, plat, plon = [], 0, 0
    for lat, lon in pts:
        for v in (lat - plat, lon - plon):
            v = ~(v << 1) if v < 0 else v << 1
            while v >= 0x20:
                out.append(chr((0x20 | (v & 0x1f)) + 63)); v >>= 5
            out.append(chr(v + 63))
        plat, plon = lat, lon
    return "".join(out)


LIMIT_CHUNK = 15000   # Valhalla refuses > 16000 shape points per /trace_attributes call (PN-64: long routes)


def limits(h, q, j):
    """speed limits along a route (PN-42): Valhalla /trace_attributes, edge_walk on the route's own shape.
    In: {shape: <encoded polyline, precision 6>}. Out: {edges: [[begin_shape_index, end_shape_index, km/h or 0], ...]}
    Long shapes go in overlapping chunks (1 shared point); indices are shifted back onto the whole shape."""
    import urllib.request
    shape = str(j.get("shape", ""))
    if not shape:
        return {"error": "shape missing"}, 400
    pts = _decode6(shape)
    chunks = [shape] if len(pts) <= LIMIT_CHUNK else [_encode6(pts[a:a + LIMIT_CHUNK + 1]) for a in range(0, len(pts) - 1, LIMIT_CHUNK)]
    edges = []
    for n, enc in enumerate(chunks):
        body = {"encoded_polyline": enc, "costing": "auto", "shape_match": "edge_walk",
                "filters": {"action": "include", "attributes": ["edge.speed_limit", "edge.begin_shape_index", "edge.end_shape_index"]}}
        try:
            req = urllib.request.Request(VALHALLA_URL + "/trace_attributes", json.dumps(body).encode(), {"Content-Type": "application/json"})
            r = json.load(urllib.request.urlopen(req, timeout=60))
        except Exception as e:
            if len(chunks) == 1:
                return {"error": "limits unavailable: %s" % e}, 502
            continue   # one bad chunk: that stretch shows no sign, the rest still works
        o = n * LIMIT_CHUNK
        edges += [[x.get("begin_shape_index", 0) + o, x.get("end_shape_index", 0) + o, x.get("speed_limit", 0)] for x in r.get("edges", [])]
    return {"edges": edges}


def _lane(x):
    """one OSRM lane -> [indications 'straight|right', valid 0/1, the indication to follow or '']"""
    return ["|".join(x.get("indications") or ["none"]), 1 if x.get("valid") else 0, x.get("valid_indication", "")]


def lanes(h, q, j):
    """lanes + junction shape at every maneuver of a route (PN-36/40): Valhalla /trace_route with
    format=osrm, edge_walk on the route's own shape (the native /route JSON carries no lanes).
    In: {shape: <encoded polyline, precision 6>}. Out: {points: [{at: [lon, lat], lanes: [[ind, valid, follow]] | null,
    b: [bearings], in: idx, out: idx}]} - one per OSRM step (= Valhalla maneuver); the app matches them by position."""
    import urllib.request
    shape = str(j.get("shape", ""))
    if not shape:
        return {"error": "shape missing"}, 400
    pts = _decode6(shape)
    chunks = [shape] if len(pts) <= LIMIT_CHUNK else [_encode6(pts[a:a + LIMIT_CHUNK + 1]) for a in range(0, len(pts) - 1, LIMIT_CHUNK)]
    out = []
    for enc in chunks:
        body = {"encoded_polyline": enc, "costing": "auto", "shape_match": "edge_walk", "format": "osrm"}
        try:
            req = urllib.request.Request(VALHALLA_URL + "/trace_route", json.dumps(body).encode(), {"Content-Type": "application/json"})
            r = json.load(urllib.request.urlopen(req, timeout=60))
        except Exception as e:
            if len(chunks) == 1:
                return {"error": "lanes unavailable: %s" % e}, 502
            continue   # one bad chunk: no lanes on that stretch
        for m in r.get("matchings", []):
            for leg in m.get("legs", []):
                for st in leg.get("steps", []):
                    ix = (st.get("intersections") or [{}])[0]
                    if "location" not in ix:
                        continue
                    ln = ix.get("lanes")
                    out.append({"at": [round(c, 6) for c in ix["location"]], "lanes": [_lane(x) for x in ln] if ln else None,
                                "b": ix.get("bearings", []), "in": ix.get("in"), "out": ix.get("out")})
    return {"points": out}

# ---------- PN-38 places along the route: fuel, parking, toilets, rest areas ----------
# Source: the map's POI layer (Protomaps z15 tiles carry every POI, named or not — the search index keeps
# only named ones). Fast path: <region>/along/along.sqlite, an R*Tree of just these kinds built from the
# tiles by tools/build_along.py. Without it the route corridor is read from the z15 tiles directly
# (only ALONG_TILE_KM ahead, that is slower).
ALONG_KINDS = {"fuel": ("fuel",), "parking": ("parking",), "toilets": ("toilets",), "rest": ("rest_area", "services")}
ALL_KINDS = {k for v in ALONG_KINDS.values() for k in v}
ALONG_Z = 15
ALONG_TILE_KM = float(os.environ.get("ALONG_TILE_KM", "60"))
_tls = threading.local()


def _varint(b, i):
    r = s = 0
    while True:
        c = b[i]; i += 1
        r |= (c & 0x7F) << s
        if c < 0x80:
            return r, i
        s += 7


def _fields(b):
    i, n = 0, len(b)
    while i < n:
        key, i = _varint(b, i)
        f, t = key >> 3, key & 7
        if t == 0:
            v, i = _varint(b, i)
        elif t == 2:
            ln, i = _varint(b, i); v = b[i:i + ln]; i += ln
        elif t == 1:
            v = b[i:i + 8]; i += 8
        elif t == 5:
            v = b[i:i + 4]; i += 4
        else:
            raise ValueError("wire type %d" % t)
        yield f, t, v


def _packed(b):
    out, i = [], 0
    while i < len(b):
        v, i = _varint(b, i); out.append(v)
    return out


def _string(vb):
    for f, _, v in _fields(vb):
        if f == 1:
            return v.decode("utf-8", "replace")
    return None


def tile_pois(tile, z, tx, ty, kinds=ALL_KINDS):
    """[(kind, name, lat, lon)] of the wanted kinds in one decoded MVT tile (layer 'pois', first point)"""
    out = []
    for f, _, lb in _fields(tile):
        if f != 3:
            continue
        name, feats, keys, vals, extent = None, [], [], [], 4096
        for g, _, v in _fields(lb):
            if g == 1: name = v.decode()
            elif g == 2: feats.append(v)
            elif g == 3: keys.append(v.decode())
            elif g == 4: vals.append(v)
            elif g == 5: extent = v
        if name != "pois" or "kind" not in keys:
            continue
        kk, nk = keys.index("kind"), keys.index("name") if "name" in keys else -1
        want = {}
        for i, vb in enumerate(vals):   # value indices whose string is a wanted kind: features are skipped by index
            s = _string(vb)
            if s in kinds:
                want[i] = s
        if not want:
            continue
        n = 2 ** z
        for fb in feats:
            tags, geom = None, None
            for g, _, v in _fields(fb):
                if g == 2: tags = _packed(v)
                elif g == 4: geom = v
            if not tags or not geom:
                continue
            kind, nm = None, ""
            for a in range(0, len(tags) - 1, 2):
                if tags[a] == kk:
                    kind = want.get(tags[a + 1])
                elif tags[a] == nk:
                    nm = _string(vals[tags[a + 1]]) or ""
            if not kind:
                continue
            g = _packed(geom)
            if len(g) < 3:
                continue
            x, y = (g[1] >> 1) ^ -(g[1] & 1), (g[2] >> 1) ^ -(g[2] & 1)   # first MoveTo
            lon = (tx + x / extent) / n * 360 - 180
            lat = math.degrees(math.atan(math.sinh(math.pi * (1 - 2 * (ty + y / extent) / n))))
            out.append((kind, nm, lat, lon))
    return out


def fetch_tile(base, z, x, y):
    """one tile from a pmtiles server (keep-alive per thread); b'' when it does not exist"""
    import gzip, http.client, urllib.parse
    u = urllib.parse.urlparse(base)
    for attempt in (0, 1):
        con = getattr(_tls, "con", None)
        if con is None or getattr(_tls, "host", None) != u.netloc:
            con = _tls.con = http.client.HTTPConnection(u.netloc, timeout=30); _tls.host = u.netloc
        try:
            con.request("GET", "%s/%d/%d/%d.mvt" % (u.path.rstrip("/"), z, x, y))
            r = con.getresponse(); b = r.read()
            if r.status != 200:
                return b""
            return gzip.decompress(b) if b[:2] == b"\x1f\x8b" else b
        except (OSError, http.client.HTTPException):
            _tls.con = None
            if attempt:
                return b""
    return b""


def _tile_xy(lat, lon, z=ALONG_Z):
    n = 2 ** z
    return ((lon + 180) / 360 * n, (1 - math.asinh(math.tan(math.radians(lat))) / math.pi) / 2 * n)


def corridor_tiles(pts, width_m, z=ALONG_Z):
    """z15 tiles within width_m of a polyline [(lat, lon)] (points sampled ~every 150 m)"""
    out = set()
    for i in range(len(pts)):
        a = pts[i]; b = pts[i + 1] if i + 1 < len(pts) else a
        seg = math.hypot(b[0] - a[0], (b[1] - a[1]) * math.cos(math.radians(a[0]))) * 111320
        steps = max(1, int(seg / 150))
        for s in range(steps if i + 1 < len(pts) else 1):
            la, lo = a[0] + (b[0] - a[0]) * s / steps, a[1] + (b[1] - a[1]) * s / steps
            tile_m = 40075016 * math.cos(math.radians(la)) / 2 ** z
            fx, fy = _tile_xy(la, lo, z)
            r = width_m / tile_m
            for x in range(int(fx - r), int(fx + r) + 1):
                for y in range(int(fy - r), int(fy + r) + 1):
                    out.add((x, y))
    return out


def _along_db():
    p = os.path.join(DATA, REGION, "along", "along.sqlite")
    return p if os.path.exists(p) else None


def _xy(lat, lon, lat0):
    return lon * 111320 * math.cos(math.radians(lat0)), lat * 110540


def route_grid(pts, lo_i=0, cell=2000.0):
    """segments of the route (from point lo_i on) in 2 km cells of a local flat frame, for project_route"""
    lat0 = pts[0][0]
    xy = [_xy(a, b, lat0) for a, b in pts]
    grid = {}
    for i in range(lo_i, len(xy) - 1):
        (x1, y1), (x2, y2) = xy[i], xy[i + 1]
        for cx in range(int(min(x1, x2) // cell), int(max(x1, x2) // cell) + 1):
            for cy in range(int(min(y1, y2) // cell), int(max(y1, y2) // cell) + 1):
                grid.setdefault((cx, cy), []).append(i)
    return {"xy": xy, "cells": grid, "cell": cell, "lat0": lat0}


def project_route(pts, cum, cands, width_m, grid=None):
    """for each candidate (kind, name, lat, lon) within width_m of the route: (cand, metres along, metres off, segment)"""
    grid = grid or route_grid(pts)
    xy, cells, cell, lat0 = grid["xy"], grid["cells"], grid["cell"], grid["lat0"]
    reach = int(width_m // cell) + 1
    out = []
    for c in cands:
        px, py = _xy(c[2], c[3], lat0)
        gx, gy = int(px // cell), int(py // cell)
        best, seen = None, set()
        for cx in range(gx - reach, gx + reach + 1):
            for cy in range(gy - reach, gy + reach + 1):
                for i in cells.get((cx, cy), ()):
                    if i in seen:
                        continue
                    seen.add(i)
                    (x1, y1), (x2, y2) = xy[i], xy[i + 1]
                    dx, dy = x2 - x1, y2 - y1
                    L = dx * dx + dy * dy
                    t = max(0.0, min(1.0, ((px - x1) * dx + (py - y1) * dy) / L)) if L else 0.0
                    d = math.hypot(px - (x1 + dx * t), py - (y1 + dy * t))
                    # the first pass of the route counts (a route that comes back later is not "ahead" twice)
                    if best is None or d < best[0] - 1 or (abs(d - best[0]) <= 1 and i < best[2]):
                        best = (d, cum[i] + (cum[i + 1] - cum[i]) * t, i)
        if best and best[0] <= width_m:
            out.append((c, best[1], best[0], best[2]))
    return out


def _matrix(sources, targets, timeout=10):
    """Valhalla /sources_to_targets (auto): metres [source][target], None where there is no route"""
    import urllib.request
    loc = lambda p: dict({"lat": p[0], "lon": p[1]}, **({"heading": round(p[2]), "heading_tolerance": 45} if len(p) > 2 else {}))  # noqa: E731
    body = {"sources": [loc(p) for p in sources], "targets": [loc(p) for p in targets], "costing": "auto"}
    try:
        req = urllib.request.Request(VALHALLA_URL + "/sources_to_targets", json.dumps(body).encode(), {"Content-Type": "application/json"})
        r = json.load(urllib.request.urlopen(req, timeout=timeout))
    except Exception:
        return None
    out = [[None] * len(targets) for _ in sources]
    for row in r.get("sources_to_targets", []):
        for c in row:
            if c.get("distance") is not None and c.get("from_index") is not None:
                out[c["from_index"]][c["to_index"]] = c["distance"] * 1000
    return out


def _at(pts, cum, m):
    """point (lat, lon, heading) at m metres along the route"""
    import bisect
    i = max(0, min(len(pts) - 2, bisect.bisect_right(cum, m) - 1))
    seg = (cum[i + 1] - cum[i]) or 1
    t = max(0.0, min(1.0, (m - cum[i]) / seg))
    a, b = pts[i], pts[i + 1]
    hd = math.degrees(math.atan2((b[1] - a[1]) * math.cos(math.radians(a[0])), b[0] - a[0])) % 360
    return (a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t, hd)


def detours(pts, cum, rows):
    """extra metres to visit each place: route point A (1.5 km before) -> place -> route point B (3 km after),
    minus the route from A to B. Places within 20 km share one A and one B: two small Valhalla matrix calls
    per group (1 x n, n x 1). The place snaps in the driving direction (heading of the route there), so the
    services on the far carriageway of a motorway come out as a long detour. rows: [(cand, metres along, off)]"""
    out, groups = [None] * len(rows), []
    for i, r in enumerate(rows):
        if groups and r[1] - rows[groups[-1][0]][1] < 20000:
            groups[-1].append(i)
        else:
            groups.append([i])

    def one(g):
        a = max(0.0, rows[g[0]][1] - 1500); b = min(cum[-1], rows[g[-1]][1] + 3000)
        P = [(rows[i][0][2], rows[i][0][3], _at(pts, cum, rows[i][1])[2]) for i in g]
        m1, m2 = _matrix([_at(pts, cum, a)], P), _matrix(P, [_at(pts, cum, b)[:2]])
        res = []
        for k in range(len(g)):
            d1 = m1 and m1[0][k]; d2 = m2 and m2[k][0]
            res.append(None if d1 is None or d2 is None else max(0.0, d1 + d2 - (b - a)))
        return res
    from concurrent.futures import ThreadPoolExecutor
    with ThreadPoolExecutor(2) as ex:
        for g, res in zip(groups, ex.map(one, groups)):
            for i, v in zip(g, res):
                out[i] = v
    return out


def along(h, q, j):
    """POST /api/along {legs: [polyline6 of each leg] (or shape: one polyline6), from_m: metres already driven, cat: fuel|parking|toilets|rest,
    width_m: corridor half-width (default 1500), limit: rows (default 10), detours: true,
    max_detour_m: rows with a longer detour are left out (default 8000: the services on the far carriageway)}
    -> {items: [{kind, name, lat, lon, ahead_m, off_m, detour_m|null}], source: index|tiles, ms, tiles?}"""
    t0 = time.time()
    legs = [str(x) for x in j.get("legs", [])] or [str(j.get("shape", ""))]   # a trip with stops: one shape per leg
    cat = j.get("cat", "fuel")
    if not any(legs) or cat not in ALONG_KINDS:
        return {"error": "shape and cat (%s) needed" % "|".join(ALONG_KINDS)}, 400
    kinds = set(ALONG_KINDS[cat])
    width = max(100.0, min(5000.0, float(j.get("width_m", 1500))))
    limit = max(1, min(20, int(j.get("limit", 10))))
    from_m = max(0.0, float(j.get("from_m", 0)))
    pts = []
    for leg in legs:
        p = [(a / 1e6, b / 1e6) for a, b in _decode6(leg)]
        pts += p[1:] if pts else p
    if len(pts) < 2:
        return {"items": [], "source": "none", "ms": 0}
    cum = [0.0]
    for i in range(1, len(pts)):
        a, b = pts[i - 1], pts[i]
        cum.append(cum[-1] + math.hypot(b[0] - a[0], (b[1] - a[1]) * math.cos(math.radians(a[0]))) * 111195)
    import bisect
    from concurrent.futures import ThreadPoolExecutor
    lo_i = max(0, bisect.bisect_right(cum, from_m) - 2)
    db = _along_db()
    info = {"source": "index" if db else "tiles"}
    end_m = cum[-1] if db else min(cum[-1], from_m + ALONG_TILE_KM * 1000)   # no index: only ALONG_TILE_KM ahead
    grid = route_grid(pts, lo_i)
    con = sqlite3.connect("file:%s?mode=ro" % db, uri=True) if db else None
    base, marks = TILES_URL + "/" + REGION, ",".join("?" * len(kinds))
    hits, keys, done_tiles, ncand = [], set(), set(), 0
    w0 = from_m
    try:
        # the route ahead in 15 km windows, nearest first, until enough places are found
        while w0 < end_m and len(hits) < limit * 3:
            w1 = min(end_m, w0 + 15000)
            i = max(0, bisect.bisect_right(cum, w0) - 2)
            k = min(len(pts) - 1, bisect.bisect_right(cum, w1) + 1)
            piece = pts[i:k + 1]
            if con:
                la = [p[0] for p in piece]; lo = [p[1] for p in piece]
                dla = width / 110540; dlo = width / (111320 * math.cos(math.radians(la[0])))
                cands = con.execute(
                    "SELECT p.kind, p.name, p.lat, p.lon FROM poi_rt r JOIN poi p ON p.id = r.id "
                    "WHERE r.minlat <= ? AND r.maxlat >= ? AND r.minlon <= ? AND r.maxlon >= ? AND p.kind IN (%s)" % marks,
                    (max(la) + dla, min(la) - dla, max(lo) + dlo, min(lo) - dlo) + tuple(sorted(kinds))).fetchall()
            else:
                tiles = sorted(corridor_tiles(piece, width) - done_tiles)
                done_tiles |= set(tiles)
                with ThreadPoolExecutor(4) as ex:
                    cands = [c for got in ex.map(lambda t: tile_pois(fetch_tile(base, ALONG_Z, t[0], t[1]), ALONG_Z, t[0], t[1], kinds), tiles) for c in got]
            ncand += len(cands)
            for x in project_route(pts, cum, cands, width, grid):
                key = (x[0][0], x[0][1], round(x[0][2], 5), round(x[0][3], 5))
                # each place counts once, in the window its nearest route point falls into (and not behind the car)
                if key in keys or not (max(w0, from_m) - 150 <= x[1] < w1 or (w1 >= end_m and x[1] >= w0)):
                    continue
                keys.add(key); hits.append(x)
            w0 = w1
    finally:
        if con:
            con.close()
    if not db:
        info.update(tiles=len(done_tiles), window_km=ALONG_TILE_KM)
    hits.sort(key=lambda x: x[1])
    # several nodes of one big parking/services area: keep one per 150 m
    rows = []
    for c, at_m, off, _ in hits:
        if any(r[0][0] == c[0] and abs(r[1] - at_m) < 150 and abs(r[2] - off) < 150 for r in rows[-6:]):
            continue
        rows.append((c, at_m, off))
        if len(rows) >= limit + 6:   # a few more: the far-carriageway ones are dropped after the detour check
            break
    dets = [None] * len(rows)
    if j.get("detours", True) and rows:
        dets = detours(pts, cum, rows)
    max_det = float(j.get("max_detour_m", 8000))
    items = [{"kind": c[0], "name": c[1], "lat": round(c[2], 6), "lon": round(c[3], 6), "ahead_m": max(0, round(at_m - from_m)),
              "off_m": round(off), "detour_m": None if d is None else round(d)} for (c, at_m, off), d in zip(rows, dets)
             if d is None or d <= max_det][:limit]
    info.update(items=items, ms=round((time.time() - t0) * 1000), candidates=ncand)
    return info


def data_info():
    info = {}
    for part in ("map", "valhalla", "search", "along"):
        bi = os.path.join(DATA, REGION, part, "BUILD-INFO")
        if os.path.exists(bi):
            info[part] = open(bi).read()
    return info


def register(app):
    app.get_prefix("/tiles/", tiles)
    app.get_prefix("/fonts/", fonts)
    app.get("/api/search", do_search)
    app.post("/api/route", route)
    app.post("/api/limits", limits)
    app.post("/api/lanes", lanes)
    app.post("/api/along", along)
    app.status("region", lambda: REGION)
    app.status("data", data_info)
