#!/usr/bin/env python3
"""Build the driver-safety data file (features/safety) from an OSM .pbf — Python stdlib only, no osmium.

    python3 tools/build_safety.py <in.osm.pbf> <out.json> [--threads N] [--bbox W,S,E,N]

Extracts (OSM tags):
  cameras    highway=speed_camera nodes                        -> [lat, lon, maxspeed km/h or 0]
  crossings  railway=level_crossing nodes (road x rail)        -> [lat, lon]
  rest       highway=rest_area | highway=services (node or area, first node of the area)
                                                               -> [lat, lon, kind 0=rest area 1=services, name]
  lez        boundary=low_emission_zone (closed way or multipolygon relation; lorry-only zones left out)
                                                               -> {name, sticker, bbox, rings: [[[lon, lat], ...]], holes,
                                                                   avoid: rings simplified to ~200 m for Valhalla exclude_polygons}
  counts of hazard=school_zone / hazard=children nodes (school zones are NOT built: see docs/FEATURES.md)

Streaming PBF reader: three passes over the file, each blob decoded in a worker process.
  pass 1  every blob: tagged nodes, LEZ / rest-area ways (+ their node refs), LEZ relations (+ member ways);
          the first id of each node / way blob is noted (blobs are sorted by type then id).
  pass 2  only the way blobs that hold an LEZ relation's member ways -> their node refs
  pass 3  only the node blobs that hold a needed node id -> coordinates
"""
import argparse
import json
import os
import struct
import sys
import time
import zlib
from multiprocessing import Pool

WANT_VALS = {b"speed_camera", b"level_crossing", b"low_emission_zone", b"rest_area", b"services", b"school_zone", b"children"}
QUICK = (b"speed_camera", b"level_crossing", b"low_emission_zone", b"rest_area", b"services", b"school_zone", b"children")


# ---------- protobuf, the minimum ----------
def varint(b, i):
    r = sh = 0
    while True:
        c = b[i]; i += 1
        r |= (c & 0x7f) << sh
        if c < 0x80:
            return r, i
        sh += 7


def fields(b):
    """(field number, value) of one message: int for varints, bytes slices for length-delimited"""
    i, n = 0, len(b)
    while i < n:
        k, i = varint(b, i)
        f, w = k >> 3, k & 7
        if w == 0:
            v, i = varint(b, i)
        elif w == 2:
            ln, i = varint(b, i)
            v = b[i:i + ln]; i += ln
        elif w == 1:
            v = b[i:i + 8]; i += 8
        elif w == 5:
            v = b[i:i + 4]; i += 4
        else:
            raise ValueError("wire type %d" % w)
        yield f, v


def packed(b):
    out, i, n = [], 0, len(b)
    ap = out.append
    while i < n:
        r = sh = 0
        while True:
            c = b[i]; i += 1
            r |= (c & 0x7f) << sh
            if c < 0x80:
                break
            sh += 7
        ap(r)
    return out


def zz(v):
    return (v >> 1) ^ -(v & 1)


def delta(vals):
    out, acc = [], 0
    for v in vals:
        acc += (v >> 1) ^ -(v & 1)
        out.append(acc)
    return out


# ---------- file level ----------
def header_date(path):
    """osmosis_replication_timestamp of the OSMHeader (YYYY-MM-DD), '' when the file has none"""
    with open(path, "rb") as f:
        hl = struct.unpack(">I", f.read(4))[0]
        hdr = dict(fields(f.read(hl)))
        if hdr.get(1) != b"OSMHeader":
            return ""
        data = read_raw(f.read(hdr[3]))
    ts = dict(fields(data)).get(32)
    return time.strftime("%Y-%m-%d", time.gmtime(ts)) if ts else ""


def read_raw(b):
    blob = dict(fields(b))
    if 1 in blob:
        return bytes(blob[1])
    if 3 in blob:
        return zlib.decompress(blob[3])
    raise ValueError("unsupported blob compression (only raw / zlib)")


