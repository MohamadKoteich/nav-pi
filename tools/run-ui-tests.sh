#!/bin/bash
# Run the browser UI tests (tools/ui-*.mjs) against region data built on this PC — the same stack as on the Pi:
# pmtiles serve (map), Valhalla in Docker (routing, same pinned image), navd (the app's backend) — with fake system
# tools, so nothing on this PC is changed (no Wi-Fi, systemd, USB, backlight or GPS is touched). Then cleans up.
#   bash tools/run-ui-tests.sh                 all tests
#   bash tools/run-ui-tests.sh routes trip     some tests (names = tools/ui-<name>.mjs)
#   bash tools/run-ui-tests.sh --list
# Settings: the region of config.env / NAVPI_CONFIG (data in work/data/<region>, built by scripts 11/12/10, plus 13-* for
# along/safety). The map/route tests use fixed places in and around Munich: the small oberbayern preset is enough
# (germany or europe work too); on a region that does not cover Munich they are skipped (SKIP, not FAIL).
# Env: PLAYWRIGHT_DIR (path of node_modules/playwright; default: require("playwright")), SIZE (default 1280x720),
#      OUT (screenshots, default work/ui-shots), KEEP=1 (keep the temp folder for a look afterwards).
. "$(dirname "$0")/../scripts/common.sh"
ALL=(layout-guard routes places maptap lanes along safety speedlimit theme media trip wifi keyboard usb updates imagery gps dashboard)
[ "${1:-}" = --list ] && { printf '%s\n' "${ALL[@]}"; exit 0; }
TESTS=("$@"); [ "${#TESTS[@]}" -gt 0 ] || TESTS=("${ALL[@]}")
SIZE=${SIZE:-1280x720}; OUT=${OUT:-$WORK_DIR/ui-shots}; mkdir -p "$OUT"
need node "Node.js 20+"; need docker "https://docs.docker.com/engine/install/"
node -e 'require(process.env.PLAYWRIGHT_DIR || "playwright")' 2>/dev/null \
  || fail "Playwright not found: npm install playwright && npx playwright install chromium (or set PLAYWRIGHT_DIR)"
R="$WORK_DIR/data/$REGION"
for p in map/$REGION.pmtiles search/places.sqlite valhalla/valhalla_tiles.tar valhalla/valhalla.json; do
  [ -s "$R/$p" ] || fail "region $REGION has no $p — build it first (scripts/11, 12, 10)"; done
[ -d "$OFFLINE_DIR/data/fonts/Noto Sans Regular" ] || fail "fonts missing — bash scripts/00-get-bundle.sh fonts"

T=$(mktemp -d /tmp/navpi-ui.XXXXXX); PIDS=(); VAL=navpi-ui-valhalla-$$
cleanup() {
  for p in "${PIDS[@]}"; do kill "$p" 2>/dev/null; done
  docker rm -f "$VAL" >/dev/null 2>&1
  if [ "${KEEP:-}" = 1 ]; then echo "kept $T"; else rm -rf "$T"; fi
}
trap cleanup EXIT
cd "$ROOT" || exit 1

say "editions (advanced, audio, basic)"
for e in advanced audio basic; do python3 tools/build_edition.py --edition "$e" --force --out "$T/build-$e" >/dev/null; done

# a data folder like the Pi's /srv/navdata; the region data is linked read-only, everything the tests write lands in $T
navdata() {   # navdata <dir>
  mkdir -p "$1/imagery"; ln -sfn "$R" "$1/$REGION"; ln -sfn "$REGION" "$1/current"
  ln -sfn "$OFFLINE_DIR/data/fonts" "$1/fonts"
  [ -s "$OFFLINE_DIR/data/imagery/munich.mbtiles" ] && ln -sfn "$OFFLINE_DIR/data/imagery/munich.mbtiles" "$1/imagery/munich.mbtiles"
  return 0
}

say "map tiles + routing for $REGION"
"$WORK_DIR/bin/pmtiles" serve "$R/map" --interface=127.0.0.1 --port=18081 >"$T/pmtiles.log" 2>&1 & PIDS+=($!)
# Valhalla as on the Pi after 21-push-data.sh: the exclude-polygon limit raised (low-emission zones)
python3 - "$R/valhalla/valhalla.json" "$T/valhalla.json" <<'PY'
import json, sys
c = json.load(open(sys.argv[1])); s = c.setdefault("service_limits", {})
s["max_exclude_polygons_length"] = max(s.get("max_exclude_polygons_length", 10000), 2000000)
json.dump(c, open(sys.argv[2], "w"), indent=1)
PY
docker run --rm -d --name "$VAL" -p 127.0.0.1:18002:8002 -v "$R/valhalla:/custom_files:ro" -v "$T/valhalla.json:/cfg/valhalla.json:ro" \
  --entrypoint valhalla_service "$VALHALLA_IMAGE" /cfg/valhalla.json 2 >/dev/null || fail "Valhalla did not start"
