#!/bin/bash
# Copy the built offline data to the Pi and verify it there.
#   bash scripts/21-push-data.sh [host]
# Copies work/data/<REGION>/{map,search,valhalla} (+ safety when built) to /srv/navdata/<REGION>/ (resumable rsync),
# then checks each file's sha256 on the Pi against BUILD-INFO. Only finished builds are copied.
# When map, search and routing of REGION are all verified, the Pi is switched to it:
# /srv/navdata/current -> REGION (tiles, routing and navd read that link), services restarted.
# Other regions stay on the card until you delete them (ls /srv/navdata).
# Also copies the satellite/aerial packs of offline/data/imagery to /srv/navdata/imagery/ (sha256-checked, optional).
. "$(dirname "$0")/common.sh"
HOST=${1:-$PI_HOSTNAME.local}
# prebuilt data from the offline bundle if it has this region, else your own builds in work/data
if [ -d "$OFFLINE_DIR/data/$REGION" ]; then SRC="$OFFLINE_DIR/data/$REGION"; else SRC="$WORK_DIR/data/$REGION"; fi
[ -d "$OFFLINE_DIR/data/fonts" ] && [ -z "${FONTS_DIR:-}" ] && FONTS_DIR="$OFFLINE_DIR/data/fonts"
DST="/srv/navdata/$REGION"; echo "data from $SRC"
SSH=(ssh -o StrictHostKeyChecking=accept-new -o ConnectTimeout=5 -o BatchMode=yes "$PI_USER@$HOST")
ssh_ok "${SSH[@]}" || fail "no SSH to $HOST"

DONE_PARTS=0
copy() {  # part main-file sha-key [more files, relative to the part dir]
  local part=$1 file=$2 key=$3; shift 3
  [ -s "$SRC/$part/BUILD-INFO" ] || { echo "$part: not built yet — skipped"; return 0; }
  local need; need=$(du -sb "$SRC/$part/$file" | cut -f1)
  local have; have=$("${SSH[@]}" "f='$DST/$part/$file'; s=\$(stat -c %s \"\$f\" 2>/dev/null || echo 0); echo \$(( \$(df -B1 --output=avail /srv/navdata | tail -1) + s ))")
  [ "$have" -gt "$need" ] || fail "$part: the Pi has $((have / 1000000000)) GB free, needs $((need / 1000000000)) GB — delete an old region first (ls /srv/navdata)"
  local want; want=$(sed -n "s/^$key=//p" "$SRC/$part/BUILD-INFO")
  say "$part: copying $(du -sh "$SRC/$part/$file" | cut -f1)"
  "${SSH[@]}" "mkdir -p '$DST/$part'"
  local rel=() f; for f in "$file" BUILD-INFO "$@"; do [ -e "$SRC/$part/$f" ] && rel+=("$SRC/$part/./$f"); done
  rsync -aR --partial --info=progress2 -e "ssh -o BatchMode=yes" "${rel[@]}" "$PI_USER@$HOST:$DST/$part/"
  local got; got=$("${SSH[@]}" "sha256sum '$DST/$part/$file' | cut -d' ' -f1")
  [ "$got" = "$want" ] || fail "$part: checksum on the Pi differs ($got vs $want) — run again"
  echo "$part: verified on the Pi ($want)"
  DONE_PARTS=$((DONE_PARTS + 1))
}
copy map "$REGION.pmtiles" sha256
copy search places.sqlite sha256
P=$DONE_PARTS; copy along along.sqlite sha256; DONE_PARTS=$P   # PN-38 optional: not needed to switch the region
if [ -n "${FONTS_DIR:-}" ] && [ -d "$FONTS_DIR/Noto Sans Regular" ]; then
  say "fonts"
  rsync -a -e "ssh -o BatchMode=yes" "$FONTS_DIR/Noto Sans Regular" "$PI_USER@$HOST:/srv/navdata/fonts/"
  echo "fonts: copied"
else
  echo "fonts: FONTS_DIR not set — map labels will be missing (see config.env.example)"
fi
VOICE_SRC="$OFFLINE_DIR/data/voice"; [ -d "$VOICE_SRC" ] || VOICE_SRC="$WORK_DIR/data/voice"
if [ -f "$VOICE_SRC/manifest.json" ]; then   # recorded navigation phrases (tools/build_voicepack.py)
  say "voice pack"
  rsync -a --delete -e "ssh -o BatchMode=yes" "$VOICE_SRC/" "$PI_USER@$HOST:/srv/navdata/voice/"
  echo "voice: copied ($(du -sh "$VOICE_SRC" | cut -f1))"
fi
# driver-safety data (scripts/13-build-safety.sh, features/safety): optional, not one of the parts the switch needs
SAFE_SRC="$SRC"; [ -s "$SRC/safety/BUILD-INFO" ] || SAFE_SRC="$WORK_DIR/data/$REGION"
if [ -s "$SAFE_SRC/safety/BUILD-INFO" ]; then
  MAIN_SRC=$SRC; SRC=$SAFE_SRC; copy safety safety.json sha256; SRC=$MAIN_SRC; DONE_PARTS=$((DONE_PARTS - 1))
