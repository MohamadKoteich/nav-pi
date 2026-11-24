#!/usr/bin/env python3
"""Write BUILD-INFO for the imagery packs in a folder (the kit's offline/data/imagery): one block of
<file>.<key>=value lines per *.mbtiles (sha256, size, name, bounds, zooms, format, attribution, source).
scripts/21-push-data.sh checks every pack's sha256 on the Pi against it; 40-make-disk.sh checks it before a disk.
    python3 tools/imagery_buildinfo.py <folder> [--source FILE=TEXT ...]   (a source text already in BUILD-INFO is kept)"""
import argparse
import hashlib
import os
import re
import sqlite3


def sha256(path):
    h = hashlib.sha256()
    with open(path, "rb") as f:
        for chunk in iter(lambda: f.read(8 << 20), b""):
            h.update(chunk)
    return h.hexdigest()


def main():
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("folder")
    ap.add_argument("--source", action="append", default=[], help="FILE=TEXT where the pack came from")
    a = ap.parse_args()
    info = os.path.join(a.folder, "BUILD-INFO")
    old = {}
    if os.path.exists(info):
        for line in open(info, encoding="utf-8"):
            if "=" in line and not line.startswith("#"):
                k, v = line.rstrip("\n").split("=", 1)
                old[k] = v
    sources = dict(s.split("=", 1) for s in a.source)
    out = ["# imagery packs for /srv/navdata/imagery (tools/imagery_buildinfo.py): <file>.<key>=value"]
    for f in sorted(os.listdir(a.folder)):
        if not f.endswith(".mbtiles") or f.startswith("."):
            continue
        p = os.path.join(a.folder, f)
        db = sqlite3.connect("file:%s?mode=ro" % os.path.abspath(p), uri=True)
        m = dict(db.execute("SELECT name, value FROM metadata"))
        db.close()
        attribution = re.sub(r"<[^>]+>", "", m.get("attribution", "")).strip()
        rows = [("sha256", sha256(p)), ("size", os.path.getsize(p)), ("name", m.get("name", f)), ("bounds", m.get("bounds", "")),
                ("minzoom", m.get("minzoom", "")), ("maxzoom", m.get("maxzoom", "")), ("format", m.get("format", "")),
                ("attribution", attribution), ("description", m.get("description", "")),
                ("source", sources.get(f, old.get(f + ".source", "")))]
        out += ["%s.%s=%s" % (f, k, v) for k, v in rows]
        print("%s: %s" % (f, rows[0][1]))
    with open(info + ".new", "w", encoding="utf-8") as fh:
        fh.write("\n".join(out) + "\n")
    os.replace(info + ".new", info)


if __name__ == "__main__":
    main()
