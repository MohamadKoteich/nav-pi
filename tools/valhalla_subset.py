#!/usr/bin/env python3
"""Cut a region out of an existing Valhalla tile directory (e.g. a Europe graph) — stdlib only.

    valhalla_subset.py SRC_TILE_DIR OUT.tar --bbox W,S,E,N [--margin 0.5]

Valhalla stores its graph as fixed lat/lon tiles: level 0 = 4°, level 1 = 1°, level 2 = 0.25°
(file  <level>/<id split in groups of 3>.gph, id = row * (360/size) + col). Every tile that overlaps
the box (plus margin) is written, unchanged, into an uncompressed tar that valhalla_service can
memory-map. Routes stay correct inside the box; they end at the margin outside it.
"""
import argparse
import os
import sys
import tarfile

SIZES = {0: 4.0, 1: 1.0, 2: 0.25}


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("src")
    ap.add_argument("out")
    ap.add_argument("--bbox", required=True)
    ap.add_argument("--margin", type=float, default=0.5)
    a = ap.parse_args()
    w, s, e, n = [float(v) for v in a.bbox.split(",")]
    w, s, e, n = w - a.margin, s - a.margin, e + a.margin, n + a.margin
    picked, total, size = [], 0, 0
    for level, ts in SIZES.items():
        base = os.path.join(a.src, str(level))
        ncols = int(round(360 / ts))
        for d, _, files in os.walk(base):
            for f in files:
                if not f.endswith(".gph"):
                    continue
                total += 1
                rel = os.path.relpath(os.path.join(d, f), a.src)
                tid = int("".join(rel[:-4].split(os.sep)[1:]))
                row, col = divmod(tid, ncols)
                lon0, lat0 = -180 + col * ts, -90 + row * ts
                if lon0 < e and lon0 + ts > w and lat0 < n and lat0 + ts > s:
                    picked.append(rel)
                    size += os.path.getsize(os.path.join(a.src, rel))
    if not picked:
        sys.exit("no tiles in that box")
    tmp = a.out + ".part"
    with tarfile.open(tmp, "w", format=tarfile.USTAR_FORMAT) as t:
        for rel in sorted(picked):
            t.add(os.path.join(a.src, rel), arcname=rel)
    os.replace(tmp, a.out)
    print("tiles: %d of %d (%.1f GB) -> %s" % (len(picked), total, size / 1e9, a.out))


if __name__ == "__main__":
    main()
