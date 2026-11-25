#!/bin/bash
# Test, write and verify the microSD card in ONE run:
#   sudo bash scripts/02-flash-sd.sh              (finds the card by itself)
#   sudo bash scripts/02-flash-sd.sh /dev/sdX     (if several cards/USB sticks are plugged in)
# Steps: safety checks -> f3probe (is the card genuine?) -> write image -> read back + sha256.
# Refuses anything that is not a removable USB disk of 8-512 GB, or that holds a system mount.
# CHECK_ONLY=1 runs the checks and stops (no root needed).
. "$(dirname "$0")/common.sh"
BS=4194304
LOG="$WORK_DIR/flash.log"
# GNU dd: uutils dd (Ubuntu 25.10+) fails direct reads from a block device with "IO error: Invalid input"
DD=$(command -v gnudd || command -v dd)

if [ "${CHECK_ONLY:-0}" != 1 ]; then
  [ "$(id -u)" = 0 ] || fail "run it with sudo:  sudo bash $0"
  mkdir -p "$WORK_DIR"; : > "$LOG"
  # the log belongs to you, not root (sudo): a later run or rm needs no sudo
  [ -n "${SUDO_UID:-}" ] && chown "$SUDO_UID:${SUDO_GID:-$SUDO_UID}" "$LOG"
  exec > >(tee "$LOG") 2>&1
fi

candidates() {  # removable USB whole disks, 8-512 GB
  for s in /sys/block/sd*; do
    [ -e "$s" ] || continue
    n=$(basename "$s"); sz=$(( $(cat "$s/size") * 512 ))
    [ "$(cat "$s/removable")" = 1 ] || continue
    [ "$(lsblk -dn -o TRAN "/dev/$n" | tr -d ' ')" = usb ] || continue
    [ "$sz" -ge 8000000000 ] && [ "$sz" -le 520000000000 ] || continue
    echo "/dev/$n"
  done
}

say "1/5 safety checks"
if [ $# -ge 1 ]; then
  DEV=$(readlink -f "$1")
else
  mapfile -t C < <(candidates)
  [ "${#C[@]}" -ge 1 ] || fail "no microSD card found. Insert the card (in a USB reader) and run again."
  [ "${#C[@]}" -eq 1 ] || { lsblk -d -o NAME,SIZE,TRAN,MODEL "${C[@]}"; fail "several cards/sticks found: unplug the others, or name one:  sudo bash $0 /dev/sdX"; }
  DEV=${C[0]}
fi
NAME=$(basename "$DEV")
[[ $NAME =~ ^sd[a-z]+$ ]] && [ -b "$DEV" ] || fail "$DEV is not a whole disk like /dev/sdX"
[ "$(lsblk -dn -o TRAN "$DEV" | tr -d ' ')" = usb ] || fail "$DEV is not on USB"
[ "$(cat "/sys/block/$NAME/removable")" = 1 ] || fail "$DEV is not removable media"
SIZE=$(( $(cat "/sys/block/$NAME/size") * 512 ))
[ "$SIZE" -ge 8000000000 ] && [ "$SIZE" -le 520000000000 ] || fail "$DEV is $((SIZE/1000000000)) GB — not an 8-512 GB card"
# the target must not carry the running system: no / /boot /home /usr /var swap etc. on it
while read -r src tgt; do
  [ -b "$src" ] || continue
  top=$(lsblk -no PKNAME "$src" 2>/dev/null | head -1); [ -n "$top" ] || top=$(basename "$src")
  [ "$top" = "$NAME" ] || continue
  case "$tgt" in /media/*|/run/media/*|/mnt/*) ;; *) fail "$DEV is mounted at $tgt — that is not a card"; esac
done < <(findmnt -rn -o SOURCE,TARGET)
if grep -q "^/dev/$NAME" /proc/swaps; then fail "$DEV is used as swap"; fi
lsblk -o NAME,SIZE,TRAN,RM,LABEL,MODEL,MOUNTPOINTS "$DEV"
echo "target = $DEV ($((SIZE/1000000000)) GB, USB, removable)"

say "2/5 image checksum"
[ -f "$IMG" ] || fail "no image yet — run first:  bash scripts/01-build-image.sh"
(cd "$WORK_DIR" && sha256sum -c nav-pi.img.sha256) || fail "nav-pi.img does not match its checksum — rebuild it"
IMGSIZE=$(stat -c %s "$IMG"); [ $((IMGSIZE % BS)) = 0 ] || fail "image size not a multiple of 4 MiB"
[ "$IMGSIZE" -lt "$SIZE" ] || fail "card smaller than the image"
COUNT=$((IMGSIZE / BS)); WANT=$(cut -d' ' -f1 "$WORK_DIR/nav-pi.img.sha256")

if [ "${CHECK_ONLY:-0}" = 1 ]; then echo; echo "CHECK_ONLY: all safety checks passed for $DEV"; exit 0; fi

# desktops auto-mount inserted cards under /media: release them (target is proven to be the card)
for p in $(lsblk -nr -o NAME "$DEV" | tail -n +2); do
  if findmnt -rn -S "/dev/$p" >/dev/null; then echo "unmounting /dev/$p"; umount "/dev/$p"; fi
done

say "3/5 card test with f3probe (is it genuine and its full size real?) — a few minutes"
if ! command -v f3probe >/dev/null; then
  { ls "$OFFLINE_DIR"/pc-debs/f3_*.deb >/dev/null 2>&1 && dpkg -i "$OFFLINE_DIR"/pc-debs/f3_*.deb >/dev/null; } \
    || fail "install the 'f3' card tester (bundle has a .deb for Debian/Ubuntu PCs) and run again"
fi
F3=$(f3probe --destructive --time-ops "$DEV" 2>&1) || true
echo "$F3" | grep -vE "^\s*$" | tail -12
grep -q "is the real thing" <<<"$F3" || fail "f3probe says this card is FAKE or DEFECTIVE. Use another card (SanDisk/Samsung from a real shop)."

say "4/5 writing image ($((IMGSIZE/1000000)) MB) — direct I/O, so the progress is real"
wipefs -a "$DEV" >/dev/null
"$DD" if="$IMG" of="$DEV" bs=$BS oflag=direct conv=fsync status=progress
sync; blockdev --flushbufs "$DEV"; echo 3 > /proc/sys/vm/drop_caches

say "5/5 reading the card back and comparing"
GOT=$("$DD" if="$DEV" bs=$BS count=$COUNT iflag=direct status=none | sha256sum | cut -d' ' -f1)
echo "expected $WANT"; echo "on card  $GOT"
[ "$GOT" = "$WANT" ] || fail "card content differs from the image: the card or the card READER is faulty. Try another reader."

echo
echo "==================================================================="
echo "  SUCCESS: card tested genuine, written and verified."
echo "  Remove the card, put it in the Pi, connect Ethernet, power on."
echo "  Then, after about a minute:  bash scripts/03-check-pi.sh"
echo "==================================================================="
