#!/bin/bash
# greetd session for the head unit: Pi 5 graphics settings, then labwc (which runs kiosk.sh).
# Pi 5: the GPU (v3d) has no display; the DSI panel and the HDMI ports are separate DRM devices.
# If wlroots drives several of them it builds a multi-GPU renderer that copies every frame
# (measured: 1.7 fps). Driving only the device of the connected screen gives 58-60 fps.
# Settings: /etc/nav-pi/session.env (BROWSER=firefox|chromium, BROWSER_LANG=de, WLR_DRM_DEVICES=..., LABWC_DEBUG=1)
[ -r /etc/nav-pi/session.env ] && set -a && . /etc/nav-pi/session.env && set +a
if [ -z "${WLR_DRM_DEVICES:-}" ]; then
  pick=""
  for kind in DSI HDMI; do                                  # prefer the built-in panel
    for st in /sys/class/drm/card*-"$kind"-*/status; do
      [ -r "$st" ] && [ "$(cat "$st")" = connected ] || continue
      card=$(basename "$(dirname "$st")"); pick="/dev/dri/${card%%-*}"; break 2
    done
  done
  [ -n "$pick" ] && export WLR_DRM_DEVICES="$pick"
fi
export BROWSER=${BROWSER:-chromium}

# touch follows the screen when it is rotated: map every touchscreen to the connected output
OUTPUT=""
for st in /sys/class/drm/card*-*/status; do
  [ "$(cat "$st" 2>/dev/null)" = connected ] || continue
  c=$(basename "$(dirname "$st")"); [ "/dev/dri/${c%%-*}" = "${WLR_DRM_DEVICES:-}" ] || [ -z "${WLR_DRM_DEVICES:-}" ] || continue
  OUTPUT=${c#*-}; break                                       # e.g. card1-DSI-2 -> DSI-2
done
# PN-72 (2026-11-22): any touchscreen, not only known names — the kernel marks screens you touch directly with
# INPUT_PROP_DIRECT (bit 1 of "B: PROP=", e.g. eGalax, WaveShare, QDtech USB panels); the old name list stays as a fallback.
TOUCH=$(awk -F'"' '
  function out() { if (h && n != "" && (p ~ /[2367abefABEF]$/ || n ~ /[Tt]ouch|Goodix|ft5x|FT5|ILI|EDT/)) print n; n = ""; h = 0; p = "" }
  /^N: Name=/ {n = $2}
  /^H: Handlers=.*event/ {h = 1}
  /^B: PROP=/ {p = $0; sub(/^B: PROP=/, "", p)}
  /^$/ {out()}
  END {out()}' "${INPUT_DEVICES:-/proc/bus/input/devices}" | awk '!seen[$0]++')
mkdir -p "$HOME/.config/labwc"
{
  echo '<?xml version="1.0"?>'
  echo '<labwc_config>'
  echo '  <core><decoration>none</decoration></core>'
  echo '  <windowRules><windowRule identifier="*"><action name="Maximize"/></windowRule></windowRules>'
  while IFS= read -r t; do
    [ -n "$t" ] && [ -n "$OUTPUT" ] && echo "  <touch deviceName=\"$t\" mapToOutput=\"$OUTPUT\" mouseEmulation=\"no\"/>"
  done <<< "$TOUCH"
  echo '</labwc_config>'
} > "$HOME/.config/labwc/rc.xml"
exec labwc ${LABWC_DEBUG:+-d} 2>"${XDG_RUNTIME_DIR:-/tmp}/labwc.log"
