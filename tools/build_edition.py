#!/usr/bin/env python3
"""Assemble one nav-pi edition for one hardware profile — only the features it contains.

    build_edition.py --edition audio [--hardware 50-rpi5-8gb | --model "Raspberry Pi 5 ..." --ram 8000]
                     [--out work/build/audio] [--force] [--list]

Output (OUT):
  app/            index.html (assembled from fragments), edition.js, <feature>/ files
  navd/           navd.py (core) + navd_<feature>.py for the included features
  edition.json    name, features, hardware profile, tuning
  packages.txt    apt packages the Pi needs;  services.txt  systemd parts to enable
"""
import argparse
import glob
import json
import os
import re
import shutil
import subprocess
import sys
import time

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
FEAT = os.path.join(ROOT, "features")
ORDER = ["basic", "audio", "advanced", "full"]


def conf(path):
    out = {}
    for line in open(path):
        m = re.match(r'^([A-Z_]+)=(.*)$', line.strip())
        if m:
            out[m.group(1)] = m.group(2).strip().strip('"')
    return out


def hardware_profiles():
    d = os.path.join(ROOT, "hardware")
    return [(f[:-5], conf(os.path.join(d, f))) for f in sorted(os.listdir(d)) if f.endswith(".conf")]


def pick_hardware(name, model, ram):
    profs = hardware_profiles()
    if name:
        for n, c in profs:
            if n == name or n.split("-", 1)[-1] == name:
                return n, c
        sys.exit("unknown hardware profile %s (have: %s)" % (name, ", ".join(n for n, _ in profs)))
    for n, c in profs:
        if re.search(c["MATCH_MODEL"], model or "") and (ram or 0) <= int(c["MAX_RAM_MB"]):
            return n, c
    return profs[-1]


def manifest(fid):
    p = os.path.join(FEAT, fid, "feature.json")
    if not os.path.exists(p):
        sys.exit("unknown feature: %s" % fid)
    return json.load(open(p))


