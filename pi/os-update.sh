#!/bin/bash
# Root, run by nav-pi-os-update.service only. apt over Wi-Fi; never automatic (navd starts it on a tap while parked).
# State for navd/UI: $STATE_DIR/os-update.state ("running|done|failed <rc> <time>"), log: $STATE_DIR/os-update.log.
S=${STATE_DIR:-/var/lib/nav-pi}; APT=${APT_GET:-apt-get}
install -d -m 0755 "$S"; : > "$S/os-update.log"; chmod 0644 "$S/os-update.log"
exec >>"$S/os-update.log" 2>&1
now() { date +%FT%T; }
echo "running $(now)" > "$S/os-update.state"; chmod 0644 "$S/os-update.state"
echo "== apt update ($(now))"
export DEBIAN_FRONTEND=noninteractive
rc=0
$APT -o Acquire::Retries=2 -o Acquire::http::Timeout=30 update || rc=$?
if [ "$rc" = 0 ]; then
  echo "== apt upgrade ($(now))"
  $APT -y -o Dpkg::Options::=--force-confold upgrade || rc=$?
fi
if [ "$rc" = 0 ]; then echo "== finished ($(now))"; echo "done $(now)" > "$S/os-update.state"
else echo "== FAILED rc=$rc ($(now))"; echo "failed $rc $(now)" > "$S/os-update.state"; fi
exit "$rc"
