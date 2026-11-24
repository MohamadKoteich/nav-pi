#!/bin/bash
# Driver-safety data (features/safety, PN-44/45/46): speed cameras, railway level crossings, rest areas and
# low-emission zones, read straight from an OSM .pbf by tools/build_safety.py (Python stdlib, no osmium).
# Germany (4.8 GB .pbf): 5 min with 4 processes (24 min when the build PC is busy), ~100 MB RAM per process.
#   bash scripts/13-build-safety.sh                  SAFETY_PBF=<x.osm.pbf> (default: OSM_PBF when it is a local file,
#                                                    else the extract 10-build-routing.sh downloaded)
#   SAFETY_COVERAGE=Germany                          the name the Settings page shows (default: from the file name)
# Output: work/data/<REGION>/safety/{safety.json,BUILD-INFO}; scripts/21-push-data.sh copies it.
# Coverage = the .pbf's area, not REGION: with the Germany extract only Germany has data even when REGION=europe
# (sharp curves work everywhere: they come from the route's shape).
# "Avoid low-emission zones" also needs Valhalla's exclude-polygon limit raised on the Pi: scripts/21-push-data.sh does that.
. "$(dirname "$0")/common.sh"
PBF=${SAFETY_PBF:-${OSM_PBF:-}}
# OSM_PBF a URL: use the extract scripts/10-build-routing.sh downloaded
[ -f "$PBF" ] || [ -n "${SAFETY_PBF:-}" ] || PBF="$WORK_DIR/data/$REGION/valhalla/$REGION-latest.osm.pbf"
[ -f "$PBF" ] || fail "no local .pbf: set SAFETY_PBF=<file.osm.pbf> (e.g. germany-latest.osm.pbf from download.geofabrik.de)"
NAME=$(basename "$PBF"); NAME=${NAME%%-latest*}; NAME=${NAME%%.osm.pbf*}
COVER=${SAFETY_COVERAGE:-$(echo "${NAME:0:1}" | tr '[:lower:]' '[:upper:]')${NAME:1}}
OUT="$WORK_DIR/data/$REGION/safety"; mkdir -p "$OUT"
say "safety data for $REGION from $PBF ($COVER, $BUILD_THREADS processes)"
HEAVY=(nice -n 10)
"${HEAVY[@]}" python3 "$ROOT/tools/build_safety.py" "$PBF" "$OUT/safety.json.new" --threads "$BUILD_THREADS" \
  --coverage "$COVER" | tee "$OUT/summary.json"
mv -f "$OUT/safety.json.new" "$OUT/safety.json"
{
  echo "region=$REGION built=$(date -Is)"
  echo "from=$PBF coverage=$COVER"
  echo "counts=$(cat "$OUT/summary.json")"
  echo "sha256=$(sha256sum "$OUT/safety.json" | cut -d' ' -f1)"
} | tee "$OUT/BUILD-INFO"
du -sh "$OUT/safety.json"
