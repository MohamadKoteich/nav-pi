#!/usr/bin/env python3
"""Build the offline search index (SQLite FTS5) from a Protomaps .pmtiles map — stdlib only.

    build_search.py TILE_BASE_URL OUT.sqlite --bbox W,S,E,N [--zoom 14] [--threads 8]

TILE_BASE_URL is a `pmtiles serve` endpoint for the region, e.g. http://127.0.0.1:18081/germany
Indexed: places (cities, towns, villages, suburbs) from zoom 6-12, and named streets and POIs from
--zoom. Each street/POI gets the nearest town/village as context ("Hauptstraße, München").
FTS column `cell`: the feature's 1-degree square, for fast "near me" queries (features/nav/navd_nav.py).
Column `alt`: other spellings, "|"-separated (after "||": those of the context town), so a Latin keyboard (a-z + äöüß) finds every name:
the place's English/German/French/Italian/Spanish names (Αθήνα -> Athens|Athen|Athènes),
a Latin transliteration of Greek and Cyrillic names (Ερμού -> Ermou, Київ -> Kyiv|Kiiv) and
letters the search tokenizer does not fold (Tromsø -> Tromso, Łódź -> Lodz, Straße -> Strasse).
"""
import argparse
import gc
import gzip
import json
import math
import multiprocessing
import os
import sqlite3
import sys
import unicodedata
import urllib.error
import urllib.request
from concurrent.futures import ProcessPoolExecutor


# ---- minimal protobuf / Mapbox Vector Tile decoder ------------------------------------------
def varint(b, i):
    r = s = 0
    while True:
        c = b[i]; i += 1
        r |= (c & 0x7F) << s
        if c < 0x80:
            return r, i
        s += 7


def fields(b):
    i, n = 0, len(b)
    while i < n:
        key, i = varint(b, i)
        f, t = key >> 3, key & 7
        if t == 0:
            v, i = varint(b, i)
        elif t == 2:
            ln, i = varint(b, i); v = b[i:i + ln]; i += ln
        elif t == 1:
            v = b[i:i + 8]; i += 8
        elif t == 5:
            v = b[i:i + 4]; i += 4
        else:
            raise ValueError("wire type %d" % t)
        yield f, t, v


def packed(b):
    out, i = [], 0
    while i < len(b):
        v, i = varint(b, i); out.append(v)
    return out


def zz(n):
    return (n >> 1) ^ -(n & 1)


def value(b):
    import struct
    for f, t, v in fields(b):
        if f == 1:
            return v.decode("utf-8", "replace")
        if f == 2:
            return struct.unpack("<f", v)[0]
        if f == 3:
            return struct.unpack("<d", v)[0]
        if f in (4, 5):
            return v
        if f == 6:
            return zz(v)
        if f == 7:
            return bool(v)
    return None


def decode(tile, want):
    """yield (layer, props, [(x,y)...] first-path points in tile units, extent)"""
    for f, _, lb in fields(tile):
        if f != 3:
            continue
        name, feats, keys, vals, extent = None, [], [], [], 4096
        for g, _, v in fields(lb):
            if g == 1: name = v.decode()
            elif g == 2: feats.append(v)
            elif g == 3: keys.append(v.decode())
            elif g == 4: vals.append(v)
            elif g == 5: extent = v
        if name not in want:
            continue
        vcache = {}
        for fb in feats:
            tags, geom = [], []
            for g, t, v in fields(fb):
                if g == 2: tags = packed(v)
                elif g == 4: geom = packed(v)
            props = {}
            for k, vi in zip(tags[0::2], tags[1::2]):
                if vi not in vcache:
                    vcache[vi] = value(vals[vi])
                props[keys[k]] = vcache[vi]
            if "name" not in props:
                continue
            pts, x, y, i = [], 0, 0, 0
            while i < len(geom) and len(pts) < 64:
                cmd, cnt = geom[i] & 7, geom[i] >> 3; i += 1
                if cmd == 7:
                    continue
                for _ in range(cnt):
                    x += zz(geom[i]); y += zz(geom[i + 1]); i += 2
                    pts.append((x, y))
                if cmd == 1 and len(pts) > 1:
                    break
            if pts:
                yield name, props, pts, extent


