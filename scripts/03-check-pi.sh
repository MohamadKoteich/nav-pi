#!/bin/bash
# After the first boot: wait for the Pi, then report whether its setup finished and is healthy.
#   bash scripts/03-check-pi.sh            (uses <PI_HOSTNAME>.local)
#   bash scripts/03-check-pi.sh 192.168.1.50
. "$(dirname "$0")/common.sh"
HOST=${1:-$PI_HOSTNAME.local}
SSH=(ssh -o StrictHostKeyChecking=accept-new -o ConnectTimeout=5 -o BatchMode=yes "$PI_USER@$HOST")

say "waiting for $HOST to answer SSH (up to 20 min)"
for i in $(seq 1 120); do
  ssh_ok "${SSH[@]}" && break
  [ "$i" = 120 ] && fail "no SSH on $HOST. Is Ethernet plugged in? Find the Pi's address in your router and run:  bash $0 <address>"
  sleep 10
done
echo "SSH OK"

say "waiting for the first-boot setup to finish (offline, a few minutes: it also checks every OS file)"
for i in $(seq 1 120); do
  st=$("${SSH[@]}" 'if [ -e /etc/nav-pi/first-boot-done ]; then echo done; elif [ -e /etc/nav-pi/first-boot-FAILED ]; then echo failed; else echo running; fi')
  [ "$st" != running ] && break
  sleep 15
done
[ "$st" = "done" ] || { "${SSH[@]}" 'sudo tail -30 /var/log/nav-pi-firstboot.log'; fail "first-boot setup $st (log above). Rebooting the Pi retries it: ssh $PI_USER@$HOST sudo reboot"; }

say "health report"
"${SSH[@]}" 'bash -s' <<'R'
ok=1
echo "model:      $(tr -d '\0' </proc/device-tree/model)"
echo "memory:     $(free -h | awk '/Mem:/{print $2}')"
echo "disk /:     $(df -h / | awk 'NR==2{print $2" total, "$4" free"}')"
# integrity (pi/firstboot.sh): files whose dpkg checksum failed. Raspberry Pi OS itself replaces exactly these two.
if [ -s /etc/nav-pi/integrity ] && [ -f /etc/nav-pi/integrity.files ]; then
  bad=$(grep -vxE 'usr/lib/modprobe\.d/g_ether\.conf|usr/lib/python3\.[0-9]+/EXTERNALLY-MANAGED' /etc/nav-pi/integrity.files || true)
  if [ -z "$bad" ]; then echo "integrity:  OK — $(cat /etc/nav-pi/integrity) (Raspberry Pi OS's own 2 replaced files are normal)"
  else echo "integrity:  BAD — $(cat /etc/nav-pi/integrity), unexpected: $(echo "$bad" | head -5 | tr '\n' ' ')— card or reader faulty: reflash."; ok=0; fi
else
  echo "integrity:  not measured (card made by an older kit)"
fi
e=$(sudo dmesg | grep -ciE "ext4.*error|mmc.*(error|timeout)"); echo "disk errors: $e"; [ "$e" = 0 ] || ok=0
sudo -n true && echo "sudo:       ok" || { echo "sudo:       BROKEN"; ok=0; }
# packages arrive with scripts/20-setup-pi.sh (offline bundle), so they are not checked here
echo "display:    $(cat /sys/class/drm/card*-DSI-*/modes 2>/dev/null | head -1 || echo none) $(ls /sys/class/drm | grep -o 'DSI-[0-9]' | head -1)"
echo "GPS:        $(ls /dev/ttyACM* /dev/ttyUSB* 2>/dev/null | tr '\n' ' ' || true)$(timeout 5 gpspipe -w -n 6 2>/dev/null | grep -o '"mode":[0-3]' | tail -1)  (mode 2/3 = fix; none = no receiver plugged in)"
echo "temp:       $(vcgencmd measure_temp 2>/dev/null)"
[ $ok = 1 ] && echo "RESULT: HEALTHY" || echo "RESULT: PROBLEMS (see above)"
R
