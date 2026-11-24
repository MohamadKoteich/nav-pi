#!/usr/bin/env python3
"""Build the places-along-the-route index (PN-38) from a Protomaps .pmtiles map — stdlib only.

    build_along.py MAP.pmtiles OUT.sqlite [--bbox W,S,E,N] [--threads 8]      (the whole map, read directly)
    build_along.py TILE_BASE_URL OUT.sqlite --bbox W,S,E,N [--threads 8]     (a box, from `pmtiles serve`)

TILE_BASE_URL is a `pmtiles serve` endpoint for the region, e.g. http://127.0.0.1:18181/europe.
The .pmtiles form walks the file's own tile directory (PMTiles v3), so only tiles that exist are read.
Reads every z15 tile (z15 = the map's max zoom: the only zoom that carries every POI, named or not — the
search index keeps only named ones) and keeps fuel, parking, toilets, rest_area and services.
Output: tables poi(id, kind, name, lat, lon) + poi_rt (R*Tree), queried by features/nav/navd_nav.py
`/api/along`. Without this file navd reads the route corridor from the tiles directly (slower, 60 km ahead).
"""
import argparse
import gzip
import json
import multiprocessing
import os
import sqlite3
import struct
import sys
import time
from concurrent.futures import ProcessPoolExecutor

sys.path.insert(0, os.path.join(os.path.dirname(os.path.abspath(__file__)), "..", "features", "nav"))
import navd_nav as N  # noqa: E402  (the tile decoder navd uses at runtime)

Z = N.ALONG_Z
ZBASE = (4 ** Z - 1) // 3   # first tile id of zoom 15
ZEND = (4 ** (Z + 1) - 1) // 3
BASE = None
PM = None   # (fd, header) in .pmtiles mode


def init_worker(base):
    global BASE, PM
    BASE = base
    if base.endswith(".pmtiles"):
        fd = os.open(base, os.O_RDONLY)
        PM = (fd, pm_header(fd))


# ---- PMTiles v3 reader (spec: github.com/protomaps/PMTiles/blob/main/spec/v3/spec.md) ----------------
def pm_header(fd):
    h = os.pread(fd, 127, 0)
    if h[:7] != b"PMTiles" or h[7] != 3:
        raise SystemExit("not a PMTiles v3 file")
    q = struct.unpack_from("<11Q", h, 8)
    return {"root": (q[0], q[1]), "leaf": q[4], "data": q[6], "icomp": h[97], "tcomp": h[98]}


def _unz(b, comp):
    return gzip.decompress(b) if comp == 2 else b


def pm_dir(fd, hd, off, ln):
    """[(tile_id, offset, length, run_length)] of one directory; run_length 0 = a leaf directory"""
    b = _unz(os.pread(fd, ln, off), hd["icomp"])
    n, i = N._varint(b, 0)
    vals = []
    for _ in range(4 * n):
        v, i = N._varint(b, i)
        vals.append(v)
    ids, runs, lens, offs = vals[:n], vals[n:2 * n], vals[2 * n:3 * n], vals[3 * n:]
    out, tid = [], 0
    for k in range(n):
        tid += ids[k]
        o = out[-1][1] + out[-1][2] if offs[k] == 0 and k > 0 else offs[k] - 1
        out.append((tid, o, lens[k], runs[k]))
    return out