else echo "safety: not built yet (scripts/13-build-safety.sh) — skipped"; fi
# satellite / aerial photo packs (features/imagery): optional, not tied to a region -> /srv/navdata/imagery/<name>.mbtiles
# (kit: offline/data/imagery + BUILD-INFO from tools/imagery_buildinfo.py). Copied under a hidden name, sha256 checked on
# the Pi, then renamed: navd never sees half a pack. A pack already there with the same sha256 is not copied again.
IMG_SRC="$OFFLINE_DIR/data/imagery"; [ -s "$IMG_SRC/BUILD-INFO" ] || IMG_SRC="$WORK_DIR/data/imagery"
if [ -s "$IMG_SRC/BUILD-INFO" ]; then
  "${SSH[@]}" "mkdir -p /srv/navdata/imagery"
  for f in "$IMG_SRC"/*.mbtiles; do
    [ -e "$f" ] || continue
    n=$(basename "$f"); D=/srv/navdata/imagery
    want=$(sed -n "s/^${n//./\\.}\.sha256=//p" "$IMG_SRC/BUILD-INFO")
    [ -n "$want" ] || { echo "imagery $n: not in BUILD-INFO (python3 tools/imagery_buildinfo.py $IMG_SRC) — skipped"; continue; }
    if [ "$("${SSH[@]}" "sha256sum '$D/$n' 2>/dev/null | cut -d' ' -f1")" = "$want" ]; then echo "imagery $n: already on the Pi"; continue; fi
    need=$(stat -c %s "$f"); have=$("${SSH[@]}" "df -B1 --output=avail /srv/navdata | tail -1")
    [ "$have" -gt $((need + 2147483648)) ] || { echo "imagery $n: the Pi has $((have / 1000000000)) GB free, needs $((need / 1000000000)) GB + 2 GB — skipped"; continue; }
    say "imagery $n: copying $(du -sh "$f" | cut -f1)"
    rsync -a --partial --info=progress2 -e "ssh -o BatchMode=yes" "$f" "$PI_USER@$HOST:$D/.$n.push"
    got=$("${SSH[@]}" "sha256sum '$D/.$n.push' | cut -d' ' -f1")
    [ "$got" = "$want" ] || fail "imagery $n: checksum on the Pi differs ($got vs $want) — run again"
    "${SSH[@]}" "mv -f '$D/.$n.push' '$D/$n'"
    echo "imagery $n: verified on the Pi ($want)"
  done
else echo "imagery: no packs in the kit (offline/data/imagery) — skipped"; fi
copy valhalla valhalla_tiles.tar tar_sha256 valhalla.json admin_data/admins.sqlite timezone_data/timezones.sqlite
# "Avoid low-emission zones" (features/safety) sends zone outlines as Valhalla exclude_polygons: raise Valhalla's
# 10 km outline limit in the Pi's copy of valhalla.json (the copy above restores the default each time) and restart routing
if [ -s "$SAFE_SRC/safety/BUILD-INFO" ] && "${SSH[@]}" "test -f '$DST/valhalla/valhalla.json'"; then
  "${SSH[@]}" "python3 -c 'import json,sys; p=sys.argv[1]; c=json.load(open(p)); s=c.setdefault(\"service_limits\",{})
if s.get(\"max_exclude_polygons_length\",10000)<2000000: s[\"max_exclude_polygons_length\"]=2000000; json.dump(c,open(p,\"w\"),indent=2); print(\"raised\")' '$DST/valhalla/valhalla.json'" \
    | grep -q raised && { echo "valhalla.json: exclude-polygon limit raised"
      [ "$("${SSH[@]}" "basename \$(readlink -f /srv/navdata/current)")" = "$REGION" ] && "${SSH[@]}" "sudo systemctl restart nav-pi-valhalla" || true; }
fi
if [ "$DONE_PARTS" = 3 ]; then
  say "switch the Pi to $REGION"
  "${SSH[@]}" "old=\$(readlink /srv/navdata/current || true); ln -sfn '$REGION' /srv/navdata/current.new && mv -T /srv/navdata/current.new /srv/navdata/current
    # restart even when the region stays the same: the services keep the old files open until then (refreshed data)
    for s in nav-pi-tiles nav-pi-valhalla nav-pi; do systemctl cat \$s 2>/dev/null | grep -q /srv/navdata/current && sudo systemctl restart \$s; done
    if [ \"\$old\" != '$REGION' ]; then echo \"switched from \${old:-nothing} to $REGION\"
    else echo 'already on $REGION: services restarted, they now serve the pushed files'; fi
    systemctl cat nav-pi-tiles 2>/dev/null | grep -q /srv/navdata/current || echo 'NOTE: the services on the Pi still name a fixed region — run scripts/20-setup-pi.sh once'"
else
  echo "not switched: only $DONE_PARTS of map/search/routing are verified for $REGION"
fi
"${SSH[@]}" "df -h /srv/navdata | tail -1; ls -la /srv/navdata/ '$DST'/*/"
