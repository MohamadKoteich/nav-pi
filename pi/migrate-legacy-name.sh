#!/bin/bash
# Root, ON the device. Moves an installation made under the project's earlier name "pi-nav" to the
# current name "nav-pi", keeping its data and settings. Idempotent: does nothing on a device that has
# no trace of the old name. Called by install-runtime.sh and scripts/22-update-app.sh before they install.
#   bash migrate-legacy-name.sh <user>
# What moves:   /opt, /etc, /var/lib, /boot/firmware folders; the browser profiles in the user's ~/.config
#               (the app copies its stored "pinav.*" settings to "navpi.*" on its first start, core/util.js)
# What goes:    the old systemd units, polkit/udev rules, sudoers file, Chromium policy, routing container
#               (the installer that runs next writes the new ones)
# What stays:   the hostname (change it yourself if you want: sudo hostnamectl hostname nav-pi), /srv/navdata
set -uo pipefail
U=${1:?user}
OLD=pi-nav NEW=nav-pi
R=${MIGRATE_ROOT:-}                       # tests run it on a fake root folder
H=$R${MIGRATE_HOME:-$(getent passwd "$U" | cut -d: -f6)}

shopt -s nullglob
units=("$R"/etc/systemd/system/"$OLD"*.service)
dirs=()
for d in "$R"/opt/$OLD "$R"/etc/$OLD "$R"/var/lib/$OLD "$R"/usr/local/lib/$OLD "$R"/boot/firmware/$OLD \
         "$H/.config/$OLD-chromium" "$H/.config/$OLD-firefox"; do [ -e "$d" ] && dirs+=("$d"); done
if [ "${#units[@]}" = 0 ] && [ "${#dirs[@]}" = 0 ]; then exit 0; fi
echo "migrating the installation from '$OLD' to '$NEW'"

for u in "${units[@]}"; do systemctl disable --now "$(basename "$u")" >/dev/null 2>&1 || true; done
command -v docker >/dev/null && docker rm -f "$OLD-valhalla" >/dev/null 2>&1 || true
# the local routing image tag (load-valhalla.sh): keep the image, give it the new tag
if command -v docker >/dev/null && docker image inspect "$OLD/valhalla:3.5.1" >/dev/null 2>&1; then
  docker tag "$OLD/valhalla:3.5.1" "$NEW/valhalla:3.5.1" && docker rmi "$OLD/valhalla:3.5.1" >/dev/null 2>&1 || true
fi

move() {   # move <old> <new>: only if the new one does not exist yet (never overwrite)
  [ -e "$1" ] || return 0
  if [ -e "$2" ]; then echo "  keep $2 (exists); old $1 left in place"; else mv "$1" "$2" && echo "  $1 -> $2"; fi
}
move "$R"/opt/$OLD "$R"/opt/$NEW
move "$R"/etc/$OLD "$R"/etc/$NEW
move "$R"/var/lib/$OLD "$R"/var/lib/$NEW
move "$R"/boot/firmware/$OLD "$R"/boot/firmware/$NEW
move "$H/.config/$OLD-chromium" "$H/.config/$NEW-chromium"
move "$H/.config/$OLD-firefox" "$H/.config/$NEW-firefox"
rm -rf "$R"/usr/local/lib/$OLD
for f in "$R"/var/log/$OLD-*.log; do move "$f" "${f/\/$OLD-//$NEW-}"; done

# old system files (the installer writes the new ones)
rm -f "$R"/etc/systemd/system/"$OLD"*.service
rm -rf "$R"/etc/systemd/system/"$OLD"*.service.d
find "$R"/etc/systemd/system -name "$OLD*.service" -type l -delete 2>/dev/null
rm -f "$R"/etc/polkit-1/rules.d/*"$OLD"*.rules "$R"/etc/udev/rules.d/*"$OLD"*.rules "$R"/etc/sudoers.d/"$OLD"-* \
      "$R"/etc/chromium/policies/managed/"$OLD".json
systemctl daemon-reload
udevadm control --reload-rules 2>/dev/null || true
echo "migration done"