# ---- other spellings (column alt) --------------------------------------------------------------
LATIN_FOLD = {"ø": "o", "æ": "ae", "ł": "l", "đ": "d", "þ": "th", "ð": "d", "œ": "oe", "ı": "i", "ß": "ss", "ŀ": "l"}
GREEK = {"α": "a", "β": "v", "γ": "g", "δ": "d", "ε": "e", "ζ": "z", "η": "i", "θ": "th", "ι": "i", "κ": "k",
         "λ": "l", "μ": "m", "ν": "n", "ξ": "x", "ο": "o", "π": "p", "ρ": "r", "σ": "s", "ς": "s", "τ": "t",
         "υ": "y", "φ": "f", "χ": "ch", "ψ": "ps", "ω": "o"}
GREEK_PAIRS = {"ου": "ou", "αι": "ai", "ει": "ei", "οι": "oi", "αυ": "av", "ευ": "ev", "γγ": "ng", "γκ": "gk", "μπ": "mp", "ντ": "nt"}
# two Cyrillic spellings: English-style (Zhytomyr, Shchuchin) and the stripped scientific one used for
# Serbian/Macedonian/Bulgarian Latin forms (Čačak -> cacak)
CYR_COMMON = {"а": "a", "б": "b", "в": "v", "г": "g", "д": "d", "е": "e", "ё": "e", "з": "z", "и": "i", "к": "k",
              "л": "l", "м": "m", "н": "n", "о": "o", "п": "p", "р": "r", "с": "s", "т": "t", "у": "u", "ф": "f",
              "ъ": "", "ь": "", "ы": "y", "э": "e", "і": "i", "ґ": "g", "ў": "u", "ђ": "dj", "ј": "j", "љ": "lj",
              "њ": "nj", "ћ": "c", "џ": "dz", "ѓ": "gj", "ќ": "kj", "ѕ": "dz", "'": "", "’": ""}
CYR_EN = dict(CYR_COMMON, **{"ж": "zh", "х": "kh", "ц": "ts", "ч": "ch", "ш": "sh", "щ": "shch", "ю": "yu", "я": "ya",
                             "й": "y", "ї": "yi", "є": "ye"})
CYR_SCI = dict(CYR_COMMON, **{"ж": "z", "х": "h", "ц": "c", "ч": "c", "ш": "s", "щ": "st", "ю": "ju", "я": "ja",
                              "й": "j", "ї": "ji", "є": "je"})


def _strip(s):
    return "".join(c for c in unicodedata.normalize("NFD", s) if not unicodedata.combining(c))


def _map(s, table, pairs=None):
    out, i = [], 0
    while i < len(s):
        if pairs and s[i:i + 2] in pairs:
            out.append(pairs[s[i:i + 2]]); i += 2; continue
        c = s[i]
        out.append(table.get(c, c)); i += 1
    return "".join(out)


def spellings(name):
    """Latin spellings of a name that the FTS tokenizer would not find from a-z + äöüß ([] if none)"""
    low = name.lower()
    out = []
    if any(c in LATIN_FOLD for c in low):
        out.append(_map(low, LATIN_FOLD))
    if any("\u0370" <= c <= "\u03ff" or "\u1f00" <= c <= "\u1fff" for c in low):
        out.append(_map(_strip(low), GREEK, GREEK_PAIRS))
    if any("\u0400" <= c <= "\u04ff" for c in low):
        out += [_map(low, CYR_EN), _map(low, CYR_SCI)]
    return list(dict.fromkeys(x for x in out if x and x != low))


ALT_LANGS = ("name:en", "name:de", "name:fr", "name:it", "name:es")


