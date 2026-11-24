#!/bin/bash
# Build PC: pack an UPDATE BUNDLE for a Pi (map data or the app) onto a USB stick or into a folder.
#   bash scripts/30-make-update-bundle.sh map [region] <target-folder-or-stick-mount>
#   EDITION=advanced HARDWARE=50-rpi5-8gb bash scripts/30-make-update-bundle.sh app <target>
# The bundle is a folder with manifest.json (region, OSM date, size + sha256 of every file) next to the files. On the Pi:
# Settings > System > Updates finds it on the stick, or fetch it over the LAN: serve the folder from this PC
#   python3 -m http.server 8000 --directory <bundle folder>      and type  http://<this PC>:8000  once in Settings > System > Updates.
# Map bundle = work/data/<region> (map, search, valhalla; NOT the .osm.pbf); the Pi needs ~2x its size free to keep the old
# map for roll-back (Europe ~80 GB: use a replace-in-place update only if the Pi's card is too small, see docs/FEATURES.md).
. "$(dirname "$0")/common.sh"
KIND=${1:-}; M="$ROOT/tools/make_update_manifest.py"
case "$KIND" in
  map)
    if [ $# -ge 3 ]; then R=$2; T=$3; else R=$REGION; T=${2:-}; fi
    [ -n "$T" ] || fail "usage: 30-make-update-bundle.sh map [region] <target folder or stick>"
    if [ -d "$OFFLINE_DIR/data/$R" ]; then SRC="$OFFLINE_DIR/data/$R"; else SRC="$WORK_DIR/data/$R"; fi
    [ -d "$SRC" ] || fail "no data for $R in $SRC (build it with scripts/10-12 first)"
    SIZE=$(python3 "$M" size-map "$SRC" "$R") || exit 1
    OSM=$(sed -n 's/.*osmosisreplicationtime \([0-9-]*\).*/\1/p' "$SRC/map/BUILD-INFO" | head -1)
    OUT="$T/navpi-map-$R-${OSM:-$(date +%F)}" ;;
  app)
    T=${2:-}; [ -n "$T" ] || fail "usage: 30-make-update-bundle.sh app <target folder or stick>"
    ED=${EDITION:-advanced}; HW=${HARDWARE:-50-rpi5-8gb}
    python3 "$ROOT/tools/build_edition.py" --edition "$ED" --hardware "$HW" --out "$WORK_DIR/build/$ED" >/dev/null || fail "edition build refused"
    SRC="$WORK_DIR/build/$ED"; SIZE=$(python3 "$M" size-app "$SRC") || exit 1
    OUT="$T/navpi-app-$ED-$(date +%F)" ;;
  *) fail "usage: 30-make-update-bundle.sh map [region] <target> | app <target>" ;;
esac
mkdir -p "$T"
FREE=$(df -B1 --output=avail "$T" | tail -1)
[ "$FREE" -gt $((SIZE + 100000000)) ] || fail "the target has $((FREE / 1000000000)) GB free, the bundle needs $((SIZE / 1000000000)) GB"
say "packing $KIND bundle -> $OUT ($((SIZE / 1000000)) MB)"
if [ "$KIND" = map ]; then nice -n 10 python3 "$M" map "$SRC" "$R" "$OUT"; else python3 "$M" app "$SRC" "$OUT"; fi
sync
echo "done. On the Pi: Settings > System > Updates > Check (stick), or serve it:  python3 -m http.server 8000 --directory '$OUT'"
