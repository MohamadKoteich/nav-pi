#!/bin/bash
# Build a SELF-CONTAINED disk image: plug the disk (USB SSD or a big card) into a Raspberry Pi 4 or 5
# and it sets itself up on the first boot with NO PC and NO internet, then starts the navigator.
#   bash scripts/40-make-disk.sh                 (no root needed; region = REGION from config.env)
#   sudo bash scripts/41-write-disk.sh /dev/sdX  (writes it + reads it back)
# The disk carries: Raspberry Pi OS (official image + nav-pi first boot), the region data (map, routing,
# search, places along the route, safety), fonts, voice, and the kit (code, all Pi packages, the Valhalla
# image, pmtiles). First boot (pi/firstboot.sh -> pi/setup-local.sh): grows the partitions, installs the
# packages from the disk, picks the edition for the board's model + RAM, starts the kiosk. ~15 min.
# Overrides: DISK_DIR (default ./disk), DISK_HOSTNAME (default PI_HOSTNAME), ROOT_GIB (64).
. "$(dirname "$0")/common.sh"
need_offline
need /usr/sbin/mke2fs "sudo apt install e2fsprogs"
DISK_DIR=${DISK_DIR:-$ROOT/disk}
HOSTN=${DISK_HOSTNAME:-$PI_HOSTNAME}
SRC="$OFFLINE_DIR/data/$REGION"; [ -d "$SRC" ] || SRC="$WORK_DIR/data/$REGION"   # kit data, else what 10/11/12 built
[ -d "$SRC/map" ] && [ -d "$SRC/valhalla" ] && [ -d "$SRC/search" ] || fail "region $REGION not complete in $SRC"
[ -z "$(git -C "$ROOT" status --porcelain -- features pi tools editions hardware scripts)" ] \
  || fail "uncommitted code changes — commit first (the disk carries the committed kit, git HEAD)"
mkdir -p "$DISK_DIR"
STAGE="$DISK_DIR/stage"; rm -rf "$STAGE"; mkdir -p "$STAGE"

say "1/4 boot + OS image (hostname $HOSTN, no root-partition auto-resize: the data partition follows it)"
BASE="$WORK_DIR/$(basename "${PIOS_URL%.xz}")"
[ -f "$BASE" ] || { bash "$ROOT/scripts/01-build-image.sh" | tail -n 5; }   # unpacks the base image once
pc_venv
"$VENV/bin/python" - "$BASE" "$DISK_DIR/cmdline.txt" <<'PY' || fail "could not read cmdline.txt from $BASE"
import sys, struct, tempfile, os, warnings
warnings.filterwarnings("ignore")
from pyfatfs.PyFatFS import PyFatFS
img, out = sys.argv[1:]
mbr = open(img, "rb").read(512); start, count = struct.unpack("<II", mbr[454:462])
with open(img, "rb") as f:
    f.seek(start * 512); fat = f.read(count * 512)
t = tempfile.NamedTemporaryFile(delete=False); t.write(fat); t.close()
fs = PyFatFS(t.name); s = fs.readtext("/cmdline.txt"); fs.close(); os.unlink(t.name)
# the official first boot grows partition 2 to the end of the disk ("resize"); here partition 3 (data) follows
open(out, "w").write(s.replace(" resize", ""))
PY
grep -q ' resize' "$DISK_DIR/cmdline.txt" && fail "cmdline.txt still has resize"
grep -q 'root=' "$DISK_DIR/cmdline.txt" || fail "cmdline.txt looks wrong: $(cat "$DISK_DIR/cmdline.txt")"
IMG_OUT="$DISK_DIR/boot-root.img" PI_HOSTNAME="$HOSTN" EXTRA_FAT="/cmdline.txt=$DISK_DIR/cmdline.txt" \
  bash "$ROOT/scripts/01-build-image.sh" | tail -2

say "2/4 data partition contents ($REGION)"
R="$STAGE/$REGION"; mkdir -p "$R"
for part in map search along safety; do
  [ -d "$SRC/$part" ] && cp -al "$SRC/$part" "$R/$part"
done
# only what the Pi reads (as 21-push-data.sh copies): not the .osm.pbf or the loose valhalla_tiles/ (doubled the disk)
mkdir -p "$R/valhalla"
for f in valhalla_tiles.tar BUILD-INFO valhalla.json admin_data/admins.sqlite timezone_data/timezones.sqlite; do
  [ -e "$SRC/valhalla/$f" ] || continue
  mkdir -p "$R/valhalla/$(dirname "$f")"; cp -al "$SRC/valhalla/$f" "$R/valhalla/$f"