def alt_names(name, props=None):
    """'|'-joined other spellings of a feature: its names in ALT_LANGS (places) + spellings() of all"""
    names = [props[k] for k in ALT_LANGS if props and isinstance(props.get(k), str) and props[k] != name]
    out = []
    for n in [name] + names:
        if n != name:
            out.append(n)
        out += spellings(n)
    seen, low = set(), _strip(name.lower())
    res = []
    for n in out:
        k = _strip(n.lower())
        if k != low and k not in seen:
            seen.add(k); res.append(n)
    return "|".join(res)


# ---- tile math -------------------------------------------------------------------------------
def lonlat(z, tx, ty, x, y, extent):
    n = 2 ** z
    lon = (tx + x / extent) / n * 360 - 180
    lat = math.degrees(math.atan(math.sinh(math.pi * (1 - 2 * (ty + y / extent) / n))))
    return lat, lon


def tile_range(bbox, z):
    w, s, e, nn = bbox
    n = 2 ** z
    def ty(lat):
        r = math.radians(lat)
        return int((1 - math.asinh(math.tan(r)) / math.pi) / 2 * n)
    return z, int((w + 180) / 360 * n), int((e + 180) / 360 * n), ty(nn), ty(s)


def tiles_for(bbox, z):
    z, x0, x1, y0, y1 = tile_range(bbox, z)
    for x in range(x0, x1 + 1):
        for y in range(y0, y1 + 1):
            yield z, x, y


def fetch(base, z, x, y):
    try:
        with urllib.request.urlopen("%s/%d/%d/%d.mvt" % (base, z, x, y), timeout=60) as r:
            b = r.read()
            if r.headers.get("Content-Encoding") == "gzip" or b[:2] == b"\x1f\x8b":
                b = gzip.decompress(b)
            return b
    except urllib.error.HTTPError as e:
        if e.code in (204, 404):
            return b""
        raise


BASE = None
GRID = {}  # (int(lat*20), int(lon*20)) -> [(town name, lat, lon, tier)]; set before the detail workers fork


def nearest_town(lat, lon):
    """the municipality a street belongs to: nearest city/town within ~8 km, else nearest
    village within ~5 km, else the nearest locality of any kind"""
    gy, gx = int(lat * 20), int(lon * 20)
    best = {}
    for dy in range(-3, 4):
        for dx in range(-3, 4):
            for name, la, lo, tier in GRID.get((gy + dy, gx + dx), ()):
                km = math.hypot(la - lat, (lo - lon) * math.cos(math.radians(lat))) * 111
                if tier not in best or km < best[tier][1]:
                    best[tier] = (name, km)
    if 0 in best and best[0][1] < 8:
        return best[0][0]
    if 1 in best and best[1][1] < 5:
        return best[1][0]
    return min(best.values(), key=lambda v: v[1])[0] if best else ""


def init_worker(base):
    global BASE
    BASE = base