for _ in $(seq 1 60); do curl -fs -o /dev/null http://127.0.0.1:18002/status && break; sleep 1; done
curl -fs -o /dev/null http://127.0.0.1:18002/status || fail "Valhalla does not answer"

# navd <port> <edition> <data dir> [VAR=value ...] — starts navd with fake system tools, waits until it answers
navd() {
  local port=$1 ed=$2 data=$3; shift 3
  mkdir -p "$T/state-$port"
  env APP_DIR="$T/build-$ed/app" EDITION_FILE="$T/build-$ed/edition.json" NAV_DATA="$data" NAV_PORT="$port" \
    NAV_STATE_DIR="$T/state-$port" NMCLI="$ROOT/tests/fake-nmcli" FAKE_NM_STATE="$T/nm-$port.json" \
    NAV_SYSTEMCTL="$ROOT/tests/fake-systemctl" FAKE_SYSTEMCTL_LOG="$T/systemctl-$port.log" \
    LSBLK="$ROOT/tests/fake-lsblk" UDISKSCTL="$ROOT/tests/fake-udisksctl" FAKE_USB_STATE="$T/usb-$port.json" \
    BACKLIGHT_DIR="$T/no-backlight" GPSD_PORT="${GPSD_PORT_FOR_NAVD:-1}" NAV_REBOOT_FILE="$T/no-reboot" \
    TILES_URL=http://127.0.0.1:18081 VALHALLA_URL=http://127.0.0.1:18002\
    "$@" python3 "$T/build-$ed/navd/navd.py" >"$T/navd-$port.log" 2>&1 &
  for _ in $(seq 1 40); do curl -fs -o /dev/null "http://127.0.0.1:$port/api/status" && return 0; sleep 0.25; done
  cat "$T/navd-$port.log"; fail "navd on port $port did not start"
}

NEXT_PORT=18100
free_port() {   # the next port (from NEXT_PORT on) that nothing listens on, with the one after it free too
  while ss -ltn | awk '{print $4}' | grep -qE ":($NEXT_PORT|$((NEXT_PORT + 1)))\$"; do NEXT_PORT=$((NEXT_PORT + 2)); done
  echo "$NEXT_PORT"
}

# the map/route tests drive fixed routes around Munich (Marienplatz, Ingolstadt, Berchtesgaden, Dachau): the region must cover them
MUNICH_TESTS=" layout-guard routes places maptap lanes along safety speedlimit trip gps dashboard "
covers_munich() {
  python3 - "${REGION_BBOX:-}" <<'PY'
import sys
try:
    w, s, e, n = map(float, sys.argv[1].split(","))
except ValueError:
    sys.exit(0)   # no box given: assume it does
sys.exit(0 if w <= 11.4 and s <= 47.6 and e >= 13.1 and n >= 48.8 else 1)   # Munich .. Ingolstadt .. Berchtesgaden
PY
}

run_test() {   # run_test <name> <port>  -> 0 pass, 1 fail, 2 skipped
  local n=$1 port=$2 d="$T/data-$1"; mkdir -p "$d"
  if [[ "$MUNICH_TESTS" == *" $n "* ]] && ! covers_munich; then
    echo "SKIP $n: region $REGION ($REGION_BBOX) does not cover the Munich test routes — use REGION=oberbayern or germany"; return 2
  fi
  echo '{"sticks":[],"mounted":{}}' > "$T/usb-$port.json"
  case "$n" in
    media)   # a short two-chapter audiobook and one song (silent WAV), as if copied with scripts/23-push-media.sh
      navdata "$d"
      python3 - "$d/media" <<'PY'
import os, sys, wave
def wav(path, seconds):
    os.makedirs(os.path.dirname(path), exist_ok=True)
    with wave.open(path, "wb") as w:
        w.setnchannels(1); w.setsampwidth(2); w.setframerate(8000); w.writeframes(b"\0\0" * 8000 * seconds)
