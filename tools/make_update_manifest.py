#!/usr/bin/env python3
"""Pack a nav-pi update bundle: copy the files into <out> and write <out>/manifest.json (size + sha256 per file).
Used by scripts/30-make-update-bundle.sh (build PC); the Pi side is features/system/navd_system_updates.py.
  make_update_manifest.py map <region-dir> <region> <out>     region-dir = work/data/<region> (map/ search/ valhalla/)
  make_update_manifest.py app <build-dir> <out>               build-dir = work/build/<edition> (app/ navd/ edition.json)
  make_update_manifest.py size-map <region-dir> <region> | size-app <build-dir>     bundle size in bytes
Never writes into a non-empty <out>. The hashes are taken from the COPY, so a bad stick is caught here."""
import hashlib, json, os, re, shutil, sys, time  # noqa: E401

MAP_FILES = ["map/{r}.pmtiles", "map/BUILD-INFO", "search/places.sqlite", "search/BUILD-INFO", "valhalla/valhalla_tiles.tar",
             "valhalla/valhalla.json", "valhalla/BUILD-INFO", "valhalla/admin_data/admins.sqlite", "valhalla/timezone_data/timezones.sqlite"]
MAP_REQUIRED = ("map/{r}.pmtiles", "map/BUILD-INFO", "search/places.sqlite", "valhalla/valhalla_tiles.tar", "valhalla/valhalla.json")


def sha(path):
    h = hashlib.sha256()
    with open(path, "rb") as f:
        for b in iter(lambda: f.read(4 << 20), b""):
            h.update(b)
    return h.hexdigest()


def walk(root, sub):
    for d, dirs, fs in os.walk(os.path.join(root, sub)):
        dirs[:] = [x for x in dirs if x != "__pycache__"]
        for f in sorted(fs):
            if not f.endswith(".pyc"):
                yield os.path.relpath(os.path.join(d, f), root).replace(os.sep, "/")


def plan_map(src, region):
    miss = [m.format(r=region) for m in MAP_REQUIRED if not os.path.isfile(os.path.join(src, m.format(r=region)))]
    if miss:
        raise SystemExit("not a finished build, missing: " + ", ".join(miss))
    files = [m.format(r=region) for m in MAP_FILES if os.path.isfile(os.path.join(src, m.format(r=region)))]
    kv = open(os.path.join(src, "map", "BUILD-INFO")).read()
    m = re.search(r"osmosisreplicationtime (\S+)", kv)
    b = re.search(r"built=(\S+)", kv)
    return files, {"kind": "map", "region": region, "osm": (m.group(1) if m else "")[:10], "built": b.group(1)[:19] if b else ""}


def plan_app(src):
    files = ["edition.json"] + list(walk(src, "app")) + list(walk(src, "navd"))
    if len(files) < 4 or not all(os.path.isfile(os.path.join(src, f)) for f in files):
        raise SystemExit("not a build folder (run tools/build_edition.py first)")
    ed = json.load(open(os.path.join(src, "edition.json")))
    return files, {"kind": "app", "edition": ed.get("name", ""), "hardware": ed.get("hardware", ""), "built": (ed.get("built") or "")[:19],
                   "source": ed.get("source", "")}


def size_of(src, files):
    return sum(os.path.getsize(os.path.join(src, f)) for f in files)


def pack(src, files, meta, out):
    if os.path.isdir(out) and os.listdir(out):
        raise SystemExit("target not empty: " + out)
    entries = []
    for f in files:
        dst = os.path.join(out, *f.split("/"))
        os.makedirs(os.path.dirname(dst), exist_ok=True)
        shutil.copyfile(os.path.join(src, f), dst)
        entries.append({"path": f, "size": os.path.getsize(dst), "sha256": sha(dst)})
    m = {"navpi_update": 1, **meta, "created": time.strftime("%Y-%m-%dT%H:%M:%S"), "total": sum(e["size"] for e in entries), "files": entries}
    json.dump(m, open(os.path.join(out, "manifest.json"), "w"), indent=1)
    return m


def main(a):
    if len(a) == 4 and a[0] == "map":
        files, meta = plan_map(a[1], a[2])
        src, out = a[1], a[3]
    elif len(a) == 3 and a[0] == "app":
        files, meta = plan_app(a[1])
        src, out = a[1], a[2]
    elif len(a) == 3 and a[0] == "size-map":
        print(size_of(a[1], plan_map(a[1], a[2])[0]))
        return
    elif len(a) == 2 and a[0] == "size-app":
        print(size_of(a[1], plan_app(a[1])[0]))
        return
    else:
        raise SystemExit(__doc__)
    m = pack(src, files, meta, out)
    print("bundle: %s  %.2f GB  %d files" % (out, m["total"] / 1e9, len(m["files"])))


if __name__ == "__main__":
    main(sys.argv[1:])
