#!/usr/bin/env python3
"""Cut a smaller imagery pack out of an MBTiles pack (same tiles, no re-encoding), like an "extract from installed
imagery". For a USB stick, a test fixture, or a Pi with little space.
    python3 tools/imagery_extract.py <src.mbtiles> <dst.mbtiles> --bounds W,S,E,N [--minzoom 5] [--maxzoom 14] [--name N]"""
import argparse
import math
import os
import sqlite3


def tile(lon, lat, z):
    return int((lon + 180) / 360 * 2 ** z), int((1 - math.asinh(math.tan(math.radians(lat))) / math.pi) / 2 * 2 ** z)


def main():
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("src")
    ap.add_argument("dst")
    ap.add_argument("--bounds", required=True)
    ap.add_argument("--minzoom", type=int, default=0)
    ap.add_argument("--maxzoom", type=int, default=24)
    ap.add_argument("--name")
    a = ap.parse_args()
    w, s, e, n = [float(v) for v in a.bounds.split(",")]
    src = sqlite3.connect("file:%s?mode=ro" % os.path.abspath(a.src), uri=True)
    meta = dict(src.execute("SELECT name, value FROM metadata"))
    zmin, zmax = max(a.minzoom, int(meta.get("minzoom", 0))), min(a.maxzoom, int(meta.get("maxzoom", 24)))
    part = a.dst + ".part"
    if os.path.exists(part):
        os.unlink(part)
    dst = sqlite3.connect(part)
    dst.executescript("CREATE TABLE metadata (name TEXT PRIMARY KEY, value TEXT);"
                      "CREATE TABLE tiles (zoom_level INTEGER, tile_column INTEGER, tile_row INTEGER, tile_data BLOB,"
                      " PRIMARY KEY (zoom_level, tile_column, tile_row));")
    count = 0
    for z in range(zmin, zmax + 1):
        x0, y0 = tile(w, n, z)
        x1, y1 = tile(e, s, z)
        rows = src.execute("SELECT zoom_level, tile_column, tile_row, tile_data FROM tiles WHERE zoom_level=? AND tile_column BETWEEN ? AND ?"
                           " AND tile_row BETWEEN ? AND ?", (z, x0, x1, 2 ** z - 1 - y1, 2 ** z - 1 - y0)).fetchall()
        dst.executemany("INSERT INTO tiles VALUES (?, ?, ?, ?)", rows)
        count += len(rows)
    meta.update(bounds="%s,%s,%s,%s" % (w, s, e, n), minzoom=str(zmin), maxzoom=str(zmax))
    meta.pop("build_signature", None)
    if a.name:
        meta["name"] = a.name
    dst.executemany("INSERT INTO metadata VALUES (?, ?)", meta.items())
    dst.commit()
    dst.close()
    os.replace(part, a.dst)
    print("%s: %d tiles, z%d-%d, %d bytes" % (a.dst, count, zmin, zmax, os.path.getsize(a.dst)))


if __name__ == "__main__":
    main()
