#!/bin/bash
# nav-pi first-boot setup. Runs as a systemd oneshot on every boot
# until it succeeds once (/etc/nav-pi/first-boot-done). Log: /var/log/nav-pi-firstboot.log
set -u
exec >>/var/log/nav-pi-firstboot.log 2>&1
PI_USER=nav
# shellcheck disable=SC1091
[ -r /boot/firmware/nav-pi/config.env ] && . /boot/firmware/nav-pi/config.env
echo "=== $(date -Is) start"
mkdir -p /etc/nav-pi
rm -f /etc/nav-pi/first-boot-FAILED

# 1. root filesystem fills its partition (systemd-growfs can fail; resize2fs is idempotent)
ROOTDEV=$(findmnt -n -o SOURCE /)
resize2fs "$ROOTDEV" || echo "resize2fs failed (continuing)"
df -h /

# 2. self-contained disk (scripts/40-make-disk.sh): a data partition LABEL=navdata holds the region data
#    and the kit. It is the last partition: grow it to the end of the disk, mount it at /srv/navdata.
NAVP=$(blkid -L navdata 2>/dev/null || true)
if [ -n "$NAVP" ]; then
  grep -q '^LABEL=navdata ' /etc/fstab || echo 'LABEL=navdata /srv/navdata ext4 defaults,noatime,nofail,x-systemd.device-timeout=30s 0 2' >> /etc/fstab
  DISK=/dev/$(lsblk -no pkname "$NAVP"); NUM=$(cat "/sys/class/block/$(basename "$NAVP")/partition")
  growpart "$DISK" "$NUM" || echo "data partition not grown (already full size?)"
  install -d /srv/navdata
  mountpoint -q /srv/navdata || mount /srv/navdata
  resize2fs "$NAVP" || echo "resize2fs data failed (continuing)"
  df -h /srv/navdata
fi

# 3. integrity, measured once before anything else is installed: every file of the OS's packages must match its
#    dpkg checksum (a faulty card or card reader shows up here). scripts/03-check-pi.sh reads the result;
#    Raspberry Pi OS itself replaces 2 files (usr/lib/modprobe.d/g_ether.conf, usr/lib/python3.13/EXTERNALLY-MANAGED).
if [ ! -s /etc/nav-pi/integrity ]; then
  (cd / && for f in /var/lib/dpkg/info/*.md5sums; do md5sum -c --quiet "$f" 2>/dev/null; done) \
    | sed -n 's/: FAILED.*//p' > /etc/nav-pi/integrity.files || true
  echo "dpkg checksum failures: $(wc -l < /etc/nav-pi/integrity.files)" > /etc/nav-pi/integrity
  cat /etc/nav-pi/integrity /etc/nav-pi/integrity.files
fi

# Offline design: first boot installs NOTHING from the internet. On a plain card the packages, the routing
# image and the app come from the PC (scripts/20-setup-pi.sh); on a self-contained disk from the disk itself.
systemctl enable --now gpsd.socket 2>/dev/null || true
install -d -o "$PI_USER" -g "$PI_USER" /srv/navdata
if [ -f /srv/navdata/kit/pi/setup-local.sh ] && [ ! -f /etc/nav-pi/setup-done ]; then
  if bash /srv/navdata/kit/pi/setup-local.sh; then
    touch /etc/nav-pi/setup-done
  else
    touch /etc/nav-pi/first-boot-FAILED; echo "=== $(date -Is) setup-local FAILED (retried next boot)"; exit 1
  fi
fi
touch /etc/nav-pi/first-boot-done
echo "=== $(date -Is) done (offline first boot)"
exit 0
