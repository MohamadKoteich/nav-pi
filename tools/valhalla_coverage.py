#!/usr/bin/env python3
"""Write the area a Valhalla graph covers as a GeoJSON MultiPolygon — stdlib only.

    valhalla_coverage.py SRC_TILE_DIR OUT.geojson [--name europe]

Uses the level-1 tiles (1 degree cells, file 1/<id split in groups of 3>.gph, id = row * 360 + col).
Cells of one row that touch are merged into one rectangle. The map cut (11-build-map.sh,
REGION_POLYGON) uses it, so the map shows exactly the area where routes can be computed.
Prints the bounding box W,S,E,N (for REGION_BBOX).
"""
import argparse
import json
import os


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("src")
    ap.add_argument("out")
    ap.add_argument("--name", default="region")
    a = ap.parse_args()
    cells = set()
    for d, _, files in os.walk(os.path.join(a.src, "1")):
        for f in files:
            if f.endswith(".gph"):
                rel = os.path.relpath(os.path.join(d, f[:-4]), os.path.join(a.src, "1"))
                cells.add(divmod(int(rel.replace(os.sep, "")), 360))
    if not cells:
        raise SystemExit("no level-1 tiles under %s/1" % a.src)
    polys = []
    for row in sorted({r for r, _ in cells}):
        cols = sorted(c for r, c in cells if r == row)
        start = prev = cols[0]
        for c in cols[1:] + [None]:
            if c is not None and c == prev + 1:
                prev = c
                continue
            w, e, s, n = start - 180, prev + 1 - 180, row - 90, row + 1 - 90
            polys.append([[[w, s], [e, s], [e, n], [w, n], [w, s]]])
            if c is not None:
                start = prev = c
    geo = {"type": "Feature", "properties": {"name": a.name, "source": "Valhalla level-1 tiles of " + a.src,
                                             "cells": len(cells)},
           "geometry": {"type": "MultiPolygon", "coordinates": polys}}
    with open(a.out, "w") as fh:
        json.dump(geo, fh, separators=(",", ":"))
    lons = [c - 180 for _, c in cells]
    lats = [r - 90 for r, _ in cells]
    print("%d,%d,%d,%d" % (min(lons), min(lats), max(lons) + 1, max(lats) + 1))


if __name__ == "__main__":
    main()
