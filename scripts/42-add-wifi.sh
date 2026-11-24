#!/usr/bin/env bash
# Put a Wi-Fi network on a nav-pi disk from the PC, so the Pi joins it at boot (no keyboard on the Pi needed).
#   sudo bash scripts/42-add-wifi.sh /dev/sdX        (the Pi's SSD/SD in a USB adapter on this PC)
# Asks for the network name and the password (hidden). Writes one NetworkManager profile on the root partition
# (/etc/NetworkManager/system-connections, root 600). The password is not printed, logged or kept anywhere else.
. "$(dirname "$0")/common.sh"
[ $# -ge 1 ] || fail "name the disk:  sudo bash $0 /dev/sdX   (lsblk -o NAME,SIZE,TRAN,MODEL,SERIAL shows it)"
[ "$(id -u)" = 0 ] || fail "run it with sudo:  sudo bash $0 $1"
# the profile is written by `nmcli --offline` (NetworkManager 1.40 or newer on THIS PC)
need nmcli "sudo apt install network-manager"
NMV=$(nmcli --version 2>/dev/null | grep -oE '[0-9]+\.[0-9]+' | head -1)
[ "$(printf '%s\n1.40\n' "${NMV:-0}" | sort -V | head -n1)" = 1.40 ] \
  || fail "this PC's NetworkManager is ${NMV:-unknown}: writing a Wi-Fi profile offline needs 1.40 or newer (nmcli --offline)"
DEV=$1; NAME=$(basename "$DEV")
[[ $NAME =~ ^sd[a-z]+$ ]] && [ -b "$DEV" ] || fail "$DEV is not a whole disk like /dev/sdX"
[ "$(lsblk -dn -o TRAN "$DEV" | tr -d ' ')" = usb ] || fail "$DEV is not on USB"
ROOTP=${DEV}2; [ -b "$ROOTP" ] || fail "$DEV has no partition 2 (the nav-pi root)"
[ "$(lsblk -no FSTYPE "$ROOTP")" = ext4 ] || fail "$ROOTP is not ext4 — not a nav-pi disk"
MNT=$(mktemp -d); trap 'umount "$MNT" 2>/dev/null || true; rmdir "$MNT"' EXIT
if cur=$(findmnt -nro TARGET "$ROOTP" | head -1) && [ -n "$cur" ]; then mount --bind "$cur" "$MNT"; else mount "$ROOTP" "$MNT"; fi
host=$(cat "$MNT/etc/hostname" 2>/dev/null || true)
# a nav-pi disk: set up already (app installed), or freshly written and not booted yet (nav-pi first-boot files on
# the boot partition; the hostname is still the OS default until the first boot)
fresh() {
  local b; b=$(mktemp -d)
  mount -o ro "${DEV}1" "$b" 2>/dev/null || { rmdir "$b"; return 1; }
  local r=1; [ -f "$b/nav-pi/firstboot.sh" ] && r=0
  umount "$b"; rmdir "$b"; return $r
}
[[ $host == nav-pi* ]] || [ -f "$MNT/opt/nav-pi/edition.json" ] || fresh \
  || fail "$ROOTP has hostname '${host:-none}', no nav-pi app and no nav-pi first-boot files — refusing"
DIR=$MNT/etc/NetworkManager/system-connections
[ -d "$DIR" ] || fail "no NetworkManager on this disk ($DIR missing)"
echo "nav-pi disk found: $ROOTP (hostname $host)"
read -r -p "Wi-Fi network name (exactly as it appears, capitals matter): " SSID
[ -n "$SSID" ] || fail "empty network name"
read -r -s -p "Wi-Fi password (hidden): " PW; echo
read -r -s -p "Same password again: " PW2; echo
[ "$PW" = "$PW2" ] || fail "the two passwords differ — nothing written"
[ ${#PW} -ge 8 ] && [ ${#PW} -le 63 ] || fail "a WPA password has 8 to 63 characters"
# keyfile escaping for the value (GLib key file): backslash, space, tab
esc=${PW//\\/\\\\}; esc=${esc// /\\s}; esc=${esc//$'\t'/\\t}
F=$DIR/nav-pi-wifi-$(date +%Y%m%d%H%M%S).nmconnection
umask 077
nmcli --offline connection add type wifi con-name "$SSID" ssid "$SSID" wifi-sec.key-mgmt wpa-psk \
  connection.autoconnect yes connection.autoconnect-priority 10 \
  | PSK="$esc" awk '{print} /^key-mgmt=/{print "psk=" ENVIRON["PSK"]}' > "$F"
unset PW PW2 esc
grep -q '^psk=' "$F" || { rm -f "$F"; fail "profile not written"; }
chown root:root "$F"; chmod 600 "$F"
sync
echo "Done: Wi-Fi '$SSID' added to the Pi ($(basename "$F")). Put the disk back in the Pi and switch it on."
