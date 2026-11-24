#!/bin/bash
# Copy the kit to another folder or USB disk, so another PC can set up a Pi with NO internet:
#   bash scripts/06-export.sh /media/usb
# Copies: the code (git HEAD), the offline/ bundle (~1.2 GB + any data you put there) and the region data you
# built (work/data/<region>/: ~1 GB for Upper Bavaria, ~13 GB for Germany). Then verifies every copied file.
# The disk must be ext4, exFAT or NTFS (FAT32 cannot hold files over 4 GB).
. "$(dirname "$0")/common.sh"
DEST=${1:?usage: bash scripts/06-export.sh <folder or mounted USB disk>}
need_offline
K="$DEST/nav-pi"; mkdir -p "$K"
say "code (git HEAD $(git -C "$ROOT" rev-parse --short HEAD); uncommitted changes are not copied)"
git -C "$ROOT" archive --format=tar HEAD | tar -x -C "$K"
say "offline bundle ($(du -sh "$OFFLINE_DIR" | cut -f1))"
rsync -a --info=progress2 "$OFFLINE_DIR/" "$K/offline/"
if [ -d "$WORK_DIR/data" ]; then
  say "built region data: $(cd "$WORK_DIR/data" && echo */ | tr -d /) ($(du -sh "$WORK_DIR/data" | cut -f1))"
  # the .osm.pbf extracts and Valhalla's loose tile folder are build input, not needed on another PC; admin_data/ and
  # timezone_data/ are copied: scripts/21-push-data.sh and tools/make_update_manifest.py send them to the Pi
  mkdir -p "$K/work/data"
  rsync -a --info=progress2 --exclude '*.osm.pbf' --exclude '*.part' --exclude 'valhalla_tiles/' \
    "$WORK_DIR/data/" "$K/work/data/"
fi
say "verify"
(cd "$K/offline" && sha256sum --quiet -c SHA256SUMS) || fail "offline bundle copy is damaged — run again"
if [ -d "$WORK_DIR/data" ]; then
  diff=$(rsync -anc --out-format='%n' --exclude '*.osm.pbf' --exclude '*.part' --exclude 'valhalla_tiles/' \
    "$WORK_DIR/data/" "$K/work/data/" | grep -v '/$' || true)
  [ -z "$diff" ] || fail "these files differ after the copy — run again: $diff"
fi
echo; echo "DONE: $K — start with README.md and docs/INSTALL.md (no internet needed)."
