#!/bin/bash
# Offline route graph (Valhalla) for REGION, two ways:
#  a) ROUTING_FROM_TILES=<valhalla_tiles dir of a bigger graph> (e.g. a Europe graph you already have):
#     cut the region's tiles out — 30 s, no build. Uses the graph's own Valhalla version.
#     ROUTING_WHOLE_GRAPH=1: take the whole graph — copies its valhalla_tiles.tar (Europe: 34 GB, ~5 min).
#  b) otherwise build from OSM_PBF. Heavy: ~16 GB RAM; Germany took 3 h 37 min (2026-11-23, BUILD_THREADS=4,
#     download included), Upper Bavaria ~15 min.
#   bash scripts/10-build-routing.sh
#   bash scripts/10-build-routing.sh --refresh   (or REFRESH=1) download OSM_PBF again: a downloaded extract is
#                                                otherwise kept and reused, so the roads stay at its date
# Output: work/data/<REGION>/valhalla/{valhalla_tiles.tar,valhalla.json,...} + BUILD-INFO
. "$(dirname "$0")/common.sh"
REFRESH=${REFRESH:-0}
case "${1:-}" in --refresh) REFRESH=1;; "") ;; *) fail "unknown option $1 (only --refresh)";; esac
need docker "https://docs.docker.com/engine/install/ — your user must be in the docker group"
OUT="$WORK_DIR/data/$REGION/valhalla"; mkdir -p "$OUT"

if [ -n "${ROUTING_FROM_TILES:-}" ]; then
  [ -d "$ROUTING_FROM_TILES/2" ] || fail "ROUTING_FROM_TILES must be a valhalla_tiles dir (with 0/ 1/ 2/)"
  SRC_TAR="$(dirname "$ROUTING_FROM_TILES")/valhalla_tiles.tar"
  if [ "${ROUTING_WHOLE_GRAPH:-0}" = 1 ]; then
    [ -s "$SRC_TAR" ] || fail "ROUTING_WHOLE_GRAPH=1 needs $SRC_TAR next to the tiles dir"
    N_DIR=$(find "$ROUTING_FROM_TILES" -name '*.gph' | wc -l); N_TAR=$(tar tf "$SRC_TAR" | grep -c '\.gph$')
    [ "$N_DIR" = "$N_TAR" ] || fail "$SRC_TAR has $N_TAR tiles, the tiles dir $N_DIR — the graph is being rebuilt?"
    say "whole graph: copy $SRC_TAR ($(du -h "$SRC_TAR" | cut -f1), $N_TAR tiles)"
    cp --reflink=auto "$SRC_TAR" "$OUT/valhalla_tiles.tar.part" && mv -f "$OUT/valhalla_tiles.tar.part" "$OUT/valhalla_tiles.tar"
  else
    say "cut $REGION out of $ROUTING_FROM_TILES"
    python3 "$ROOT/tools/valhalla_subset.py" "$ROUTING_FROM_TILES" "$OUT/valhalla_tiles.tar" --bbox="$REGION_BBOX"
  fi
  CFG="$(dirname "$ROUTING_FROM_TILES")/valhalla.json"
  [ -f "$CFG" ] && cp "$CFG" "$OUT/valhalla.json" || docker run --rm --entrypoint valhalla_build_config "$VALHALLA_IMAGE" \
    --mjolnir-tile-dir /custom_files/valhalla_tiles --mjolnir-tile-extract /custom_files/valhalla_tiles.tar > "$OUT/valhalla.json"
  {
    echo "region=$REGION"
    echo "built=$(date -Is)"
    echo "image=$VALHALLA_IMAGE"
    if [ "${ROUTING_WHOLE_GRAPH:-0}" = 1 ]; then echo "whole_graph=$SRC_TAR"; else echo "cut_from=$ROUTING_FROM_TILES"; fi
    echo "graph_built=$(stat -c %y "$ROUTING_FROM_TILES" | cut -d' ' -f1)"
    echo "tar_sha256=$(sha256sum "$OUT/valhalla_tiles.tar" | cut -d' ' -f1)"
  } | tee "$OUT/BUILD-INFO"
  exit 0
fi

say "1/3 OpenStreetMap extract"
PBF="$OUT/$REGION-latest.osm.pbf"
case "$OSM_PBF" in
  http*://*) if [ ! -s "$PBF" ] || [ "$REFRESH" = 1 ]; then
               curl -fL --retry 3 -o "$PBF.part" "$OSM_PBF" || fail "download of $OSM_PBF failed"
               mv -f "$PBF.part" "$PBF"
             else
               echo "reusing the extract downloaded $(stat -c %y "$PBF" | cut -d' ' -f1) — for newer roads: bash $0 --refresh"
             fi;;
  *)         [ -s "$OSM_PBF" ] || fail "OSM_PBF file $OSM_PBF not found"
             ln -f "$OSM_PBF" "$PBF" 2>/dev/null || cp -f "$OSM_PBF" "$PBF";;
esac
ls -l "$PBF"

say "2/3 graph build with $VALHALLA_IMAGE ($BUILD_THREADS threads)"
docker pull -q "$VALHALLA_IMAGE" >/dev/null || docker image inspect "$VALHALLA_IMAGE" >/dev/null || fail "cannot get $VALHALLA_IMAGE"
chmod 0777 "$OUT"
docker run --rm --name "nav-pi-valhalla-build-$REGION" \
  -v "$OUT:/custom_files" \
  -e tile_urls= -e use_tiles_ignore_pbf=False -e force_rebuild=True \
  -e build_admins=True -e build_time_zones=True -e build_elevation=False \
  -e build_tar=True -e serve_tiles=False -e server_threads="$BUILD_THREADS" \
  "$VALHALLA_IMAGE"
# the container writes as root: give the files back to you, so they can be moved or deleted without sudo
docker run --rm --user 0 --entrypoint chown -v "$OUT:/custom_files" "$VALHALLA_IMAGE" -R "$(id -u):$(id -g)" /custom_files \
  || echo "note: could not change the owner of the files in $OUT"
[ -s "$OUT/valhalla_tiles.tar" ] || fail "build finished without valhalla_tiles.tar — see output above"

say "3/3 record what was built"
{
  echo "region=$REGION"
  echo "built=$(date -Is)"
  echo "image=$VALHALLA_IMAGE"
  echo "pbf=$(basename "$OSM_PBF") $(stat -c '%s bytes, modified %y' "$PBF")"
  echo "tar_sha256=$(sha256sum "$OUT/valhalla_tiles.tar" | cut -d' ' -f1)"
} | tee "$OUT/BUILD-INFO"
du -sh "$OUT/valhalla_tiles.tar"