def blobs(path):
    """(offset, size) of every OSMData blob"""
    out = []
    with open(path, "rb") as f:
        while True:
            h = f.read(4)
            if len(h) < 4:
                break
            hl = struct.unpack(">I", h)[0]
            hdr = dict(fields(f.read(hl)))
            size = hdr[3]
            if hdr[1] == b"OSMData":
                out.append((f.tell(), size))
            f.seek(size, 1)
    return out


def read_block(path, off, size):
    with open(path, "rb") as f:
        f.seek(off)
        return read_raw(f.read(size))


def block_parts(data):
    st, groups, gran, lato, lono = [], [], 100, 0, 0
    for f, v in fields(data):
        if f == 1:
            st = [s for ff, s in fields(v) if ff == 1]
        elif f == 2:
            groups.append(v)
        elif f == 17:
            gran = v
        elif f == 19:
            lato = v - (1 << 64) if v >= 1 << 63 else v   # int64 (not zigzag)
        elif f == 20:
            lono = v - (1 << 64) if v >= 1 << 63 else v
    return st, groups, gran, lato, lono


def coord(raw, gran, off):
    return round((off + gran * raw) * 1e-9, 6)


def tags_of(keys, vals, st):
    return {bytes(st[k]).decode("utf-8", "replace"): bytes(st[v]).decode("utf-8", "replace") for k, v in zip(keys, vals)}


def interesting(t):
    return (t.get("highway") in ("speed_camera", "rest_area", "services") or t.get("railway") == "level_crossing"
            or t.get("boundary") == "low_emission_zone" or t.get("hazard") in ("school_zone", "children"))


# ---------- pass 1 ----------
def scan(job):
    path, off, size = job
    data = read_block(path, off, size)
    st, groups, gran, lato, lono = block_parts(data)
    res = {"kind": None, "first": None, "nodes": [], "ways": [], "rels": []}
    hit = any(q in data for q in QUICK)
    want = {i for i, s in enumerate(st) if bytes(s) in WANT_VALS} if hit else set()
    for g in groups:
        for f, v in fields(g):
            if f in (1, 2):
                res["kind"] = "node"
                if f == 2:
                    d = dict(fields(v))
                    if res["first"] is None and 1 in d:
                        res["first"] = zz(varint(d[1], 0)[0])
                    if not want or 10 not in d:
                        continue
                    kv = packed(d[10])
                    if not any(x in want for x in kv):
                        continue
                    ids, lats, lons = delta(packed(d[1])), delta(packed(d[8])), delta(packed(d[9]))
                    n = j = 0
                    while j < len(kv) and n < len(ids):
                        ks, vs = [], []
                        while kv[j] != 0:
                            ks.append(kv[j]); vs.append(kv[j + 1]); j += 2
                        j += 1
                        if any(x in want for x in vs):
                            t = tags_of(ks, vs, st)
                            if interesting(t):
                                res["nodes"].append((ids[n], coord(lats[n], gran, lato),
                                                     coord(lons[n], gran, lono), t))
                        n += 1
                else:   # plain Node
                    d = {}
                    for ff, vv in fields(v):
                        d[ff] = vv
                    if res["first"] is None:
                        res["first"] = zz(d.get(1, 0))
                    if want and 2 in d:
                        t = tags_of(packed(d[2]), packed(d[3]), st)
                        if interesting(t):
                            res["nodes"].append((zz(d[1]), coord(zz(d[8]), gran, lato),
                                                 coord(zz(d[9]), gran, lono), t))
            elif f == 3:
                res["kind"] = "way"
                if res["first"] is None or want:
                    d = {}
                    for ff, vv in fields(v):
                        d[ff] = vv
                    if res["first"] is None:
                        res["first"] = d.get(1, 0)
                    if want and 2 in d and any(x in want for x in packed(d[3])):
                        t = tags_of(packed(d[2]), packed(d[3]), st)
                        if interesting(t):
                            res["ways"].append((d[1], delta(packed(d.get(8, b""))), t))
                elif not want:
                    break
            elif f == 4:
                res["kind"] = "rel"
                if not want:
                    break
                d = {}
                for ff, vv in fields(v):
                    d[ff] = vv
                if 2 in d and any(x in want for x in packed(d[3])):
                    t = tags_of(packed(d[2]), packed(d[3]), st)
                    if t.get("boundary") == "low_emission_zone":
                        roles = [bytes(st[r]).decode() for r in packed(d.get(8, b""))]
                        mem = delta(packed(d.get(9, b"")))
                        types = packed(d.get(10, b""))
                        res["rels"].append((d[1], [(m, r) for m, r, ty in zip(mem, roles, types) if ty == 1], t))
            else:
                continue
    return res


