# shellcheck shell=bash
# Shared by all nav-pi scripts: load config.env, resolve paths, helpers.
set -euo pipefail
ROOT=$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)
# NAVPI_CONFIG=<file> uses another settings file (e.g. one per region); default config.env, else the example
CONFIG_FILE=${NAVPI_CONFIG:-$ROOT/config.env}
[ -f "$CONFIG_FILE" ] || { [ -z "${NAVPI_CONFIG:-}" ] || { echo "NAVPI_CONFIG=$NAVPI_CONFIG not found"; exit 1; }; CONFIG_FILE=$ROOT/config.env.example; }
# any setting given on the command line (KEY=value bash scripts/…) wins over the file, if it is not empty
_ENV_K=(); _ENV_V=()
while IFS= read -r _k; do
  if [ -n "${!_k:-}" ]; then _ENV_K+=("$_k"); _ENV_V+=("${!_k}"); fi
done < <(sed -n 's/^\([A-Za-z_][A-Za-z0-9_]*\)=.*/\1/p' "$CONFIG_FILE" "$ROOT/config.env.example" | sort -u)
# shellcheck disable=SC1090
. "$CONFIG_FILE"
for _i in "${!_ENV_K[@]}"; do printf -v "${_ENV_K[$_i]}" '%s' "${_ENV_V[$_i]}"; done
unset _ENV_K _ENV_V _k _i
EDITION=${EDITION:-}; HARDWARE=${HARDWARE:-}; FORCE_EDITION=${FORCE_EDITION:-0}
# language of the kiosk browser itself (Chromium --lang: its own dialogs, Accept-Language); the app's language is
# chosen on the device (Settings > System > Language). pi/install-runtime.sh stores it in /etc/nav-pi/session.env.
BROWSER_LANG=${BROWSER_LANG:-de}
# routing engine on the Pi: the arm64 image's own ID (= config digest in offline/pi-docker/*.tar.gz manifest)
# and the local name the services run it by (pi/load-valhalla.sh; a saved image loses its registry reference)
VALHALLA_IMAGE_ID_ARM64=${VALHALLA_IMAGE_ID_ARM64:-sha256:a8c22df311f277c4866b3ba9de771c4675ec4ed50a5d1cc1d145ee3bf62530dd}
VALHALLA_TAG=${VALHALLA_TAG:-nav-pi/valhalla:3.5.1}
case "$WORK_DIR" in /*) ;; *) WORK_DIR="$ROOT/${WORK_DIR#./}";; esac
export IMG="$WORK_DIR/nav-pi.img"
# Offline bundle = the offline/ folder of this kit: everything setup needs, so no step uses the internet.
export OFFLINE_DIR="${OFFLINE_DIR:-$ROOT/offline}"
need_offline() { [ -f "$OFFLINE_DIR/SHA256SUMS" ] || fail "offline bundle missing: $OFFLINE_DIR — it travels with the kit folder (see offline/README.md)"; }
fail() { echo; echo "########## STOP: $* ##########"; exit 1; }
say()  { echo; echo ">>> $*"; }
need() { command -v "$1" >/dev/null || fail "missing program '$1' — install it ($2)"; }
# The PC's Python helper (pyfatfs, pinned; from the offline bundle's wheels): creates work/.venv if needed, sets VENV.
pc_venv() {
  VENV="$WORK_DIR/.venv"
  python3 -c 'import venv, ensurepip' 2>/dev/null || fail "python3 venv missing — sudo apt install python3-venv"
  [ -x "$VENV/bin/python" ] || python3 -m venv "$VENV" || fail "could not create $VENV"
  "$VENV/bin/pip" install -q --no-index --find-links "$OFFLINE_DIR/pc-wheels" -r "$ROOT/tools/requirements.txt" \
    || fail "Python helper packages not installed (offline bundle: $OFFLINE_DIR/pc-wheels)"
}
# ssh_ok <ssh command + options...> <user@host>: true if SSH logs in (quietly). A changed host key (the card was
# reflashed: same name, new key) stops at once instead of looking like a network problem.
ssh_ok() {
  local err rc=0 h=${*: -1}
  err=$("$@" true 2>&1 >/dev/null) || rc=$?
  if [ "$rc" != 0 ] && grep -q "REMOTE HOST IDENTIFICATION HAS CHANGED" <<<"$err"; then
    h=${h#*@}
    fail "the SSH host key of $h has changed (normal after reflashing the card). Forget the old key, then run this again:  ssh-keygen -R $h"
  fi
  return "$rc"
}

# Build the edition for the Pi at $1: reads its model + RAM, picks the hardware profile, builds
# work/build/<edition>. EDITION / HARDWARE from config.env (empty = the profile's default / auto).
# Sets BUILD_DIR. FORCE_EDITION=1 allows an edition above the board's limit.
build_for_pi() {
  local host=$1 model ram ed args
  model=$(ssh -o BatchMode=yes "$PI_USER@$host" "tr -d '\0' < /proc/device-tree/model 2>/dev/null || uname -m")
  ram=$(ssh -o BatchMode=yes "$PI_USER@$host" "awk '/MemTotal/{print int(\$2/1024)}' /proc/meminfo")
  ed=${EDITION:-}
  # keep the edition the Pi already runs (the profile default is only for a first install); the hardware profile is
  # never taken from there: a card moved from a Pi 5 to a Pi 4 must get the Pi 4 profile (detected from the board)
  [ -z "$ed" ] && ed=$(ssh -o BatchMode=yes "$PI_USER@$host" "f=/opt/nav-pi/edition.json; [ -f \$f ] || f=/opt/pi-nav/edition.json; python3 -c 'import json,sys; print(json.load(open(sys.argv[1]))[\"edition\"])' \$f 2>/dev/null" || true)
  if [ -n "$ed" ] && [ -z "${EDITION:-}" ]; then
    python3 "$ROOT/tools/build_edition.py" --edition "$ed" --model "$model" --ram "$ram" ${HARDWARE:+--hardware "$HARDWARE"} --check >/dev/null 2>&1 \
      || { echo "installed edition $ed does not fit this board: using the board's default"; ed=; }
  fi
  if [ -z "$ed" ]; then
    ed=$(python3 - "$ROOT" "$model" "$ram" "${HARDWARE:-}" <<'PY'
import sys; sys.path.insert(0, sys.argv[1] + "/tools")
import build_edition as b
print(b.pick_hardware(sys.argv[4] or None, sys.argv[2], int(sys.argv[3]))[1]["DEFAULT_EDITION"])
PY
)
  fi
  args=(--edition "$ed" --model "$model" --ram "$ram" --out "$WORK_DIR/build/$ed")
  [ -n "${HARDWARE:-}" ] && args+=(--hardware "$HARDWARE")
  [ "${FORCE_EDITION:-0}" = 1 ] && args+=(--force)
  echo "board: $model, ${ram} MB RAM"
  python3 "$ROOT/tools/build_edition.py" "${args[@]}" || fail "edition build refused (see above)"
  export BUILD_DIR="$WORK_DIR/build/$ed"
}
