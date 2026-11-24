#!/bin/bash
# Root, run by nav-pi-app-update.service only. Applies the bundle navd verified and staged in $STAGED (SHA256SUMS re-checked
# here): app/ and navd/ are rsynced into /opt/nav-pi, edition.json replaced, then navd restarts. The previous app+navd are kept
# in $S/app-prev (one generation, manual roll-back: rsync it back). Never touches this script, the units or the polkit rules:
# those change only with scripts/20-setup-pi.sh or 22-update-app.sh.
S=${STATE_DIR:-/var/lib/nav-pi}; OPT=${OPT_DIR:-/opt/nav-pi}; STAGED=${STAGED_DIR:-/srv/navdata/updates/app-staged}
install -d -m 0755 "$S"; : > "$S/app-update.log"; chmod 0644 "$S/app-update.log"
exec >>"$S/app-update.log" 2>&1
fail() { echo "FAILED: $*"; echo "failed $(date +%FT%T)" > "$S/app-update.state"; exit 1; }
[ "$(cat "$STAGED/ACTION" 2>/dev/null)" = update ] || fail "nothing staged"
( cd "$STAGED" && sha256sum -c --quiet SHA256SUMS ) || fail "checksum mismatch in the staged files"
[ -d "$STAGED/app" ] && [ -d "$STAGED/navd" ] && [ -f "$STAGED/edition.json" ] || fail "incomplete bundle"
echo "running $(date +%FT%T)" > "$S/app-update.state"
rm -rf "$S/app-prev"; install -d "$S/app-prev"
cp -a "$OPT/app" "$OPT/navd" "$OPT/edition.json" "$S/app-prev/" || fail "backup failed"
rsync -a --delete "$STAGED/app/" "$OPT/app/" || fail "rsync app"
rsync -a --delete --exclude __pycache__ "$STAGED/navd/" "$OPT/navd/" || fail "rsync navd"
install -m 0644 "$STAGED/edition.json" "$OPT/edition.json" || fail "edition.json"
rm -rf "$STAGED"
echo "done $(date +%FT%T)" > "$S/app-update.state"
echo "applied; restarting navd"
[ -n "${NO_RESTART:-}" ] || systemctl restart --no-block nav-pi