wav(sys.argv[1] + "/Audiobooks/Test Book/01 Chapter one.wav", 40)
wav(sys.argv[1] + "/Audiobooks/Test Book/02 Chapter two.wav", 40)
wav(sys.argv[1] + "/Music/Test Album/01 Song.wav", 20)
for d in ("Podcasts",): os.makedirs(sys.argv[1] + "/" + d, exist_ok=True)
PY
      navd "$port" advanced "$d"; node tools/ui-media.mjs "http://127.0.0.1:$port" "$OUT" "$SIZE";;
    wifi|keyboard)
      navdata "$d"; navd "$port" advanced "$d"; node "tools/ui-$n.mjs" "http://127.0.0.1:$port" "$OUT" "$SIZE";;
    trip)
      navdata "$d"; mkdir -p "$T/media-$port/STICK"
      navd "$port" advanced "$d" NAV_TRIP_SIM=1 TRIP_END_IDLE=8 TRIP_MEDIA="$T/media-$port"
      node tools/ui-trip.mjs "http://127.0.0.1:$port" "$OUT" "$SIZE";;
    usb)
      mkdir -p "$T/stick-$port"; navdata "$d"
      navd "$port" advanced "$d" USB_POLL=1
      FAKE_USB_STATE="$T/usb-$port.json" NAV_DATA="$d" STICK="$T/stick-$port" node tools/ui-usb.mjs "http://127.0.0.1:$port" "$OUT" "$SIZE";;
    updates)
      local U="$T/upd-$port"; mkdir -p "$U/data" "$U/stick" "$U/state"
      UPD_T="$U" node tools/ui-updates.mjs --fixtures >/dev/null || return 1
      navd "$port" audio "$U/data" NAV_UPDATE_DIRS="$U/stick" NAV_STATE_DIR="$U/state" FAKE_SYSTEMCTL_LOG="$U/sysctl.log" NAV_UPDATE_RESERVE=1000
      UPD_T="$U" node tools/ui-updates.mjs "http://127.0.0.1:$port" "$OUT" "$SIZE";;
    imagery)
      [ -s "$OFFLINE_DIR/data/imagery/munich.mbtiles" ] || { echo "SKIP imagery: no offline/data/imagery/munich.mbtiles (tools/build_imagery.py)"; return 2; }
      navdata "$d"; mkdir -p "$T/stick-$port"
      python3 tools/imagery_extract.py "$OFFLINE_DIR/data/imagery/munich.mbtiles" "$T/stick-$port/marienplatz.mbtiles" \
        --bounds 11.56,48.13,11.59,48.145 --maxzoom 16 --name "Marienplatz (USB)" >/dev/null
      printf '{"sticks":[{"disk":"/dev/sdb","tran":"usb","parts":[{"dev":"/dev/sdb1","fstype":"vfat","label":"PHOTOS","uuid":"CCCC-DDDD","size":32000000000,"dir":"%s"}]}],"mounted":{}}' \
        "$T/stick-$port" > "$T/usb-$port.json"
      navd "$port" audio "$d" USB_POLL=1 IMAGERY_FAKE_FETCH=0.01
      node tools/ui-imagery.mjs "http://127.0.0.1:$port" "$OUT" "$SIZE";;
    gps)
      local gp; gp=$(python3 -c '
import socket
for p in range(29400, 29900, 2):   # two free ports in a row: gpsd + its control port
    try:
        a = socket.socket(); a.bind(("127.0.0.1", p)); b = socket.socket(); b.bind(("127.0.0.1", p + 1))
        a.close(); b.close(); print(p); break
    except OSError:
        pass')
      navdata "$d"   # tools/ui-gps.mjs starts the fake gpsd itself on these ports
      GPSD_PORT_FOR_NAVD=$gp navd "$port" advanced "$d"
      GPSD_PORT=$gp GPSD_CTL=$((gp + 1)) node tools/ui-gps.mjs "http://127.0.0.1:$port" "$OUT" "$SIZE";;
    dashboard)
      local d2="$T/data-dash-basic"; mkdir -p "$d2"; navdata "$d"; navdata "$d2"
      navd "$port" audio "$d"; navd $((port + 1)) basic "$d2"
      node tools/ui-dashboard.mjs "http://127.0.0.1:$port" "http://127.0.0.1:$((port + 1))" "$OUT";;
    layout-guard)
      navdata "$d"; navd "$port" advanced "$d"; node tools/ui-layout-guard.mjs "http://127.0.0.1:$port" "$OUT";;
    *)
      [ -f "tools/ui-$n.mjs" ] || { echo "unknown test $n (bash $0 --list)"; return 1; }
      navdata "$d"; navd "$port" advanced "$d"; node "tools/ui-$n.mjs" "http://127.0.0.1:$port" "$OUT" "$SIZE";;
  esac
}

declare -A RES
for n in "${TESTS[@]}"; do
  say "ui-$n"
  # each test in its own subshell: its navd (and fake gpsd) end with it, a failure never stops the whole run
  port=$(free_port); NEXT_PORT=$((port + 2))
  rc=0; ( trap 'kill $(jobs -p) 2>/dev/null' EXIT; run_test "$n" "$port" ) > "$T/ui-$n.log" 2>&1 || rc=$?
  tail -n 3 "$T/ui-$n.log" | cut -c1-200
  case $rc in 0) RES[$n]=PASS;; 2) RES[$n]=SKIP;; *) RES[$n]=FAIL; grep -E '^FAIL' "$T/ui-$n.log" | head -n 15 || true; cp "$T/ui-$n.log" "$OUT/ui-$n.log";; esac
done

echo; echo "=== UI tests on $REGION at $SIZE"
fails=0
for n in "${TESTS[@]}"; do printf '%-13s %s\n' "$n" "${RES[$n]}"; [ "${RES[$n]}" = FAIL ] && fails=$((fails + 1)); done
echo "screenshots: $OUT"
[ "$fails" = 0 ] || { echo "$fails test(s) failed (logs in $OUT)"; exit 1; }