# ---------- pass 2: way refs ----------
def way_refs(job):
    path, off, size, want = job
    data = read_block(path, off, size)
    st, groups, *_ = block_parts(data)
    out = {}
    for g in groups:
        for f, v in fields(g):
            if f == 3:
                d = {}
                for ff, vv in fields(v):
                    d[ff] = vv
                if d.get(1) in want:
                    out[d[1]] = delta(packed(d.get(8, b"")))
    return out


# ---------- pass 3: node coordinates ----------
def node_coords(job):
    path, off, size, want = job
    data = read_block(path, off, size)
    st, groups, gran, lato, lono = block_parts(data)
    out = {}
    for g in groups:
        for f, v in fields(g):
            if f == 2:
                d = dict(fields(v))
                ids = delta(packed(d[1]))
                idx = [k for k, x in enumerate(ids) if x in want]
                if not idx:
                    continue
                lats, lons = delta(packed(d[8])), delta(packed(d[9]))
                for k in idx:
                    out[ids[k]] = (coord(lats[k] , gran, lato), coord(lons[k] , gran, lono))
            elif f == 1:
                d = dict(fields(v))
                i = zz(d.get(1, 0))
                if i in want:
                    out[i] = (coord(zz(d[8]) , gran, lato), coord(zz(d[9]) , gran, lono))
    return out


# ---------- geometry ----------
def rings_from_ways(ways):
    """join way node lists into closed rings (by shared end nodes); open leftovers are dropped"""
    rings, open_ = [], [list(w) for w in ways if len(w) >= 2]
    while open_:
        cur = open_.pop()
        changed = True
        while cur[0] != cur[-1] and changed:
            changed = False
            for k, w in enumerate(open_):
                if w[0] == cur[-1]:
                    cur += w[1:]
                elif w[-1] == cur[-1]:
                    cur += w[::-1][1:]
                elif w[-1] == cur[0]:
                    cur = w[:-1] + cur
                elif w[0] == cur[0]:
                    cur = w[::-1][:-1] + cur
                else:
                    continue
                open_.pop(k); changed = True
                break
        if cur[0] == cur[-1] and len(cur) >= 4:
            rings.append(cur)
    return rings


def simplify(pts, tol_m=15.0):
    """Douglas-Peucker in local metres; pts = [[lon, lat], ...] closed ring"""
    import math
    if len(pts) < 5:
        return pts
    lat0 = math.radians(sum(p[1] for p in pts) / len(pts))
    kx, ky = 111320 * math.cos(lat0), 110540
    xy = [(p[0] * kx, p[1] * ky) for p in pts]
    keep = [False] * len(pts)
    keep[0] = keep[-1] = True
    stack = [(0, len(pts) - 1)]
    while stack:
        a, b = stack.pop()
        ax, ay = xy[a]; bx, by = xy[b]
        dx, dy = bx - ax, by - ay
        L = math.hypot(dx, dy) or 1e-9
        best, bi = -1, -1
        for i in range(a + 1, b):
            px, py = xy[i]
            d = abs(dy * (px - ax) - dx * (py - ay)) / L if (dx or dy) else math.hypot(px - ax, py - ay)
            if d > best:
                best, bi = d, i
        if best > tol_m:
            keep[bi] = True
            stack += [(a, bi), (bi, b)]
    out = [p for p, k in zip(pts, keep) if k]
    return out if len(out) >= 4 else pts


