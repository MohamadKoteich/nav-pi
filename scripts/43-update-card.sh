#!/usr/bin/env bash
# Update the nav-pi app on a card/disk plugged into this PC (no network to the Pi needed), then offer to add Wi-Fi.
#   sudo bash scripts/43-update-card.sh /dev/sdX        (sudo HARDWARE=30-rpi4-8gb … when the card moved to another board)
# Rebuilds the SAME edition + hardware profile the card already runs (read from its /opt/nav-pi/edition.json) from
# this checkout and installs it the way 22-update-app.sh does over SSH: app + navd + kiosk/session scripts, the polkit
# rules, the update machinery (pi/install-updates.sh) and the boot/clock items (pi/install-boot.sh), here onto the
# mounted card (NAV_PI_ROOT). The previous app is kept as /opt/nav-pi/app.prev and navd.prev.
HERE=$(cd "$(dirname "$0")" && pwd)
. "$HERE/common.sh"
[ $# -ge 1 ] || fail "name the disk:  sudo bash $0 /dev/sdX   (lsblk -o NAME,SIZE,TRAN,MODEL shows it)"
[ "$(id -u)" = 0 ] || fail "run it with sudo:  sudo bash $0 $1"
[ -n "${SUDO_USER:-}" ] && [ "$SUDO_USER" != root ] || fail "run it with sudo from your own account (the build runs as you)"
DEV=$1; NAME=$(basename "$DEV")
[[ $NAME =~ ^sd[a-z]+$ ]] && [ -b "$DEV" ] || fail "$DEV is not a whole disk like /dev/sdX"
[ "$(lsblk -dn -o TRAN "$DEV" | tr -d ' ')" = usb ] || fail "$DEV is not on USB"
ROOTP=${DEV}2; [ -b "$ROOTP" ] || fail "$DEV has no partition 2 (the Pi's root)"
[ "$(lsblk -no FSTYPE "$ROOTP")" = ext4 ] || fail "$ROOTP is not ext4 — not a Pi system disk"
MNT=$(mktemp -d); BUILD=$(sudo -u "$SUDO_USER" mktemp -d)
trap 'umount "$MNT" 2>/dev/null || true; rmdir "$MNT" 2>/dev/null || true; rm -rf "$BUILD"' EXIT
if cur=$(findmnt -nro TARGET "$ROOTP" | head -1) && [ -n "$cur" ]; then mount --bind "$cur" "$MNT"; else mount "$ROOTP" "$MNT"; fi
host=$(cat "$MNT/etc/hostname" 2>/dev/null || echo none)
echo "card: $ROOTP, hostname $host"
ED=$MNT/opt/nav-pi/edition.json
if [ ! -f "$ED" ] && [ -e "$MNT/opt/pi-nav" ]; then
  fail "this card was installed under the project's earlier name (pi-nav). Update it once over the network instead:
  put it back in the Pi and run  bash scripts/22-update-app.sh <host>  (it migrates the install, keeping data and settings) — nothing changed"
fi
if [ ! -f "$ED" ]; then
  ls -la "$MNT/opt" 2>/dev/null | sed 's/^/  \/opt: /'
  fail "no nav-pi app installed on this card ($host has no /opt/nav-pi/edition.json) — nothing changed"
fi
read -r edition hardware src built < <(python3 -c 'import json,sys; e=json.load(open(sys.argv[1])); print(e["edition"], e.get("hardware",""), e.get("source","?"), e.get("built","?"))' "$ED")
echo "installed: edition $edition, hardware ${hardware:-auto}, built $built from $src"
# the card cannot tell which board it goes into: HARDWARE=… / EDITION=… override what it ran before
# (a card moved from a Pi 5 to a Pi 4:  sudo HARDWARE=30-rpi4-8gb bash scripts/43-update-card.sh /dev/sdX)
edition=${EDITION:-$edition}; hardware=${HARDWARE:-$hardware}
echo "building: edition $edition, hardware ${hardware:-auto}"
args=(--edition "$edition" --out "$BUILD/b")
[ -n "$hardware" ] && args+=(--hardware "$hardware")
sudo -u "$SUDO_USER" python3 "$ROOT/tools/build_edition.py" "${args[@]}" || fail "edition build refused — nothing changed"
B=$BUILD/b; O=$MNT/opt/nav-pi
[ -f "$B/app/index.html" ] && [ -f "$B/navd/navd.py" ] || fail "build incomplete — nothing changed"
PIUSER=$(awk -F: '$3==1000{print $1}' "$MNT/etc/passwd"); [ -n "$PIUSER" ] || PIUSER=nav
rm -rf "$O/app.prev" "$O/navd.prev"; cp -a "$O/app" "$O/app.prev"; cp -a "$O/navd" "$O/navd.prev"
rsync -a --delete "$B/app/" "$O/app/"
rsync -a --delete --exclude __pycache__ "$B/navd/" "$O/navd/"
install -m 0644 "$B/edition.json" "$O/edition.json"
install -m 0755 "$ROOT/pi/kiosk.sh" "$O/kiosk.sh"
install -m 0755 "$ROOT/pi/session.sh" "$O/session.sh"
if grep -qx wifi "$B/services.txt" && [ -d "$MNT/etc/polkit-1/rules.d" ]; then
  sed "s/@USER@/$PIUSER/" "$ROOT/pi/49-nav-pi-wifi.rules.in" > "$MNT/etc/polkit-1/rules.d/49-nav-pi-wifi.rules"
fi
if grep -qx usb "$B/services.txt" && [ -d "$MNT/etc/polkit-1/rules.d" ]; then
  sed "s/@USER@/$PIUSER/" "$ROOT/pi/49-nav-pi-usb.rules.in" > "$MNT/etc/polkit-1/rules.d/49-nav-pi-usb.rules"
fi
NAV_PI_ROOT=$MNT NAV_PI_BUILD=$B bash "$ROOT/pi/install-updates.sh" "$PIUSER" "$ROOT/pi" || fail "update machinery not installed (pi/install-updates.sh)"
NAV_PI_ROOT=$MNT NAV_PI_BUILD=$B bash "$ROOT/pi/install-boot.sh" "$PIUSER" "$ROOT/pi" || fail "boot items not installed (pi/install-boot.sh)"
sync
new=$(python3 -c 'import json,sys; print(json.load(open(sys.argv[1])).get("source","?"))' "$O/edition.json")
grep -q 'setRangeText' "$O/app/"*.js 2>/dev/null || grep -rqs 'setRangeText' "$O/app/" || fail "the new keyboard is not in the copied app — check the build"
echo "app updated on the card: $edition, source $src -> $new (old copy kept as app.prev / navd.prev)"
umount "$MNT"; rmdir "$MNT"; trap 'rm -rf "$BUILD"' EXIT
echo
read -r -p "Add a Wi-Fi network to the card now? [y/N] " a
if [[ $a =~ ^[yYjJoO] ]]; then bash "$HERE/42-add-wifi.sh" "$DEV"; fi
sync
echo; echo "DONE — you can take the card out and put it in the Pi."
