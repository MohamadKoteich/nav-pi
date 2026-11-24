#!/bin/bash
# Build the nav-pi SD-card image: official Raspberry Pi OS Lite + first-boot setup.
# No root needed. Output: work/nav-pi.img + work/nav-pi.img.sha256
#   bash scripts/01-build-image.sh
# Overrides (used by scripts/40-make-disk.sh): IMG_OUT=<file>, PI_HOSTNAME=<name>,
#   EXTRA_FAT="/path/on/boot=<local file> ..." (more files for the boot partition, e.g. cmdline.txt)
. "$(dirname "$0")/common.sh"

need xz "sudo apt install xz-utils"
need sha256sum "coreutils"
need python3 "sudo apt install python3"

need_offline
mkdir -p "$WORK_DIR"
XZ="$OFFLINE_DIR/os/$(basename "$PIOS_URL")"; BASE="$WORK_DIR/$(basename "${XZ%.xz}")"

say "1/5 Raspberry Pi OS image (from the offline bundle)"
[ -f "$XZ" ] || fail "OS image not in the bundle: $XZ"
(cd "$OFFLINE_DIR/os" && sha256sum -c "$(basename "$XZ").sha256") || fail "OS image checksum wrong — bundle damaged"
[ -f "$BASE" ] || xz -dcT0 "$XZ" > "$BASE"

say "2/5 SSH key"
if [ "${SSH_PUBKEY_FILE:-}" = none ]; then
  PUB=none; echo "SSH_PUBKEY_FILE=none: no SSH login on this device (SSH is turned off)"
else
  KEY=${SSH_PUBKEY_FILE:-$HOME/.ssh/id_ed25519.pub}
  if [ ! -f "$KEY" ] && [ -z "${SSH_PUBKEY_FILE:-}" ]; then
    echo "no SSH key yet — creating $HOME/.ssh/id_ed25519 (you may add a passphrase when asked)"
    ssh-keygen -t ed25519 -f "$HOME/.ssh/id_ed25519"
  fi
  [ -f "$KEY" ] || fail "SSH public key $KEY not found"
  PUB=$(head -1 "$KEY"); [[ $PUB == ssh-* ]] || fail "$KEY does not look like an SSH public key"
fi

say "3/5 first-boot files"
OUT=${IMG_OUT:-$IMG}
GEN="$OUT.generated"; [ -z "${IMG_OUT:-}" ] && GEN="$WORK_DIR/generated"; mkdir -p "$GEN"
sed -e "s|@PI_HOSTNAME@|$PI_HOSTNAME|g" -e "s|@PI_USER@|$PI_USER|g" -e "s|@TIMEZONE@|$TIMEZONE|g" \
    -e "s|@KEYBOARD_LAYOUT@|$KEYBOARD_LAYOUT|g" -e "s|@SSH_PUBKEY@|$PUB|g" \
    "$ROOT/templates/user-data.tmpl" > "$GEN/user-data"
if [ "$PUB" = none ]; then   # no key: drop the key entry, turn SSH off
  python3 - "$GEN/user-data" <<'PY'
import sys
p = sys.argv[1]; out = []
lines = open(p).read().split("\n")
for i, l in enumerate(lines):
    if l.strip() in ("ssh_authorized_keys:", "- none") or l.strip() == "- [systemctl, enable, --now, ssh]":
        continue
    if "Login: SSH key only" in l:
        l = "      Login: none. SSH is off and no password is set; reflash the card to change this."
    out.append(l.replace("enable_ssh: true", "enable_ssh: false"))
open(p, "w").write("\n".join(out))
PY
fi
grep -q @ "$GEN/user-data" && grep -n "@[A-Z_]*@" "$GEN/user-data" && fail "unfilled placeholder in user-data"
printf 'PI_USER=%s\n' "$PI_USER" > "$GEN/config.env"
python3 - "$GEN/user-data" <<'PY' || fail "user-data is not valid YAML"
import sys
try:
    import yaml
except ImportError:
    sys.exit(0)  # PyYAML not installed: skip the parse check
yaml.safe_load(open(sys.argv[1]))
PY

say "4/5 Python helper (pyfatfs, pinned)"
pc_venv

say "5/5 assemble image"
cp "$BASE" "$OUT.tmp"
# shellcheck disable=SC2206
EXTRA=(${EXTRA_FAT:-})
"$VENV/bin/python" "$ROOT/tools/fat_inject.py" "$OUT.tmp" \
  /user-data="$GEN/user-data" \
  /network-config="$ROOT/templates/network-config" \
  /nav-pi/firstboot.sh="$ROOT/pi/firstboot.sh" \
  /nav-pi/nav-pi-firstboot.service="$ROOT/pi/nav-pi-firstboot.service" \
  /nav-pi/config.env="$GEN/config.env" "${EXTRA[@]}"
# everything after the boot partition (the whole OS) must be byte-identical to the official image
P2=$(python3 -c "import struct,sys;d=open(sys.argv[1],'rb').read(512);print(struct.unpack('<I',d[462+8:462+12])[0]*512)" "$BASE")
cmp -i "$P2" "$OUT.tmp" "$BASE" || fail "OS partition differs from the official image"
cmp -n 1048576 "$OUT.tmp" "$BASE" || fail "partition table differs from the official image"
mv "$OUT.tmp" "$OUT"
(cd "$(dirname "$OUT")" && sha256sum "$(basename "$OUT")" > "$(basename "$OUT").sha256")
echo; echo "DONE: $OUT"; cat "$OUT.sha256"
echo "Next: insert the microSD card, then  sudo bash scripts/02-flash-sd.sh"
