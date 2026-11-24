#!/bin/bash
# Hand a device over: remove EVERY SSH key from it and turn SSH off for good. Afterwards nobody can log in
# (the device has no password either); app and map updates still work from a USB stick (Settings > System > Updates).
# To get access back, reflash the card or disk.
#   bash scripts/24-lock-device.sh [host]
. "$(dirname "$0")/common.sh"
HOST=${1:-$PI_HOSTNAME.local}
SSH=(ssh -o BatchMode=yes -o ConnectTimeout=5 "$PI_USER@$HOST")
"${SSH[@]}" true || fail "no SSH to $HOST"
echo "This removes all SSH keys from $HOST and turns SSH off. You will not be able to log in again."
if [ "${YES:-}" != 1 ]; then read -r -p "Type LOCK to continue: " a; [ "$a" = LOCK ] || fail "nothing changed"; fi
# shellcheck disable=SC2016
"${SSH[@]}" 'sudo sh -c "
  rm -f /root/.ssh/authorized_keys /home/*/.ssh/authorized_keys /etc/ssh/authorized_keys* 2>/dev/null
  systemctl disable ssh.service ssh.socket >/dev/null 2>&1
  printf \"SSH turned off on %s by scripts/24-lock-device.sh\n\" \"\$(date -Is)\" >> /etc/nav-pi/README
  ls /home/*/.ssh/authorized_keys 2>/dev/null; systemctl is-enabled ssh.service ssh.socket 2>/dev/null; true
"; (sleep 2; sudo systemctl stop ssh.socket ssh.service) >/dev/null 2>&1 &' || true
sleep 4
if "${SSH[@]}" true 2>/dev/null; then fail "SSH still answers on $HOST — check by hand"; fi
echo "DONE: $HOST has no SSH keys and SSH is off."
