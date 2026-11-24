#!/bin/bash
# Root helper for navd's GPS clock (features/gps/navd_gps.py sync_clock), run as `sudo -n` by user nav only.
#   set-clock.sh set <epoch-seconds>   step the system clock to that UTC time (refuses before 2026-11-01 or > 20 years ahead)
#   set-clock.sh save                  remember "now" for the next boot (touch timesyncd's clock file)
# `date -s` instead of `timedatectl set-time`: timedated refuses SetTime while NTP is enabled, the normal state here.
set -eu
FLOOR=1793491200
STAMP=/var/lib/systemd/timesync/clock
save() { [ -d "$(dirname "$STAMP")" ] || install -d "$(dirname "$STAMP")"; touch "$STAMP"; }
case "${1:-}" in
  set)
    T=${2:-}
    [[ "$T" =~ ^[0-9]{10}$ ]] || { echo "bad time" >&2; exit 2; }
    [ "$T" -ge "$FLOOR" ] && [ "$T" -le $(( $(date +%s) + 631152000 )) ] || { echo "time out of range" >&2; exit 2; }
    date -u -s "@$T" >/dev/null
    save ;;
  save)
    [ "$(date +%s)" -ge "$FLOOR" ] || exit 2   # never remember a stale clock
    save ;;
  *) echo "usage: set-clock.sh set <epoch> | save" >&2; exit 2 ;;
esac