def tid_xy(t, z=Z):
    """Hilbert position within zoom z -> tile x, y (as in the PMTiles reference code)"""
    n, x, y, s = 1 << z, 0, 0, 1
    while s < n:
        rx = 1 & (t // 2)
        ry = 1 & (t ^ rx)
        if ry == 0:
            if rx == 1:
                x, y = s - 1 - x, s - 1 - y
            x, y = y, x
        x += s * rx
        y += s * ry
        t //= 4
        s *= 2
    return x, y


def do_leaf(job):
    """all z15 tiles of one leaf directory (.pmtiles mode) -> [(kind, name, lat, lon)]"""
    fd, hd = PM
    off, ln = job
    out, last, data, probe = [], None, b"", []
    for tid, o, ln_, run in pm_dir(fd, hd, hd["leaf"] + off, ln):
        if run == 0 or tid + run <= ZBASE or tid >= ZEND:
            continue
        if (o, ln_) != last:   # runs of identical tiles (sea) are decoded once
            last, data = (o, ln_), _unz(os.pread(fd, ln_, hd["data"] + o), hd["tcomp"])
            probe = N.tile_pois(data, Z, 0, 0)
        if not probe:
            continue
        for t in range(max(tid, ZBASE), min(tid + run, ZEND)):
            x, y = tid_xy(t - ZBASE)
            out += N.tile_pois(data, Z, x, y)
    return out


def pm_jobs(path):
    """the leaf directories that can hold z15 tiles (the root directory points to them)"""
    fd = os.open(path, os.O_RDONLY)
    hd = pm_header(fd)
    root = pm_dir(fd, hd, *hd["root"])
    os.close(fd)
    jobs = []
    for k, (tid, o, ln, run) in enumerate(root):
        nxt = root[k + 1][0] if k + 1 < len(root) else ZEND + 1
        if run == 0 and nxt > ZBASE and tid < ZEND:
            jobs.append((o, ln))
        elif run and tid + run > ZBASE and tid < ZEND:
            raise SystemExit("z15 tiles in the root directory: a map this small: use the URL form with --bbox")
    return jobs


def do_column(job):
    """URL mode: all tiles of one column x between rows y0..y1 -> [(kind, name, lat, lon)]"""
    x, y0, y1 = job
    out = []
    for y in range(y0, y1 + 1):
        b = N.fetch_tile(BASE, Z, x, y)
        if b:
            out += N.tile_pois(b, Z, x, y)
    return out


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("base")
    ap.add_argument("out")
    ap.add_argument("--bbox", default="-180,-85,180,85")
    ap.add_argument("--threads", type=int, default=8)
    a = ap.parse_args()
    w, s, e, n = [float(v) for v in a.bbox.split(",")]
    if a.base.endswith(".pmtiles"):
        fn, jobs = do_leaf, pm_jobs(a.base)
        print("%s: %d leaf directories" % (a.base, len(jobs)), file=sys.stderr)
    else:
        x0, y0 = [int(v) for v in N._tile_xy(n, w, Z)]
        x1, y1 = [int(v) for v in N._tile_xy(s, e, Z)]
        y0, y1 = max(0, y0), min(2 ** Z - 1, y1)
        # one job = up to 256 rows of one column: big enough for keep-alive to pay off, small enough to spread
        fn, jobs = do_column, [(x, ya, min(y1, ya + 255)) for x in range(x0, x1 + 1) for ya in range(y0, y1 + 1, 256)]
        print("z%d tiles: %d (%d jobs)" % (Z, (x1 - x0 + 1) * (y1 - y0 + 1), len(jobs)), file=sys.stderr)
    tmp = a.out + ".part"
    if os.path.exists(tmp):
        os.remove(tmp)
    con = sqlite3.connect(tmp)
    con.executescript("""PRAGMA journal_mode=OFF; PRAGMA synchronous=OFF;
      CREATE TABLE poi(id INTEGER PRIMARY KEY, kind TEXT, name TEXT, lat REAL, lon REAL);
      CREATE VIRTUAL TABLE poi_rt USING rtree(id, minlat, maxlat, minlon, maxlon);""")
    counts, seen, t0 = {}, set(), time.time()
    ex = ProcessPoolExecutor(a.threads, mp_context=multiprocessing.get_context("fork"), initializer=init_worker, initargs=(a.base,))
    for i, got in enumerate(ex.map(fn, jobs, chunksize=2)):
        rows = []
        for kind, name, lat, lon in got:
            key = (kind, name, round(lat, 5), round(lon, 5))   # a POI on a tile edge comes in both tiles
            if key in seen or not (s <= lat <= n and w <= lon <= e):
                continue
            seen.add(key)
            rows.append((kind, name, lat, lon))
            counts[kind] = counts.get(kind, 0) + 1
        if rows:
            con.executemany("INSERT INTO poi(kind, name, lat, lon) VALUES (?,?,?,?)", rows)
        if i % 500 == 0:
            con.commit()
            print("  %d/%d jobs, %d pois, %.0f s" % (i, len(jobs), sum(counts.values()), time.time() - t0), file=sys.stderr, flush=True)
    ex.shutdown()
    del seen
    con.execute("INSERT INTO poi_rt SELECT id, lat, lat, lon, lon FROM poi")
    con.commit()
    con.execute("VACUUM")
    con.close()
    os.replace(tmp, a.out)
    print(json.dumps({"pois": sum(counts.values()), "kinds": counts, "seconds": round(time.time() - t0)}))


if __name__ == "__main__":
    main()
