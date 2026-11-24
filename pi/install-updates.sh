#!/bin/bash
# Root. Installs the update machinery of the system feature (PN-22/23): the polkit rule that lets navd (user $1) manage only
# the five nav-pi units, two root oneshot units and their scripts. Called by install-runtime.sh and scripts/22-update-app.sh
# with the folder holding these files as $2 (default: next to this script).   install-updates.sh <user> [pi-folder]
# NAV_PI_ROOT=<mounted root partition>: install onto a card plugged into a PC instead (scripts/43-update-card.sh).
set -euo pipefail
U=${1:?user}; P=${2:-$(dirname "$0")}; R=${NAV_PI_ROOT:-}
if [ -n "$R" ]; then OWN=$(awk -F: -v u="$U" '$1==u{print $3":"$4}' "$R/etc/passwd"); [ -n "$OWN" ] || { echo "no user $U on $R" >&2; exit 1; }
else OWN="$U:$U"; fi
install -d "$R/usr/local/lib/nav-pi" "$R/var/lib/nav-pi" "$R/srv/navdata/updates"
chown "$OWN" "$R/srv/navdata/updates"
install -m 0755 "$P/os-update.sh" "$P/apply-app-update.sh" "$R/usr/local/lib/nav-pi/"
install -m 0644 "$P/nav-pi-os-update.service" "$P/nav-pi-app-update.service" "$R/etc/systemd/system/"
if [ -d "$R/etc/polkit-1" ]; then
  install -d "$R/etc/polkit-1/rules.d"
  sed "s/@USER@/$U/" "$P/50-nav-pi-update.rules.in" > "$R/etc/polkit-1/rules.d/50-nav-pi-update.rules"
  chmod 0644 "$R/etc/polkit-1/rules.d/50-nav-pi-update.rules"
fi
[ -n "$R" ] || systemctl daemon-reload
