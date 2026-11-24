#!/bin/bash
# Build the places-along-the-route index (PN-38: fuel, parking, toilets, rest areas) from the cut map.
#   bash scripts/13-build-along.sh        (needs scripts/11-build-map.sh first; optional part)
# Reads the .pmtiles file directly (every z15 tile); a small map through `pmtiles serve` instead. Measured on
# the build PC (6 cores, BUILD_THREADS=4): Germany 2.4 min (2026-11-23), Europe ~36 min (2026-11-12, busy PC).
# Without this file the Pi still answers, from the map tiles, for the next 60 km only.
# Output: work/data/<REGION>/along/along.sqlite + BUILD-INFO (scripts/21-push-data.sh copies it when present)
. "$(dirname "$0")/common.sh"
MAP="$WORK_DIR/data/$REGION/map/$REGION.pmtiles"
[ -s "$MAP" ] || fail "no map yet — run scripts/11-build-map.sh first"
OUT="$WORK_DIR/data/$REGION/along"; mkdir -p "$OUT"
say "along-route index for $REGION ($BUILD_THREADS processes)"
# a country-sized map is read directly; a small one keeps its z15 tiles in the pmtiles root directory, which the
# direct reader does not walk: then the tiles come from `pmtiles serve` over the region box (as 12-build-search.sh)
if python3 -c 'import sys; sys.path.insert(0, sys.argv[1]); import build_along as b; b.pm_jobs(sys.argv[2])' "$ROOT/tools" "$MAP" 2>/dev/null; then
  nice -n 10 python3 "$ROOT/tools/build_along.py" "$MAP" "$OUT/along.sqlite" --threads "$BUILD_THREADS" | tee "$OUT/summary.json"
else
  echo "small map: reading its tiles through pmtiles serve (box $REGION_BBOX)"
  [ -x "$WORK_DIR/bin/pmtiles" ] || fail "pmtiles tool missing: $WORK_DIR/bin/pmtiles (scripts/11-build-map.sh installs it)"
  PORT=18182
  "$WORK_DIR/bin/pmtiles" serve "$(dirname "$MAP")" --interface=127.0.0.1 --port=$PORT >/dev/null 2>&1 &
  PM=$!; trap 'kill $PM 2>/dev/null' EXIT
  for _ in $(seq 1 20); do curl -fs -o /dev/null "http://127.0.0.1:$PORT/$REGION/metadata" && break; sleep 0.5; done
  curl -fs -o /dev/null "http://127.0.0.1:$PORT/$REGION/metadata" || fail "pmtiles serve did not answer on port $PORT"
  nice -n 10 python3 "$ROOT/tools/build_along.py" "http://127.0.0.1:$PORT/$REGION" "$OUT/along.sqlite" \
    --bbox="$REGION_BBOX" --threads "$BUILD_THREADS" | tee "$OUT/summary.json"
fi
{
  echo "region=$REGION built=$(date -Is)"
  echo "from_map_sha256=$(sed -n 's/^sha256=//p' "$WORK_DIR/data/$REGION/map/BUILD-INFO")"
  echo "counts=$(cat "$OUT/summary.json")"
  echo "sha256=$(sha256sum "$OUT/along.sqlite" | cut -d' ' -f1)"
} | tee "$OUT/BUILD-INFO"
du -sh "$OUT/along.sqlite"
