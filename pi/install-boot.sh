#!/bin/bash
# Root, idempotent. The small boot/clock items that live outside the one-time setup, so an existing Pi gets them from
# scripts/22-update-app.sh too (called there and by install-runtime.sh).   install-boot.sh <user> [pi-folder]
# NAV_PI_ROOT=<mounted root partition>: install onto a card plugged into a PC instead (scripts/43-update-card.sh).
set -euo pipefail
U=${1:?user}; P=${2:-$(dirname "$0")}; B=${NAV_PI_BUILD:-/tmp/nav-pi-build}; R=${NAV_PI_ROOT:-}
install -d "$R/usr/local/lib/nav-pi"
install -m 0755 "$P/set-clock.sh" "$P/warm-valhalla.sh" "$R/usr/local/lib/nav-pi/"

# kiosk browser: no save-password / autofill / translate / notification / sign-in prompts, ever (managed policy;
# Chromium ignores autocomplete="off" for its save-password bubble)
install -D -m 0644 "$P/chromium-policy.json" "$R/etc/chromium/policies/managed/nav-pi.json"

# GPS clock (gps feature): user $U may run exactly the clock helper as root, nothing else
has_gps() { local e; for e in "$B/edition.json" "$R/opt/nav-pi/edition.json"; do
  [ -f "$e" ] && { python3 -c 'import json,sys; sys.exit(0 if "gps" in json.load(open(sys.argv[1]))["features"] else 1)' "$e"; return; }; done; return 1; }
if has_gps; then   # gps is a feature, not a service: services.txt never lists it
  S="$R/etc/sudoers.d/nav-pi-clock"
  printf '%s ALL=(root) NOPASSWD: /usr/local/lib/nav-pi/set-clock.sh\n' "$U" > "$S.tmp"
  chmod 0440 "$S.tmp"
  if visudo -cf "$S.tmp" >/dev/null; then mv "$S.tmp" "$S"; else rm -f "$S.tmp"; echo "sudoers check failed: no GPS clock" >&2; fi
else
  rm -f "$R/etc/sudoers.d/nav-pi-clock"
fi

# gpsd: "Referenced but unset environment variable OPTIONS" at boot (Debian's unit expands $OPTIONS)
touch "$R/etc/default/gpsd"
grep -q '^OPTIONS=' "$R/etc/default/gpsd" || printf 'OPTIONS=""\n' >> "$R/etc/default/gpsd"

# valhalla warm-up after start (never blocks, never fails the unit)
V="$R/etc/systemd/system/nav-pi-valhalla.service"
if [ -f "$V" ] && ! grep -q warm-valhalla "$V"; then
  sed -i '/^ExecStop=/i ExecStartPost=-/usr/local/lib/nav-pi/warm-valhalla.sh' "$V"
fi

# an offline device does not wait for the network at boot (~6 s). Nothing of nav-pi needs network-online.target:
# first boot is offline by design, the OS update is started by the user on a working network, valhalla/tiles/navd are local.
if [ -n "$R" ]; then
  systemctl --root="$R" disable NetworkManager-wait-online.service >/dev/null 2>&1 || true
else
  systemctl disable NetworkManager-wait-online.service >/dev/null 2>&1 || true
  systemctl daemon-reload
fi