def perimeter(ring):
    import math
    s = 0
    for a, b in zip(ring, ring[1:]):
        s += math.hypot((b[0] - a[0]) * 111320 * math.cos(math.radians(a[1])), (b[1] - a[1]) * 110540)
    return s


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("pbf")
    ap.add_argument("out")
    ap.add_argument("--threads", type=int, default=4)
    ap.add_argument("--bbox", default="")
    ap.add_argument("--cache", default="", help="pickle of the extracted raw data: written once, then reused (development)")
    ap.add_argument("--coverage", default="", help="area name for the Settings page, e.g. Germany")
    a = ap.parse_args()
    t0 = time.time()
    if a.cache and os.path.exists(a.cache):
        import pickle
        nodes, ways, rels, have, xy = pickle.load(open(a.cache, "rb"))
    else:
        nodes, ways, rels, have, xy = passes(a, t0)
        if a.cache:
            import pickle
            pickle.dump((nodes, ways, rels, have, xy), open(a.cache, "wb"))
    output(a, t0, nodes, ways, rels, have, xy)


def passes(a, t0):
    bl = blobs(a.pbf)
    print("blobs: %d" % len(bl), file=sys.stderr, flush=True)
    nodes, ways, rels = [], [], []
    node_first, way_first = [], []   # (first id, blob index)
    with Pool(a.threads) as pool:
        for k, r in enumerate(pool.imap(scan, [(a.pbf, o, s) for o, s in bl], chunksize=8)):
            if r["kind"] == "node" and r["first"] is not None:
                node_first.append((r["first"], k))
            elif r["kind"] == "way" and r["first"] is not None:
                way_first.append((r["first"], k))
            nodes += r["nodes"]; ways += r["ways"]; rels += r["rels"]
            if k % 5000 == 0:
                print("pass 1: %d/%d blobs, %d s" % (k, len(bl), time.time() - t0), file=sys.stderr, flush=True)
        print("pass 1 done: %d nodes, %d ways, %d relations, %d s" % (len(nodes), len(ways), len(rels), time.time() - t0), file=sys.stderr, flush=True)

        def blob_of(first, i):   # blob that holds id i (blobs sorted by id)
            lo, hi, best = 0, len(first) - 1, None
            while lo <= hi:
                m = (lo + hi) // 2
                if first[m][0] <= i:
                    best = first[m][1]; lo = m + 1
                else:
                    hi = m - 1
            return best

        # pass 2: member ways of LEZ relations
        need_w = {m for _, mem, _ in rels for m, _ in mem}
        have = {w[0]: w[1] for w in ways}
        need_w -= set(have)
        jobs = {}
        for wid in need_w:
            b = blob_of(way_first, wid)
            if b is not None:
                jobs.setdefault(b, set()).add(wid)
        for r in pool.imap_unordered(way_refs, [(a.pbf, bl[b][0], bl[b][1], ids) for b, ids in jobs.items()]):
            have.update(r)
        print("pass 2 done: %d member ways from %d blobs, %d s" % (len(need_w), len(jobs), time.time() - t0), file=sys.stderr, flush=True)

        # pass 3: node coordinates of the LEZ ways + the first node of rest areas
        need_n = set()
        for _, mem, _ in rels:
            for m, _ in mem:
                need_n.update(have.get(m, []))
        for wid, refs, t in ways:
            if t.get("boundary") == "low_emission_zone":
                need_n.update(refs)
            elif refs:
                need_n.add(refs[0])
        jobs = {}
        for nid in need_n:
            b = blob_of(node_first, nid)
            if b is not None:
                jobs.setdefault(b, set()).add(nid)
        xy = {}
        for r in pool.imap_unordered(node_coords, [(a.pbf, bl[b][0], bl[b][1], ids) for b, ids in jobs.items()]):
            xy.update(r)
        print("pass 3 done: %d/%d nodes from %d blobs, %d s" % (len(xy), len(need_n), len(jobs), time.time() - t0), file=sys.stderr, flush=True)
    return nodes, ways, rels, have, xy


