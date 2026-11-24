#!/bin/bash
# Runs ON the Pi as root (called by scripts/20-setup-pi.sh). Installs ONE built edition:
#   /tmp/nav-pi-build  = work/build/<edition> (app/, navd/, packages.txt, services.txt, edition.json)
#   /tmp/nav-pi-pi     = this folder (session, kiosk)
# Only the edition's packages and services are installed; services of features that are not in the
# edition are disabled. Re-runnable (also to switch edition).
set -euo pipefail
: "${VALHALLA_IMAGE:?}" "${PI_USER:?}"
# Region: the services read /srv/navdata/current (a link to the region folder, set by
# scripts/21-push-data.sh once all its data is verified), so switching region needs no setup re-run.
B=/tmp/nav-pi-build
bash "$(dirname "$0")/migrate-legacy-name.sh" "$PI_USER"   # a device installed under the earlier name pi-nav
has() { grep -qx "$1" "$B/services.txt"; }
THREADS=$(python3 -c 'import json;print(json.load(open("/tmp/nav-pi-build/edition.json"))["tuning"]["valhallaThreads"])')
export DEBIAN_FRONTEND=noninteractive
LOCAL=(); [ -f /var/lib/nav-pi/apt/sources.list ] && LOCAL=(-o Dir::Etc::SourceList=/var/lib/nav-pi/apt/sources.list \
  -o Dir::Etc::SourceParts=/var/lib/nav-pi/apt/parts -o Dir::State::Lists=/var/lib/nav-pi/apt/lists)   # pi/install-debs.sh
mapfile -t PKGS < <(grep -v "^[[:space:]]*$" "$B/packages.txt")
apt-get install -y -q --no-download "${LOCAL[@]}" "${PKGS[@]}" >/dev/null   # all from the bundle (step 1)
if grep -qx gpsd "$B/packages.txt"; then
  systemctl enable --now gpsd.socket >/dev/null 2>&1
  # a receiver plugged in BEFORE gpsd was installed was announced to nobody: replay the USB serial events so
  # gpsd's hotplug rule adopts it now (2026-11-12: Pi 4 saw the u-blox on ttyACM0, gpsd had no device)
  udevadm trigger --subsystem-match=tty --action=add 2>/dev/null || true
fi
loginctl enable-linger "$PI_USER"   # its PipeWire (sound, Bluetooth audio) runs from boot
# PipeWire/WirePlumber load the Bluetooth audio plugin only at start: restart them after installing it,
# otherwise BlueZ has no A2DP endpoint and speakers fail with "Protocol not available" (seen 2026-11-11)
U=$(id -u "$PI_USER")
sudo -u "$PI_USER" XDG_RUNTIME_DIR="/run/user/$U" systemctl --user restart pipewire pipewire-pulse wireplumber 2>/dev/null || true

