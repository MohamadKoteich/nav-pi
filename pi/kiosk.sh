#!/bin/bash
# Exit as soon as the labwc session that started us is gone (otherwise, after a session
# restart, orphaned loops keep relaunching browsers without a display — seen: 143 processes).
LABWC_PID=$(pgrep -n -u "$(id -u)" -x labwc)
alive() { [ -S "$XDG_RUNTIME_DIR/$WAYLAND_DISPLAY" ] && kill -0 "$LABWC_PID" 2>/dev/null; }
# Started by labwc: screen setup, then the head unit full screen. Restarts the browser if it exits.
# The screen = the connected output (PN-72, 2026-11-22: was DSI only, so an HDMI screen could not be rotated): a DSI panel
# first, then HDMI / eDP / DP, then whatever wlroots shows. session.sh already limits wlroots to the screen's DRM device.
RANDR=$(wlr-randr 2>/dev/null)
OUTS=$(printf '%s\n' "$RANDR" | awk '/^[^ \t]/{o=$1} /^[ \t]+Enabled: yes/{print o}')
[ -n "$OUTS" ] || OUTS=$(printf '%s\n' "$RANDR" | awk '/^[^ \t]/{print $1}')   # older wlr-randr: no "Enabled:" line
OUT=$(printf '%s\n' "$OUTS" | grep -m1 '^DSI' || printf '%s\n' "$OUTS" | grep -m1 -E '^(HDMI|eDP|DP)' || printf '%s\n' "$OUTS" | head -n1)
# panel size from the EDID ("Physical size: 155x86 mm") -> ?mm=155x86: core/scale.js scales up only panels denser than the 5" Touch Display 2 (~295 ppi)
MM=$(printf '%s\n' "$RANDR" | awk -v o="$OUT" '/^[^ \t]/{f=($1==o)} f&&/Physical size:/{print $3; exit}')
[[ "$MM" =~ ^[1-9][0-9]*x[1-9][0-9]*$ ]] || MM=""
# normal | 90 | 180 | 270, chosen in Settings. Default = landscape: a portrait-native panel (Touch Display 2,
# 720x1280) is turned 90; a landscape-native one (the original 7" 800x480, HDMI) stays as it is.
ROT=$(cat /srv/navdata/rotation 2>/dev/null || true)
if [ -z "$ROT" ]; then
  MODE=$(printf '%s\n' "$RANDR" | awk -v o="$OUT" '$1==o{f=1} f&&/current/{print $1; exit}')
  W=${MODE%x*}; H=${MODE#*x}
  if [ -n "$OUT" ] && [ -n "$MODE" ] && [ "${H:-0}" -gt "${W:-0}" ]; then ROT=90; else ROT=normal; fi
fi
[ -n "$OUT" ] && wlr-randr --output "$OUT" --transform "$ROT"
until curl -fs -o /dev/null http://127.0.0.1:8080/; do sleep 1; done
URL="http://127.0.0.1:8080/?kiosk=1${MM:+&mm=$MM}${KIOSK_QUERY:+&$KIOSK_QUERY}"
if [ "${BROWSER:-chromium}" = firefox ]; then
  P="$HOME/.config/nav-pi-firefox"; mkdir -p "$P"
  cat > "$P/user.js" <<'PREFS'
user_pref("browser.aboutwelcome.enabled", false);
user_pref("browser.shell.checkDefaultBrowser", false);
user_pref("browser.startup.homepage_override.mstone", "ignore");
user_pref("datareporting.policy.dataSubmissionEnabled", false);
user_pref("toolkit.telemetry.reportingpolicy.firstRun", false);
user_pref("browser.sessionstore.resume_from_crash", false);
user_pref("browser.translations.enable", false);
user_pref("signon.rememberSignons", false);
user_pref("signon.autofillForms", false);
user_pref("extensions.formautofill.addresses.enabled", false);
user_pref("extensions.formautofill.creditCards.enabled", false);
user_pref("permissions.default.desktop-notification", 2);
user_pref("permissions.default.geo", 2);
user_pref("gfx.webrender.all", true);
user_pref("webgl.force-enabled", true);
user_pref("media.autoplay.default", 0);
user_pref("app.update.enabled", false);
user_pref("extensions.pocket.enabled", false);
user_pref("browser.newtabpage.enabled", false);
user_pref("network.captive-portal-service.enabled", false);
user_pref("network.connectivity-service.enabled", false);
PREFS
  # no pinch/double-tap page zoom: a zoomed kiosk cuts off the screen edges and cannot be undone by touch
  cat >> "$P/user.js" <<'PREFS'
user_pref("apz.allow_zooming", false);
user_pref("apz.allow_double_tap_zooming", false);
user_pref("browser.gesture.pinch.in", "");
user_pref("browser.gesture.pinch.out", "");
PREFS
  while alive; do MOZ_ENABLE_WAYLAND=1 firefox-esr --kiosk --profile "$P" "$URL"; sleep 2; done
fi
# Reset any page zoom Chromium remembered for the app (per-host zoom levels / default zoom).
PREF="$HOME/.config/nav-pi-chromium/Default/Preferences"
[ -f "$PREF" ] && python3 - "$PREF" <<'PY' || true
import json, sys
p = sys.argv[1]; d = json.load(open(p))
pa = d.get("partition", {}); changed = bool(pa.pop("per_host_zoom_levels", None)) | bool(pa.pop("default_zoom_level", None))
if changed: json.dump(d, open(p, "w"))
PY
while alive; do
  # CHROMIUM_BIN / CHROMIUM_FLAGS_EXTRA / BROWSER_LANG come from /etc/nav-pi/session.env (see session.sh)
  # shellcheck disable=SC2086
  ${CHROMIUM_BIN:-chromium} $CHROMIUM_FLAGS_EXTRA --kiosk --noerrdialogs --disable-infobars --no-first-run --disable-session-crashed-bubble \
    --ozone-platform=wayland --password-store=basic --disable-features=Translate,TranslateUI --lang="${BROWSER_LANG:-de}" \
    --disable-pinch --overscroll-history-navigation=0 --disable-pull-to-refresh-effect \
    --remote-debugging-port=9222 \
    --user-data-dir="$HOME/.config/nav-pi-chromium" "$URL"
  sleep 2
done