def output(a, t0, nodes, ways, rels, have, xy):
    bbox = [float(v) for v in a.bbox.split(",")] if a.bbox else None
    inb = (lambda lat, lon: bbox[0] <= lon <= bbox[2] and bbox[1] <= lat <= bbox[3]) if bbox else (lambda lat, lon: True)
    out = {"version": 1, "built": time.strftime("%Y-%m-%dT%H:%M:%S%z"), "source": os.path.basename(a.pbf),
           "coverage": a.coverage, "osm_date": header_date(a.pbf),
           "cameras": [], "crossings": [], "rest": [], "lez": [], "counts": {}}
    school = 0
    for nid, lat, lon, t in nodes:
        if not inb(lat, lon):
            continue
        if t.get("highway") == "speed_camera":
            ms = t.get("maxspeed", "")
            out["cameras"].append([lat, lon, int(ms) if ms.isdigit() else 0])
        elif t.get("railway") == "level_crossing":
            out["crossings"].append([lat, lon])
        elif t.get("highway") in ("rest_area", "services"):
            out["rest"].append([lat, lon, 0 if t["highway"] == "rest_area" else 1, t.get("name", "")])
        if t.get("hazard") in ("school_zone", "children"):
            school += 1
    for wid, refs, t in ways:
        if t.get("highway") in ("rest_area", "services") and refs and refs[0] in xy:
            lat, lon = xy[refs[0]]
            if inb(lat, lon):
                out["rest"].append([lat, lon, 0 if t["highway"] == "rest_area" else 1, t.get("name", "")])

    def sticker(name, t):
        """the German sticker a zone needs, from access=<colour>_sticker_germany; else green for an "Umweltzone …" or an
        unnamed zone (the zones that carry the tag all say green); "other" = a named zone with other rules (e.g. a French ZFE)"""
        for c in ("green", "yellow", "red"):
            if c + "_sticker_germany" in t.get("access", ""):
                return c
        return "other" if name and not name.lower().startswith("umweltzone") else "green"

    def zone(name, t, outer, inner):
        def ring(ids):
            pts = [[xy[i][1], xy[i][0]] for i in ids if i in xy]
            return simplify(pts) if len(pts) >= 4 else None
        rs = [r for r in (ring(x) for x in outer) if r]
        hs = [r for r in (ring(x) for x in inner) if r]
        if not rs:
            return
        lons = [p[0] for r in rs for p in r]; lats = [p[1] for r in rs for p in r]
        if bbox and not (min(lons) <= bbox[2] and max(lons) >= bbox[0] and min(lats) <= bbox[3] and max(lats) >= bbox[1]):
            return
        keep = {k: t[k] for k in ("start_date", "end_date", "opening_hours", "low_emission_zone", "zone:traffic",
                                    "website", "ref", "description") if k in t}
        keep.update({k: v for k, v in t.items() if k.startswith(("low_emission_zone:", "sticker", "environmental"))})
        out["lez"].append({"name": name, "sticker": sticker(name, t), "bbox": [min(lons), min(lats), max(lons), max(lats)], "rings": rs, "holes": hs,
                           "avoid": [simplify(r, 200.0) for r in rs],
                           "perimeter_m": round(sum(perimeter(r) for r in rs)), "tags": keep})
    def car_zone(t):   # lorry-only bans and mistagged roads are not zones for a car
        return not ("highway" in t or t.get("low_emission_zone") == "hgv" or "hgv" in t or "lkw" in t.get("name", "").lower())
    members = {m for _, mem, _ in rels for m, _ in mem}
    for wid, refs, t in ways:
        if t.get("boundary") == "low_emission_zone" and refs and refs[0] == refs[-1] and wid not in members and car_zone(t):
            zone(t.get("name") or t.get("description", ""), t, [refs], [])
    for rid, mem, t in rels:
        if not car_zone(t):
            continue
        outer = rings_from_ways([have[m] for m, r in mem if r != "inner" and m in have])
        inner = rings_from_ways([have[m] for m, r in mem if r == "inner" and m in have])
        zone(t.get("name", ""), t, outer, inner)
    out["counts"] = {"cameras": len(out["cameras"]), "crossings": len(out["crossings"]), "rest": len(out["rest"]),
                     "lez": len(out["lez"]), "school_zone_or_children_hazard_nodes": school}
    tmp = a.out + ".tmp"
    with open(tmp, "w") as f:
        json.dump(out, f, separators=(",", ":"), ensure_ascii=False)
    os.replace(tmp, a.out)
    print(json.dumps(out["counts"]))
    print("done in %d s" % (time.time() - t0), file=sys.stderr)


if __name__ == "__main__":
    main()
