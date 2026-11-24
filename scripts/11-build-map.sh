#!/bin/bash
# Cut the offline map for REGION out of the planet map (PMTILES_SRC): the REGION_POLYGON area if set
# (regions/<name>.geojson, e.g. the Europe route graph's coverage), else REGION_BBOX.
# ~48 GB for Europe (polygon), ~8 GB for Germany (bbox).
#   bash scripts/11-build-map.sh
# Output: work/data/<REGION>/map/<REGION>.pmtiles + BUILD-INFO
. "$(dirname "$0")/common.sh"
OUT="$WORK_DIR/data/$REGION/map"; mkdir -p "$OUT" "$WORK_DIR/bin"

say "1/3 pmtiles tool v$PMTILES_VERSION"
PM="$WORK_DIR/bin/pmtiles"
if ! "$PM" version 2>/dev/null | grep -q "pmtiles $PMTILES_VERSION"; then
  case "$(uname -m)" in
    x86_64) A=x86_64; SUM=$PMTILES_SHA256_X86_64;;
    aarch64|arm64) A=arm64; SUM=$PMTILES_SHA256_ARM64;;
    *) fail "unsupported CPU $(uname -m)";;
  esac
  T="$WORK_DIR/bin/pmtiles-$A.tgz"
  [ -s "$OFFLINE_DIR/bin/pmtiles-$A.tgz" ] && cp "$OFFLINE_DIR/bin/pmtiles-$A.tgz" "$T"
  [ -s "$T" ] || curl -fsSL -o "$T" "https://github.com/protomaps/go-pmtiles/releases/download/v$PMTILES_VERSION/go-pmtiles_${PMTILES_VERSION}_Linux_$A.tar.gz"
  echo "$SUM  $T" | sha256sum -c - || fail "pmtiles download checksum wrong"
  tar xzf "$T" -C "$WORK_DIR/bin" pmtiles
fi
"$PM" version | head -1

AREA=(--bbox="$REGION_BBOX"); AREA_TXT="bbox=$REGION_BBOX"
if [ -n "${REGION_POLYGON:-}" ]; then
  case "$REGION_POLYGON" in /*) POLY=$REGION_POLYGON;; *) POLY="$ROOT/$REGION_POLYGON";; esac
  [ -s "$POLY" ] || fail "REGION_POLYGON $POLY not found"
  AREA=(--region="$POLY"); AREA_TXT="polygon=$REGION_POLYGON sha256=$(sha256sum "$POLY" | cut -d' ' -f1)"
fi
say "2/3 cut $REGION ($AREA_TXT, max zoom $MAP_MAXZOOM)"
if [ "$PMTILES_SRC" = latest ]; then   # Protomaps keeps only recent daily builds: take the newest one
  B=$(curl -fsSL --retry 3 https://build-metadata.protomaps.dev/builds.json | python3 -c 'import json,sys; print(json.load(sys.stdin)[-1]["key"])') \
    || fail "could not read the Protomaps build list"
  PMTILES_SRC="https://build.protomaps.com/$B"; echo "newest Protomaps build: $PMTILES_SRC"
fi
F="$OUT/$REGION.pmtiles"
# --overfetch=0: no merged multi-GB range requests (each is held in RAM: the Europe cut with the default
# 0.05 grew to 24 GB and was OOM-killed on a 32 GB box, 2026-11-11; each download thread holds one range).
# MAP_DOWNLOAD_THREADS (default 1): more threads = faster for a country, more RAM for a continent.
"$PM" extract "$PMTILES_SRC" "$F.part" "${AREA[@]}" --maxzoom="$MAP_MAXZOOM" --overfetch=0 --download-threads="${MAP_DOWNLOAD_THREADS:-1}"
"$PM" verify "$F.part" || fail "extracted map failed verification"
mv -f "$F.part" "$F"

say "3/3 record what was built"
{
  echo "region=$REGION bbox=$REGION_BBOX maxzoom=$MAP_MAXZOOM"
  echo "area=$AREA_TXT"
  echo "built=$(date -Is)"
  echo "source=$PMTILES_SRC"
  "$PM" show "$F" | grep -E "^(planetiler|version|max zoom|tile type)" | sed 's/^/  /'
  echo "sha256=$(sha256sum "$F" | cut -d' ' -f1)"
} | tee "$OUT/BUILD-INFO"
du -sh "$F"
