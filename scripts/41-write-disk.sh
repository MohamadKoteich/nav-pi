#!/bin/bash
# Write the self-contained disk built by scripts/40-make-disk.sh onto a USB disk and read it back.
#   sudo bash scripts/41-write-disk.sh /dev/sdX            (asks you to type the disk's serial number)
#   CHECK_ONLY=1 bash scripts/41-write-disk.sh /dev/sdX     (checks only, no root, writes nothing)
#   sudo env VERIFY_ONLY=1 bash scripts/41-write-disk.sh /dev/sdX  (only reads the disk back and compares; nothing written)
# ERASES the whole disk. Refuses: not a whole USB disk, too small, or carrying anything mounted
# outside /media, /run/media, /mnt (= the running system). Log: <DISK_DIR>/write.log
. "$(dirname "$0")/common.sh"
DISK_DIR=${DISK_DIR:-$ROOT/disk}
BS=4194304
# GNU dd: uutils dd (Ubuntu 25.10+) fails direct reads from a block device with "IO error: Invalid input"
DD=$(command -v gnudd || command -v dd)
MIB=1048576
M="$DISK_DIR/manifest.json"
[ $# -ge 1 ] || fail "name the disk:  sudo bash $0 /dev/sdX   (lsblk -o NAME,SIZE,TRAN,MODEL,SERIAL shows it)"
if [ "${CHECK_ONLY:-0}" != 1 ]; then
  [ "$(id -u)" = 0 ] || fail "run it with sudo:  sudo bash $0 $1"
  exec > >(tee -a "$DISK_DIR/write.log") 2>&1
fi

say "1/4 safety checks"
DEV=$(readlink -f "$1"); NAME=$(basename "$DEV")
[[ $NAME =~ ^sd[a-z]+$ ]] && [ -b "$DEV" ] || fail "$DEV is not a whole disk like /dev/sdX"
[ "$(lsblk -dn -o TRAN "$DEV" | tr -d ' ')" = usb ] || fail "$DEV is not on USB"
SIZE=$(( $(cat "/sys/block/$NAME/size") * 512 ))
while read -r src tgt; do
  [ -b "$src" ] || continue
  top=$(lsblk -no PKNAME "$src" 2>/dev/null | head -1); [ -n "$top" ] || top=$(basename "$src")
  [ "$top" = "$NAME" ] || continue
  case "$tgt" in /media/*|/run/media/*|/mnt/*) ;; *) fail "$DEV is mounted at $tgt — that is part of the running system";; esac
done < <(findmnt -rn -o SOURCE,TARGET)
if grep -q "^/dev/$NAME" /proc/swaps; then fail "$DEV is used as swap"; fi
[ -f "$M" ] || fail "no disk image yet — run first:  bash scripts/40-make-disk.sh"
NEED=$(python3 -c 'import json,sys;print(json.load(open(sys.argv[1]))["min_disk_bytes"])' "$M")
[ "$SIZE" -ge "$NEED" ] || fail "$DEV is $((SIZE/1000000000)) GB, the image needs $((NEED/1000000000)) GB"
SERIAL=$(lsblk -dn -o SERIAL "$DEV" | tr -d ' ')
lsblk -o NAME,SIZE,TRAN,LABEL,MODEL,SERIAL,MOUNTPOINTS "$DEV"
echo "target = $DEV ($((SIZE/1000000000)) GB, USB), serial ${SERIAL:-none}; image needs $((NEED/1000000000)) GB"

say "2/4 image pieces"
mapfile -t P < <(python3 -c 'import json,sys
for p in json.load(open(sys.argv[1]))["pieces"]: print(p["file"], p["offset"], p["size"], p["sha256"])' "$M")
for line in "${P[@]}"; do
  read -r f off sz _ <<<"$line"
  [ "$(stat -c %s "$DISK_DIR/$f")" = "$sz" ] || fail "$f has the wrong size — rebuild with 40-make-disk.sh"
  [ $((off % BS)) = 0 ] && [ $((sz % MIB)) = 0 ] || fail "$f: offset/size not aligned (offset 4 MiB, size 1 MiB)"
  echo "$f -> byte $off, $((sz/1000000)) MB"
done
if [ "${CHECK_ONLY:-0}" = 1 ]; then echo; echo "CHECK_ONLY: all checks passed for $DEV"; exit 0; fi

if [ "${VERIFY_ONLY:-0}" != 1 ]; then
if [ "${YES:-}" != "$SERIAL" ]; then
  echo; echo "EVERYTHING ON $DEV WILL BE ERASED. Type its serial number ($SERIAL) to continue:"
  read -r ans; [ "$ans" = "$SERIAL" ] || fail "not confirmed — nothing written"
fi
for p in $(lsblk -nr -o NAME "$DEV" | tail -n +2); do
  if findmnt -rn -S "/dev/$p" >/dev/null; then echo "unmounting /dev/$p"; umount "/dev/$p"; fi
done

say "3/4 writing (direct I/O, real progress)"
wipefs -a "$DEV" >/dev/null
for line in "${P[@]}"; do
  read -r f off sz _ <<<"$line"
  echo "$f"
  "$DD" if="$DISK_DIR/$f" of="$DEV" bs=$BS seek=$((off / BS)) oflag=direct conv=fsync,notrunc status=progress
done
sync; blockdev --flushbufs "$DEV"; echo 3 > /proc/sys/vm/drop_caches
fi   # VERIFY_ONLY skips the writing

say "4/4 reading back and comparing"
for line in "${P[@]}"; do
  read -r f off sz want <<<"$line"
  # read exactly sz bytes in 1 MiB blocks (no 'head -c' cut: under pipefail the cut dd's SIGPIPE ended the
  # script silently after head.img, 2026-11-12 — data.img is a MiB multiple, not a 4 MiB one)
  got=$("$DD" if="$DEV" bs=$MIB skip=$((off / MIB)) count=$((sz / MIB)) iflag=direct status=progress | sha256sum | cut -d' ' -f1)
  echo "$f: expected $want"; echo "$f: on disk  $got"
  [ "$got" = "$want" ] || fail "$f differs on the disk — the disk, cable or USB port is faulty"
done
partprobe "$DEV" 2>/dev/null || true

echo
echo "==================================================================="
echo "  SUCCESS: disk written and verified."
echo "  Plug it into the Raspberry Pi (blue USB 3 port), no SD card in the Pi,"
echo "  connect the screen, power on. The first boot sets everything up from"
echo "  the disk (no internet needed) — about 15 minutes, then the map appears."
echo "==================================================================="
