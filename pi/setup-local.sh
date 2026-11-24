#!/bin/bash
# Offline install FROM THE DISK ITSELF — no PC, no internet. The self-contained disk (scripts/40-make-disk.sh)
# carries the kit in /srv/navdata/kit (code, pi-debs, Valhalla image, pmtiles) next to the region data;
# firstboot.sh runs this as root on the first boot. Same steps as scripts/20-setup-pi.sh, run locally:
# packages -> Valhalla image -> pmtiles -> the edition that fits THIS board (model + RAM) -> services.
# Re-runnable. Log: /var/log/nav-pi-firstboot.log
set -euo pipefail
K=${KIT:-/srv/navdata/kit}
# shellcheck disable=SC1091
. "$K/disk.env"   # VALHALLA_IMAGE PMTILES_SHA256_ARM64 PI_USER BUILD_EPOCH EDITION BROWSER_LANG (optional)
echo "=== setup-local $(date -Is) kit $(cat "$K/VERSION" 2>/dev/null || echo ?)"

# the Pi has no clock battery and no internet: never run with a clock older than the disk
if [ "$(date +%s)" -lt "$BUILD_EPOCH" ]; then date -u -s "@$BUILD_EPOCH" >/dev/null; echo "clock set to the disk's build time"; fi

echo "1/5 packages ($(find "$K/pi-debs" -name '*.deb' | wc -l) .deb from the disk)"
bash "$K/pi/install-debs.sh" "$K/pi-debs"
usermod -aG docker "$PI_USER"
systemctl enable --now docker >/dev/null

echo "2/5 Valhalla image"
# disks built before 2026-11-12 23:00 have no ID/tag in disk.env: the pinned values
: "${VALHALLA_IMAGE_ID_ARM64:=sha256:a8c22df311f277c4866b3ba9de771c4675ec4ed50a5d1cc1d145ee3bf62530dd}"
: "${VALHALLA_TAG:=nav-pi/valhalla:3.5.1}"
bash "$K/pi/load-valhalla.sh" "$(ls "$K"/pi-docker/valhalla-*-arm64.tar.gz)" "$VALHALLA_IMAGE_ID_ARM64" "$VALHALLA_TAG" "$VALHALLA_IMAGE"

echo "3/5 pmtiles"
echo "$PMTILES_SHA256_ARM64  $K/bin/pmtiles-arm64.tgz" | sha256sum -c -
tar xzf "$K/bin/pmtiles-arm64.tgz" -C /usr/local/bin pmtiles

echo "4/5 edition for this board"
MODEL=$(tr -d '\0' < /proc/device-tree/model 2>/dev/null || uname -m)
RAM=$(awk '/MemTotal/{print int($2/1024)}' /proc/meminfo)
ED=${EDITION:-}
if [ -z "$ED" ]; then
  ED=$(python3 - "$K" "$MODEL" "$RAM" <<'PY'
import sys; sys.path.insert(0, sys.argv[1] + "/tools")
import build_edition as b
print(b.pick_hardware(None, sys.argv[2], int(sys.argv[3]))[1]["DEFAULT_EDITION"])
PY
)
fi
echo "board: $MODEL, $RAM MB -> edition $ED"
rm -rf /tmp/nav-pi-build /tmp/nav-pi-pi
python3 "$K/tools/build_edition.py" --edition "$ED" --model "$MODEL" --ram "$RAM" --out /tmp/nav-pi-build
cp -a "$K/pi" /tmp/nav-pi-pi

echo "5/5 services + kiosk"
VALHALLA_IMAGE="$VALHALLA_TAG" PI_USER="$PI_USER" BROWSER_LANG="${BROWSER_LANG:-}" bash /tmp/nav-pi-pi/install-runtime.sh

rm -rf /tmp/nav-pi-build /tmp/nav-pi-pi   # root-owned leftovers would block a later scripts/22-update-app.sh (rsync as the user)
echo "=== setup-local done $(date -Is)"
