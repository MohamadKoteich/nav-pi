#!/bin/bash
# Copy music / audiobooks / podcasts from this PC to the Pi (over cable or LAN, no internet).
#   bash scripts/23-push-media.sh <folder> Music|Audiobooks|Podcasts [host]
# Folders are kept: Music/<Artist or Album>/…, Audiobooks/<Book>/<chapters>, Podcasts/<Show>/<episodes>.
# Supported files: mp3 m4a m4b aac ogg opus flac wav. Re-running copies only what changed.
. "$(dirname "$0")/common.sh"
SRC=${1:?usage: bash scripts/23-push-media.sh <folder> Music|Audiobooks|Podcasts [host]}
KIND=${2:?say Music, Audiobooks or Podcasts}
HOST=${3:-$PI_HOSTNAME.local}
case "$KIND" in Music|Audiobooks|Podcasts) ;; *) fail "kind must be Music, Audiobooks or Podcasts";; esac
[ -d "$SRC" ] || fail "no such folder: $SRC"
ssh -o BatchMode=yes "$PI_USER@$HOST" "mkdir -p '/srv/navdata/media/$KIND' && df -h /srv/navdata | tail -1"
rsync -a --info=progress2 --include='*/' --include='*.mp3' --include='*.m4a' --include='*.m4b' --include='*.aac' \
  --include='*.ogg' --include='*.opus' --include='*.flac' --include='*.wav' --include='*.MP3' --exclude='*' \
  -e "ssh -o BatchMode=yes" "$SRC/" "$PI_USER@$HOST:/srv/navdata/media/$KIND/$(basename "$SRC")/"
echo "done — open Media → $KIND on the Pi"