def do_detail(t):
    z, x, y = t
    out_s, out_p = [], []
    for layer, p, pts, ext in decode(fetch(BASE, z, x, y), {"roads", "pois"}):
        mid = pts[len(pts) // 2]
        lat, lon = lonlat(z, x, y, mid[0], mid[1], ext)
        if layer == "roads":
            if p.get("kind") in ("path", "rail", "ferry") or p.get("kind_detail") in ("service",):
                continue
            out_s.append((p["name"], nearest_town(lat, lon), lat, lon, p.get("kind", "")))
        else:
            out_p.append((p["name"], round(lat * 1000), round(lon * 1000), lat, lon, p.get("kind", ""), nearest_town(lat, lon)))
    return out_s, out_p


PLACE_KINDS = {"locality", "neighbourhood", "macrohood", "region", "country"}


def do_places(t, bbox):
    z, x, y = t
    out = []
    for layer, p, pts, ext in decode(fetch(BASE, z, x, y), {"places"}):
        kind = p.get("kind", "")
        if kind not in PLACE_KINDS:
            continue
        lat, lon = lonlat(z, x, y, pts[0][0], pts[0][1], ext)
        if not (bbox[1] <= lat <= bbox[3] and bbox[0] <= lon <= bbox[2]):
            continue
        rank = int(p.get("population_rank") or 0)
        out.append(((p["name"], kind, round(lat, 2), round(lon, 2)),
                    (lat, lon, rank, p.get("kind_detail", ""), alt_names(p["name"], p))))
    return out


def batched_map(ex, fn, items, *const, batch=20000, chunksize=64):
    """ex.map over an iterator in batches: Executor.map submits everything at once (16 M futures for
    Europe = several GB in the main process)"""
    buf = []
    for it in items:
        buf.append(it)
        if len(buf) >= batch:
            yield from ex.map(fn, buf, *[[c] * len(buf) for c in const], chunksize=chunksize)
            buf = []
    if buf:
        yield from ex.map(fn, buf, *[[c] * len(buf) for c in const], chunksize=chunksize)


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("base"); ap.add_argument("out")
    ap.add_argument("--bbox", required=True)
    ap.add_argument("--zoom", type=int, default=14)
    ap.add_argument("--threads", type=int, default=8)
    a = ap.parse_args()
    bbox = [float(v) for v in a.bbox.split(",")]
    tmp = a.out + ".part"
    for f in (tmp, tmp + ".raw"):
        if os.path.exists(f):
            os.remove(f)

    fork = multiprocessing.get_context("fork")
    ex = ProcessPoolExecutor(a.threads, mp_context=fork, initializer=init_worker, initargs=(a.base,))
    places = {}  # (name, kind, lat2, lon2) -> (lat, lon, rank, kind_detail, alt)
    for z in range(6, 13):
        for found in batched_map(ex, do_places, tiles_for(bbox, z), bbox):
            for key, val in found:
                places[key] = val
    # context candidates: (name, lat, lon, tier) tier 0 = city/town, 1 = village, 2 = other localities
    ex.shutdown()
    TIER = {"city": 0, "town": 0, "village": 1}
    grid = GRID
    ntowns = 0
    for k, v in places.items():
        if k[1] == "locality":
            grid.setdefault((int(v[0] * 20), int(v[1] * 20)), []).append((k[0], v[0], v[1], TIER.get(v[3], 2)))
            ntowns += 1
    print("places:", len(places), "towns:", ntowns, file=sys.stderr)
    # Αθήνα -> Athens|…: of several towns with one name, the biggest one's spellings (a small Αθήνα
    # without name:en must not hide the capital's, seen 2026-11-11)
    town_alt, town_rank = {}, {}
    for k, v in places.items():
        if k[1] == "locality" and v[4] and v[2] >= town_rank.get(k[0], -1):
            town_alt[k[0]], town_rank[k[0]] = v[4], v[2]
    del town_rank

    # streets and POIs go to a scratch SQLite file, deduplicated there at the end: in Python dicts
    # Europe's ~20 M of them did not fit in 20 GB
    raw = sqlite3.connect(tmp + ".raw")
    raw.executescript("""PRAGMA journal_mode=OFF; PRAGMA synchronous=OFF;
      CREATE TABLE s(name TEXT, town TEXT, lat REAL, lon REAL, kind TEXT);
      CREATE TABLE p(name TEXT, lat3 INTEGER, lon3 INTEGER, lat REAL, lon REAL, kind TEXT, town TEXT);""")
    # detail workers fork now and inherit GRID; gc.freeze() keeps the collector from touching (and so
    # copying) the big tables in every worker (seen 2026-11-11 without it: 6 x 3.7 GB RSS)
    gc.collect(); gc.freeze()
    ex = ProcessPoolExecutor(a.threads, mp_context=fork, initializer=init_worker, initargs=(a.base,))
    _, x0, x1, y0, y1 = tile_range(bbox, a.zoom)
    n_tiles = (x1 - x0 + 1) * (y1 - y0 + 1)
    print("detail tiles:", n_tiles, file=sys.stderr)
    ns = np_ = 0
    for i, (s_, p_) in enumerate(batched_map(ex, do_detail, tiles_for(bbox, a.zoom))):
        if s_:
            raw.executemany("INSERT INTO s VALUES (?,?,?,?,?)", s_)
            ns += len(s_)
        if p_:
            raw.executemany("INSERT INTO p VALUES (?,?,?,?,?,?,?)", p_)
            np_ += len(p_)
        if i % 200000 == 0:
            raw.commit()
            print("  %d/%d tiles, %d street pieces, %d pois" % (i, n_tiles, ns, np_), file=sys.stderr, flush=True)
    raw.commit()
    ex.shutdown()

    con = sqlite3.connect(tmp)
    con.executescript("""
      CREATE TABLE places(id INTEGER PRIMARY KEY, name TEXT, kind TEXT, context TEXT, lat REAL, lon REAL, rank INTEGER,
             alt TEXT);
      -- cell = the 1-degree square (g<lat+90><lon+180>) as a search token: "near me" queries filter on
      -- it inside the index; filtering on lat/lon read every match from disk (Paris near Munich: 2.3 s on the Pi)
      CREATE VIEW places_v AS SELECT id, name, context, alt,
             printf('g%03d%03d', CAST(lat + 90 AS INTEGER), CAST(lon + 180 AS INTEGER)) AS cell FROM places;
      -- prefix index: one- to three-letter prefixes ("a", "de") took 0.6-0.9 s without it (Europe)
      CREATE VIRTUAL TABLE places_fts USING fts5(name, context, alt, cell, content='places_v', content_rowid='id',
             tokenize="unicode61 remove_diacritics 2", prefix='1 2 3');
    """)
    counts = {"places": len(places), "streets": 0, "pois": 0, "rows": 0}

    def ctx_alt(alt, town):  # alt also carries the town's spellings after "||": "Ermou Athens" matches
        t = town_alt.get(town, "")
        return alt + "||" + t if t else alt

    def rows():  # a generator: Europe has ~20 M rows, a list of them would double the memory
        for (name, kind, _, _), (lat, lon, rank, det, alt) in places.items():
            k = (det or "locality") if kind == "locality" else kind
            ctx = nearest_town(lat, lon) if k not in ("city", "town") else ""
            ctx = "" if ctx == name else ctx
            counts["rows"] += 1
            yield (name, k, ctx, lat, lon, rank, ctx_alt(alt, ctx))
        # one row per (street name, town); its size = number of pieces (tiles) it was seen in
        for name, town, lat, lon, n in raw.execute("SELECT name, town, lat, lon, COUNT(*) FROM s GROUP BY name, town"):
            counts["streets"] += 1; counts["rows"] += 1
            yield (name, "street", town, lat, lon, min(n, 10) // 2, ctx_alt(alt_names(name), town))
        for name, lat, lon, kind, town in raw.execute(
                "SELECT name, lat, lon, kind, town FROM p GROUP BY name, lat3, lon3"):
            counts["pois"] += 1; counts["rows"] += 1
            yield (name, kind or "poi", town, lat, lon, 2, ctx_alt(alt_names(name), town))
    con.executemany("INSERT INTO places(name,kind,context,lat,lon,rank,alt) VALUES (?,?,?,?,?,?,?)", rows())
    raw.close()
    os.remove(tmp + ".raw")
    con.execute("INSERT INTO places_fts(rowid,name,context,alt,cell) SELECT id,name,context,alt,cell FROM places_v")
    con.commit()
    con.execute("VACUUM")
    con.close()
    os.replace(tmp, a.out)
    print(json.dumps(counts))


if __name__ == "__main__":
    main()
