#!/bin/bash
# Install the navigation runtime on the Pi (run on the build PC; works over SSH). Re-runnable.
#   bash scripts/20-setup-pi.sh [host]
# Installs: docker + the pinned Valhalla image (arm64), the pmtiles tool (pinned, arm64), and the
# edition that fits the board (scripts/common.sh build_for_pi: editions/, hardware/, features/).
. "$(dirname "$0")/common.sh"
HOST=${1:-$PI_HOSTNAME.local}
SSH=(ssh -o StrictHostKeyChecking=accept-new -o ConnectTimeout=5 -o BatchMode=yes "$PI_USER@$HOST")
ssh_ok "${SSH[@]}" || fail "no SSH to $HOST — run scripts/03-check-pi.sh first"

need_offline
say "0/4 clock (the Pi has no clock battery and no internet): set from this PC"
"${SSH[@]}" "sudo date -u -s @$(date -u +%s) >/dev/null && date"

say "1/4 packages from the offline bundle ($(find "$OFFLINE_DIR/pi-debs" -name '*.deb' | wc -l) .deb, no internet)"
rsync -a --delete -e "ssh -o BatchMode=yes" "$OFFLINE_DIR/pi-debs/" "$PI_USER@$HOST:/tmp/nav-pi-debs/"
rsync -a -e "ssh -o BatchMode=yes" "$ROOT/pi/install-debs.sh" "$PI_USER@$HOST:/tmp/nav-pi-install-debs.sh"
# a local repository that apt sees alone (pi/install-debs.sh): the image's own package lists can't pull in internet copies
"${SSH[@]}" 'sudo bash /tmp/nav-pi-install-debs.sh /tmp/nav-pi-debs &&
  sudo usermod -aG docker "$USER" && sudo systemctl enable --now docker >/dev/null && docker --version' \
  || fail "package install on the Pi failed"

say "2/4 Valhalla image (from the bundle, arm64)"
rsync -a -e "ssh -o BatchMode=yes" "$ROOT/pi/load-valhalla.sh" "$PI_USER@$HOST:/tmp/nav-pi-load-valhalla.sh"
LV="sudo bash /tmp/nav-pi-load-valhalla.sh - '$VALHALLA_IMAGE_ID_ARM64' '$VALHALLA_TAG' '$VALHALLA_IMAGE'"
if ! "${SSH[@]}" "$LV" </dev/null 2>/dev/null; then   # not there yet (tag, registry copy or ID): send the bundle's image
  # shellcheck disable=SC2002
  cat "$OFFLINE_DIR"/pi-docker/valhalla-*-arm64.tar.gz | "${SSH[@]}" "$LV" || fail "routing image load failed"
fi

say "3/4 pmtiles tool v$PMTILES_VERSION (arm64, checksum-pinned)"
T="$OFFLINE_DIR/bin/pmtiles-arm64.tgz"
echo "$PMTILES_SHA256_ARM64  $T" | sha256sum -c - || fail "pmtiles arm64 checksum wrong"
"${SSH[@]}" 'sudo tar xz -C /usr/local/bin pmtiles && pmtiles version | head -1' < "$T"

say "4/4 edition: app + services"
build_for_pi "$HOST"
rsync -a --delete -e "ssh -o BatchMode=yes" "$BUILD_DIR/" "$PI_USER@$HOST:/tmp/nav-pi-build/"
rsync -a --delete -e "ssh -o BatchMode=yes" "$ROOT/pi/" "$PI_USER@$HOST:/tmp/nav-pi-pi/"
"${SSH[@]}" "sudo VALHALLA_IMAGE='$VALHALLA_TAG' PI_USER='$PI_USER' BROWSER_LANG='$BROWSER_LANG' bash /tmp/nav-pi-pi/install-runtime.sh"
echo; echo "DONE. Next: bash scripts/21-push-data.sh"
