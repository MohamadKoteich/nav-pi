#!/bin/bash
# Build the offline search index (towns, streets, POIs) from the cut map. ~15-30 min for Germany.
#   bash scripts/12-build-search.sh        (needs scripts/11-build-map.sh first)
# Output: work/data/<REGION>/search/places.sqlite + BUILD-INFO
. "$(dirname "$0")/common.sh"
MAP="$WORK_DIR/data/$REGION/map/$REGION.pmtiles"
[ -s "$MAP" ] || fail "no map yet — run scripts/11-build-map.sh first"
OUT="$WORK_DIR/data/$REGION/search"; mkdir -p "$OUT"
PORT=18181
"$WORK_DIR/bin/pmtiles" serve "$(dirname "$MAP")" --interface=127.0.0.1 --port=$PORT >/dev/null 2>&1 &
PM=$!; trap 'kill $PM 2>/dev/null' EXIT
for _ in $(seq 1 20); do curl -fs -o /dev/null "http://127.0.0.1:$PORT/$REGION/metadata" && break; sleep 0.5; done
say "indexing $REGION ($BUILD_THREADS processes)"
python3 "$ROOT/tools/build_search.py" "http://127.0.0.1:$PORT/$REGION" "$OUT/places.sqlite" \
  --bbox="$REGION_BBOX" --threads "$BUILD_THREADS" | tee "$OUT/summary.json"
{
  echo "region=$REGION built=$(date -Is)"
  echo "from_map_sha256=$(sed -n 's/^sha256=//p' "$WORK_DIR/data/$REGION/map/BUILD-INFO")"
  echo "counts=$(cat "$OUT/summary.json")"
  echo "sha256=$(sha256sum "$OUT/places.sqlite" | cut -d' ' -f1)"
} | tee "$OUT/BUILD-INFO"
du -sh "$OUT/places.sqlite"
