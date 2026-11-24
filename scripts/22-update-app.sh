#!/bin/bash
# Fast update while developing: rebuild the edition for the Pi, copy app + navd, restart, reload.
#   bash scripts/22-update-app.sh [host]
. "$(dirname "$0")/common.sh"
HOST=${1:-$PI_HOSTNAME.local}
build_for_pi "$HOST"
rsync -a --delete -e "ssh -o BatchMode=yes" "$BUILD_DIR/" "$PI_USER@$HOST:/tmp/nav-pi-build/"
rsync -a -e "ssh -o BatchMode=yes" "$ROOT/pi/" "$PI_USER@$HOST:/tmp/nav-pi-pi/"
# a device installed under the project's earlier name (pi-nav): migrate it and do one full install
if ssh -o BatchMode=yes "$PI_USER@$HOST" 'test -e /opt/pi-nav -o -e /etc/systemd/system/pi-nav.service'; then
  say "this device was installed under the earlier name pi-nav: migrating to nav-pi (data and settings kept)"
  ssh -o BatchMode=yes "$PI_USER@$HOST" "sudo VALHALLA_IMAGE='$VALHALLA_TAG' PI_USER='$PI_USER' BROWSER_LANG='$BROWSER_LANG' bash /tmp/nav-pi-pi/install-runtime.sh" \
    || fail "migration / install on the device failed"
  exit 0
fi
ssh -o BatchMode=yes "$PI_USER@$HOST" 'B=/tmp/nav-pi-build;
  sudo rsync -a --delete $B/app/ /opt/nav-pi/app/ &&
  sudo rsync -a --delete --exclude __pycache__ $B/navd/ /opt/nav-pi/navd/ &&
  sudo install -m 0644 $B/edition.json /opt/nav-pi/edition.json &&
  sudo install -m 0755 /tmp/nav-pi-pi/kiosk.sh /opt/nav-pi/kiosk.sh &&
  sudo install -m 0755 /tmp/nav-pi-pi/session.sh /opt/nav-pi/session.sh &&
  { ! grep -qx wifi $B/services.txt || { sed "s/@USER@/$(id -un)/" /tmp/nav-pi-pi/49-nav-pi-wifi.rules.in | sudo tee /etc/polkit-1/rules.d/49-nav-pi-wifi.rules >/dev/null; }; } &&
  { ! grep -qx usb $B/services.txt || { sed "s/@USER@/$(id -un)/" /tmp/nav-pi-pi/49-nav-pi-usb.rules.in | sudo tee /etc/polkit-1/rules.d/49-nav-pi-usb.rules >/dev/null; }; } &&
  sudo bash /tmp/nav-pi-pi/install-updates.sh $(id -un) /tmp/nav-pi-pi &&
  sudo bash /tmp/nav-pi-pi/install-boot.sh $(id -un) /tmp/nav-pi-pi &&
  sudo systemctl restart nav-pi && sudo systemctl restart greetd && echo "updated; screen reloads in a few seconds"'