install -d /opt/nav-pi /srv/navdata
rsync -a --delete "$B/app/" /opt/nav-pi/app/
rsync -a --delete --exclude app --exclude '__pycache__' "$B/navd/" /opt/nav-pi/navd/
install -m 0644 "$B/edition.json" /opt/nav-pi/edition.json
chown -R "$PI_USER:$PI_USER" /srv/navdata
# a Pi set up before the region link existed: link the one region folder it has (data pushed earlier)
if [ ! -e /srv/navdata/current ]; then
  mapfile -t R < <(for d in /srv/navdata/*/; do [ -d "$d/map" ] && [ -d "$d/valhalla" ] && basename "$d"; done)
  [ "${#R[@]}" = 1 ] && ln -sfn "${R[0]}" /srv/navdata/current && chown -h "$PI_USER:$PI_USER" /srv/navdata/current
fi

# Wi-Fi feature: navd runs as a service without a login session, so NetworkManager's polkit would refuse its nmcli
# calls ("Insufficient privileges"); this rule allows $PI_USER exactly the Wi-Fi actions (scan, connect, forget, radio)
if has wifi && [ -d /etc/polkit-1 ]; then
  install -d /etc/polkit-1/rules.d
  sed "s/@USER@/$PI_USER/" /tmp/nav-pi-pi/49-nav-pi-wifi.rules.in > /etc/polkit-1/rules.d/49-nav-pi-wifi.rules
  chmod 0644 /etc/polkit-1/rules.d/49-nav-pi-wifi.rules
else
  rm -f /etc/polkit-1/rules.d/49-nav-pi-wifi.rules
fi

# USB feature: the same for udisks2 (mount / unmount / power-off of removable drives, user $PI_USER only)
if has usb && [ -d /etc/polkit-1 ]; then
  install -d /etc/polkit-1/rules.d
  sed "s/@USER@/$PI_USER/" /tmp/nav-pi-pi/49-nav-pi-usb.rules.in > /etc/polkit-1/rules.d/49-nav-pi-usb.rules
  chmod 0644 /etc/polkit-1/rules.d/49-nav-pi-usb.rules
else
  rm -f /etc/polkit-1/rules.d/49-nav-pi-usb.rules
fi

# --- services (all bound to 127.0.0.1) ---
cat > /etc/systemd/system/nav-pi-tiles.service <<U
[Unit]
Description=nav-pi map tiles (pmtiles serve)
ConditionPathExists=/srv/navdata/current/map
[Service]
ExecStart=/usr/local/bin/pmtiles serve /srv/navdata/current/map --interface=127.0.0.1 --port=8081 --cache-size=256
Restart=always
User=$PI_USER
[Install]
WantedBy=multi-user.target
U
cat > /etc/systemd/system/nav-pi-valhalla.service <<U
[Unit]
Description=nav-pi routing (Valhalla, offline graph)
After=docker.service
Requires=docker.service
ConditionPathExists=/srv/navdata/current/valhalla/valhalla_tiles.tar
[Service]
ExecStartPre=-/usr/bin/docker rm -f nav-pi-valhalla
ExecStart=/usr/bin/docker run --rm --name nav-pi-valhalla -p 127.0.0.1:8002:8002 \
  -v /srv/navdata/current/valhalla:/custom_files:ro --entrypoint valhalla_service \
  $VALHALLA_IMAGE /custom_files/valhalla.json $THREADS
ExecStartPost=-/usr/local/lib/nav-pi/warm-valhalla.sh
ExecStop=/usr/bin/docker stop -t 5 nav-pi-valhalla
Restart=always
RestartSec=5
[Install]
WantedBy=multi-user.target
U
cat > /etc/systemd/system/nav-pi.service <<U
[Unit]
Description=nav-pi app service (navd)
After=network.target gpsd.socket bluetooth.service
[Service]
Environment=NAV_DATA=/srv/navdata APP_DIR=/opt/nav-pi/app EDITION_FILE=/opt/nav-pi/edition.json
Environment=XDG_RUNTIME_DIR=/run/user/$(id -u "$PI_USER") WAYLAND_DISPLAY=wayland-0
ExecStart=/usr/bin/python3 /opt/nav-pi/navd/navd.py
Restart=always
User=$PI_USER
[Install]
WantedBy=multi-user.target
U

# --- kiosk: greetd logs the user straight into labwc, which starts Chromium full screen ---
cat > /etc/greetd/config.toml <<U
[terminal]
vt = 7
# the head unit IS the default session: it comes back after every restart or crash
# (an [initial_session] runs only once per boot and would leave a text login after a restart)
[default_session]
command = "/opt/nav-pi/session.sh"
user = "$PI_USER"
U
H=$(getent passwd "$PI_USER" | cut -d: -f6)
install -d -o "$PI_USER" -g "$PI_USER" "$H/.config/labwc"
install -m 0755 /tmp/nav-pi-pi/kiosk.sh /opt/nav-pi/kiosk.sh
install -m 0755 /tmp/nav-pi-pi/session.sh /opt/nav-pi/session.sh
install -d /etc/nav-pi
[ -f /etc/nav-pi/session.env ] || printf '# BROWSER=chromium (default) or firefox (install firefox-esr first). Both measured ~60 fps map on Pi 5.\n' > /etc/nav-pi/session.env
# BROWSER_LANG (config.env, default de): the kiosk browser's own language (kiosk.sh: chromium --lang)
if [[ "${BROWSER_LANG:-}" =~ ^[a-z]{2,3}(-[A-Za-z0-9]{2,8})?$ ]]; then
  sed -i '/^BROWSER_LANG=/d' /etc/nav-pi/session.env; echo "BROWSER_LANG=$BROWSER_LANG" >> /etc/nav-pi/session.env
elif [ -n "${BROWSER_LANG:-}" ]; then echo "BROWSER_LANG='$BROWSER_LANG' is not a language code (e.g. de, en-GB): ignored"; fi
cat > "$H/.config/labwc/autostart" <<'U'
/opt/nav-pi/kiosk.sh &
U
chown -R "$PI_USER:$PI_USER" "$H/.config"

# --- system feature (all editions): brightness + restart/shut down for navd, minimal privilege ---
# backlight: group video may write brightness (the kernel creates the file root:root 0644 on some images);
# navd runs as $PI_USER, which is in group video
cat > /etc/udev/rules.d/90-nav-pi-backlight.rules <<'U'
SUBSYSTEM=="backlight", RUN+="/bin/chgrp video /sys/class/backlight/%k/brightness", RUN+="/bin/chmod g+w /sys/class/backlight/%k/brightness"
U
usermod -aG video "$PI_USER"
udevadm control --reload-rules 2>/dev/null || true
udevadm trigger --subsystem-match=backlight --action=change 2>/dev/null || true
# power: navd is a system service (no login session), so logind asks polkit; allow ONLY reboot + power-off for this user
install -d /etc/polkit-1/rules.d
cat > /etc/polkit-1/rules.d/50-nav-pi-power.rules <<U
polkit.addRule(function(action, subject) {
  if (subject.user == "$PI_USER" && /^org\.freedesktop\.login1\.(reboot|power-off)(-multiple-sessions)?\$/.test(action.id))
    return polkit.Result.YES;
});
U

# updates (system feature): polkit rule for the five nav-pi units + root oneshot units for apt / app update
bash /tmp/nav-pi-pi/install-updates.sh "$PI_USER" /tmp/nav-pi-pi

bash /tmp/nav-pi-pi/install-boot.sh "$PI_USER" /tmp/nav-pi-pi   # GPS clock helper + sudoers, gpsd OPTIONS, valhalla warm-up, no wait-online
systemctl daemon-reload
systemctl enable nav-pi greetd >/dev/null 2>&1
for s in tiles valhalla; do   # map services only if the edition has the nav feature
  if has "$s"; then systemctl enable "nav-pi-$s" >/dev/null 2>&1; else systemctl disable --now "nav-pi-$s" >/dev/null 2>&1 || true; fi
done
systemctl set-default graphical.target >/dev/null
for s in nav-pi-tiles nav-pi-valhalla; do systemctl is-enabled -q "$s" && { systemctl restart "$s" || true; }; done
systemctl restart nav-pi
systemctl restart greetd || true
sleep 3
echo "edition: $(python3 -c 'import json;e=json.load(open("/opt/nav-pi/edition.json"));print(e["name"],"-",e["hardware"],"-"," ".join(e["features"]))')"
for s in nav-pi-tiles nav-pi-valhalla nav-pi greetd; do printf '%-18s %s\n' "$s" "$(systemctl is-active "$s" || true)"; done