def resolve(wanted):
    """features + their requirements, requirements first; 'idea' features are skipped"""
    out, skipped = [], []

    def add(fid, chain=()):
        if fid in out or fid in skipped:
            return
        if fid in chain:
            sys.exit("feature requirement loop: " + " -> ".join(chain + (fid,)))
        m = manifest(fid)
        if m.get("status") == "idea":
            skipped.append(fid)
            return
        for r in m.get("requires", []):
            add(r, chain + (fid,))
        out.append(fid)
    for f in wanted:
        add(f)
    return out, skipped


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--edition", default="audio")
    ap.add_argument("--hardware")
    ap.add_argument("--model", default="")
    ap.add_argument("--ram", type=int, default=0)
    ap.add_argument("--out")
    ap.add_argument("--force", action="store_true", help="allow an edition above the board's MAX_EDITION")
    ap.add_argument("--list", action="store_true")
    ap.add_argument("--check", action="store_true", help="only say whether the edition fits the board (exit 0), build nothing")
    a = ap.parse_args()

    if a.list:
        for e in ORDER:
            c = conf(os.path.join(ROOT, "editions", e + ".conf"))
            print("%-9s %-32s %s" % (e, c["NAME"], c["FEATURES"]))
        print()
        for n, c in hardware_profiles():
            print("%-14s default %-8s max %-8s zoom %s" % (n, c["DEFAULT_EDITION"], c["MAX_EDITION"], c["MAP_MAXZOOM"]))
        for f in sorted(os.listdir(FEAT)):
            m = manifest(f)
            print("feature %-11s %-8s %s" % (f, m.get("status"), m.get("name")))
        return

    hw_name, hw = pick_hardware(a.hardware, a.model, a.ram)
    edition = a.edition or hw["DEFAULT_EDITION"]
    if edition not in ORDER:
        sys.exit("unknown edition %s (have: %s)" % (edition, ", ".join(ORDER)))
    if ORDER.index(edition) > ORDER.index(hw["MAX_EDITION"]) and not a.force:
        sys.exit("edition '%s' is too big for %s (max: %s). Choose a smaller edition or pass --force."
                 % (edition, hw_name, hw["MAX_EDITION"]))
    ec = conf(os.path.join(ROOT, "editions", edition + ".conf"))
    feats, skipped = resolve(ec["FEATURES"].split())
    for f in feats:
        need = manifest(f).get("min_ram_mb", 0)
        if a.ram and a.ram < need and not a.force:
            sys.exit("feature %s needs %d MB RAM, this board has %d MB" % (f, need, a.ram))
    if a.check:
        print(hw_name, edition)
        return

    out = os.path.abspath(a.out or os.path.join(ROOT, "work", "build", edition))
    if os.path.isdir(out):
        shutil.rmtree(out)
    app, navd = os.path.join(out, "app"), os.path.join(out, "navd")
    os.makedirs(app)
    os.makedirs(navd)

    frag = {"view": [], "settings": [], "dock": []}   # the "quick" panel was removed 2026-11-22
    head_css, pre_js, js, packages, services, data = [], [], [], [], [], []
    for f in feats:
        m, src = manifest(f), os.path.join(FEAT, f)
        fr = m.get("fragments", {})
        skip = {"feature.json", "index.html"} | set(fr.values())
        dst = os.path.join(app, f)
        for name in os.listdir(src):
            if name in skip or name.startswith("navd") or name.endswith(".pyc") or name == "__pycache__":
                continue
            p = os.path.join(src, name)
            os.makedirs(dst, exist_ok=True)
            (shutil.copytree if os.path.isdir(p) else shutil.copy2)(p, os.path.join(dst, name))
        for kind, fname in fr.items():
            if kind not in frag:
                sys.exit("feature %s: unknown fragment kind %r (have: %s)" % (f, kind, ", ".join(frag)))
            frag[kind].append(open(os.path.join(src, fname)).read().rstrip() + "\n")
        ap_ = m.get("app", {})
        head_css += ["%s/%s" % (f, x) for x in ap_.get("head_css", []) + ap_.get("css", [])]
        pre_js += ["%s/%s" % (f, x) for x in ap_.get("pre_js", [])]
        js += ["%s/%s" % (f, x) for x in ap_.get("js", [])]
        mod = os.path.join(src, "navd_%s.py" % f)
        if os.path.exists(mod):
            shutil.copy2(mod, navd)
            for extra in sorted(glob.glob(os.path.join(src, "navd_%s_*.py" % f))):   # helper modules of the feature
                shutil.copy2(extra, navd)
        packages += m.get("pi", {}).get("packages", [])
        services += m.get("pi", {}).get("services", [])
        data += m.get("data", [])
    shutil.copy2(os.path.join(FEAT, "core", "navd.py"), navd)

    tuning = {"pixelRatio": float(hw["MAP_PIXEL_RATIO"]), "maxPitch": int(hw["MAP_MAX_PITCH"]),
              "mapMaxZoom": int(hw["MAP_MAXZOOM"]), "valhallaThreads": int(hw["VALHALLA_THREADS"])}
    try:
        rev = subprocess.run(["git", "-C", ROOT, "describe", "--always", "--dirty"], capture_output=True, text=True).stdout.strip()
    except OSError:
        rev = ""
    ed = {"edition": edition, "name": ec["NAME"], "features": feats, "skipped": skipped,
          "hardware": hw_name, "tuning": tuning, "built": time.strftime("%Y-%m-%dT%H:%M:%S"), "source": rev,
          "status": {f: manifest(f).get("status") for f in feats}}
    json.dump(ed, open(os.path.join(out, "edition.json"), "w"), indent=2)
    shutil.copy2(os.path.join(out, "edition.json"), navd)
    open(os.path.join(app, "edition.js"), "w").write("window.EDITION = %s;\n" % json.dumps(ed))

    tpl = open(os.path.join(FEAT, "core", "index.html")).read()
    scripts = ["edition.js"] + pre_js + js
    rep = {
        "<!--@CSS-->": "\n".join('<link rel="stylesheet" href="%s">' % c for c in head_css),
        "<!--@VIEWS-->": "".join(frag["view"]).rstrip(),
        "<!--@SETTINGS-->": "".join(frag["settings"]).rstrip(),
        "<!--@DOCK-->": "".join(frag["dock"]).rstrip(),
        "<!--@SCRIPTS-->": "\n".join('<script src="%s"></script>' % s for s in scripts),
    }
    for k, v in rep.items():
        if k not in tpl:
            sys.exit("template marker missing: " + k)
        tpl = tpl.replace(k, v)
    open(os.path.join(app, "index.html"), "w").write(tpl)
    open(os.path.join(out, "packages.txt"), "w").write("\n".join(sorted(set(packages))) + "\n")
    open(os.path.join(out, "services.txt"), "w").write("\n".join(dict.fromkeys(services)) + "\n")
    open(os.path.join(out, "data.txt"), "w").write("\n".join(dict.fromkeys(data)) + "\n")
    size = sum(os.path.getsize(os.path.join(d, f)) for d, _, fs in os.walk(out) for f in fs)
    print("edition %s (%s) for %s: %s%s — %d KB -> %s" % (
        edition, ec["NAME"], hw_name, " ".join(feats),
        (" (skipped, not built yet: %s)" % " ".join(skipped)) if skipped else "", size // 1024, out))


if __name__ == "__main__":
    main()
