#!/usr/bin/env python3
"""Build a satellite / aerial photo pack (MBTiles) on the build PC, with the same downloader the device uses
(features/imagery: same providers, at most 2 requests at once, resumable .part file, refused tiles retried).

    python3 tools/build_imagery.py --bounds W,S,E,N --name NAME [--level overview|standard|high]
                                   [--provider ID] [--out offline/data/imagery] [--list]

    # Munich (Bavarian DOP20 aerial photos, CC BY 4.0): zoom 13-18, ~96 000 tiles, ~1.5-3 GB; at the ~6 tiles/s
    # measured on 2026-11-23 that is about 4-5 hours:
    python3 tools/build_imagery.py --bounds 11.35,48.03,11.74,48.26 --name Munich --level high --id munich

Then: python3 tools/imagery_buildinfo.py offline/data/imagery   (21-push-data.sh / 40-make-disk.sh copy it).
Interrupted? Run the same command again: it continues where it stopped. Respect each provider's terms
(--list shows them); the device's own 250 000-tile limit does not apply here."""
import argparse
import os
import sys

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
sys.path.insert(0, os.path.join(ROOT, "features", "imagery"))


def main():
    ap = argparse.ArgumentParser(description=__doc__.split("\n\n")[0])
    ap.add_argument("--bounds", help="W,S,E,N in degrees")
    ap.add_argument("--name", default="")
    ap.add_argument("--id", help="file name without .mbtiles (default: from the name and provider)")
    ap.add_argument("--level", default="standard", choices=["overview", "standard", "high"])
    ap.add_argument("--provider", help="provider id (default: the sharpest one covering the area)")
    ap.add_argument("--out", default=os.path.join(ROOT, "offline", "data", "imagery"))
    ap.add_argument("--list", action="store_true", help="show the providers that cover --bounds and stop")
    a = ap.parse_args()
    if not a.bounds:
        ap.error("--bounds is required")
    os.makedirs(a.out, exist_ok=True)
    os.environ["NAV_IMAGERY"] = os.path.abspath(a.out)
    import navd_imagery as I        # reads NAV_IMAGERY at import
    import navd_imagery_plan as P

    b, opts = P.plan([float(v) for v in a.bounds.split(",")], a.level, I.free_bytes())
    if a.list or not opts:
        for o in opts:
            print("%-14s %-48s zoom %d-%d  %8d tiles  ~%5.0f MB" % (o["id"], o["name"][:48], o["minzoom"], o["maxzoom"],
                                                                o["tiles"], o["estimated_bytes"] / 1e6))
            print("               %s" % (o["attribution"] + ("  (NON-COMMERCIAL use only)" if o.get("nc") else "")))
        return 0 if opts else "no provider covers this area"
    o = next((x for x in opts if x["id"] == a.provider), None) if a.provider else opts[0]
    if not o:
        return "provider %s does not cover this area (try --list)" % a.provider
    name = a.name or o["name"]
    pid = a.id or I.slug(name) + "-" + o["id"]
    if os.path.exists(os.path.join(a.out, pid + ".mbtiles")):
        return "%s.mbtiles exists already" % pid
    req = {"id": pid, "name": name, "bounds": b, "level": a.level, "provider": o["id"],
           "minzoom": o["minzoom"], "maxzoom": o["maxzoom"], "tiles": o["tiles"]}
    print("%s: %s, zoom %d-%d, %d tiles, ~%.0f MB -> %s/%s.mbtiles" % (name, o["name"], o["minzoom"], o["maxzoom"],
                                                                     o["tiles"], o["estimated_bytes"] / 1e6, a.out, pid))
    import threading
    t = threading.Thread(target=I.download_job, args=(req,), daemon=True)
    I.job.update(state="running")
    t.start()
    while t.is_alive():
        t.join(5)
        j = I.job
        print("  %d / %d tiles, %.0f MB, %d refused" % (j.get("done", 0), j.get("total", 0), j.get("bytes", 0) / 1e6,
                                                       j.get("skipped", 0)), flush=True)
    if I.job.get("state") != "done":
        return "stopped: %s (run the same command again to continue)" % I.job.get("error", I.job.get("state"))
    print("done: %s/%s.mbtiles (%.0f MB). Next: python3 tools/imagery_buildinfo.py %s"
          % (a.out, pid, os.path.getsize(os.path.join(a.out, pid + ".mbtiles")) / 1e6, a.out))
    return 0


if __name__ == "__main__":
    sys.exit(main())