done
# "Avoid low-emission zones" sends zone outlines to Valhalla: raise its 10 km outline limit (a real copy, not a link)
rm "$R/valhalla/valhalla.json"; cp "$SRC/valhalla/valhalla.json" "$R/valhalla/valhalla.json"
python3 - "$R/valhalla/valhalla.json" <<'PY'
import json, sys
p = sys.argv[1]; c = json.load(open(p)); s = c.setdefault("service_limits", {})
s["max_exclude_polygons_length"] = max(s.get("max_exclude_polygons_length", 10000), 2000000)
json.dump(c, open(p, "w"), indent=2)
PY
ln -s "$REGION" "$STAGE/current"
for d in fonts voice; do [ -d "$OFFLINE_DIR/data/$d" ] && cp -al "$OFFLINE_DIR/data/$d" "$STAGE/$d"; done
# satellite / aerial photo packs (features/imagery) -> /srv/navdata/imagery, each checked against its BUILD-INFO sha256
mkdir -p "$STAGE/imagery"
if [ -s "$OFFLINE_DIR/data/imagery/BUILD-INFO" ]; then
  for f in "$OFFLINE_DIR/data/imagery"/*.mbtiles; do
    [ -e "$f" ] || continue; n=$(basename "$f")
    want=$(sed -n "s/^${n//./\\.}\.sha256=//p" "$OFFLINE_DIR/data/imagery/BUILD-INFO")
    [ -n "$want" ] || fail "imagery $n: not in BUILD-INFO — run python3 tools/imagery_buildinfo.py $OFFLINE_DIR/data/imagery"
    echo "checking imagery/$n …"; [ "$(sha256sum "$f" | cut -d' ' -f1)" = "$want" ] || fail "imagery/$n checksum wrong"
    cp -al "$f" "$STAGE/imagery/$n"
  done
fi
mkdir -p "$STAGE/media/Music" "$STAGE/media/Audiobooks" "$STAGE/media/Podcasts"
# verify the region data against its BUILD-INFO before it goes on a disk
for f in "map/$REGION.pmtiles:sha256" "search/places.sqlite:sha256" "valhalla/valhalla_tiles.tar:tar_sha256"; do
  file=${f%%:*}; key=${f##*:}; want=$(sed -n "s/^$key=//p" "$R/${file%%/*}/BUILD-INFO")
  [ -n "$want" ] || fail "no $key in $R/${file%%/*}/BUILD-INFO"
  echo "checking $file …"; [ "$(sha256sum "$R/$file" | cut -d' ' -f1)" = "$want" ] || fail "$file checksum wrong"
done

say "3/4 the kit (code at git HEAD $(git -C "$ROOT" rev-parse --short HEAD), packages, routing image)"
K="$STAGE/kit"; mkdir -p "$K/bin"
git -C "$ROOT" archive HEAD | tar -x -C "$K"
cp -al "$OFFLINE_DIR/pi-debs" "$K/pi-debs"
cp -al "$OFFLINE_DIR/pi-docker" "$K/pi-docker"
cp -al "$OFFLINE_DIR/bin/pmtiles-arm64.tgz" "$K/bin/"
git -C "$ROOT" log -1 --format='%h %cs %s' > "$K/VERSION"
cat > "$K/disk.env" <<E
VALHALLA_IMAGE='$VALHALLA_IMAGE'
VALHALLA_IMAGE_ID_ARM64='$VALHALLA_IMAGE_ID_ARM64'
VALHALLA_TAG='$VALHALLA_TAG'
PMTILES_SHA256_ARM64='$PMTILES_SHA256_ARM64'
PI_USER='$PI_USER'
BROWSER_LANG='$BROWSER_LANG'
BUILD_EPOCH=$(date +%s)
EDITION='${EDITION:-}'
E
chmod -R u+rwX,go+rX "$STAGE"

say "4/4 compose (mke2fs builds the data partition; takes a while)"
nice -n 10 python3 "$ROOT/tools/make_disk.py" "$DISK_DIR/boot-root.img" "$STAGE" "$DISK_DIR" --root-gib "${ROOT_GIB:-64}"
echo; echo "DONE: $DISK_DIR (head.img + data.img + manifest.json)"
echo "Next: plug in the disk, then  sudo bash scripts/41-write-disk.sh /dev/sdX"
