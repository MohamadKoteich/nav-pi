#!/bin/bash
# Give the routing engine image a fixed LOCAL name on the Pi, as root:
#   bash load-valhalla.sh <valhalla-*-arm64.tar.gz or -> <expected image id> <local tag> [registry ref]
# A `docker save`d image comes back from `docker load` with its ID only: the pinned registry reference
# (…@sha256:<multi-arch index>) cannot survive a save, so services that ran by that reference found
# "No such image" on a fresh Pi (2026-11-12, Pi 4 first boot). Now: load if needed, check the image ID
# against the pinned one, tag it, and the services run the tag.
set -euo pipefail
TAR=${1:?tar.gz}; WANT=${2:?image id}; TAG=${3:?tag}; REF=${4:-}
have() { [ "$(docker image inspect "$1" --format '{{.Id}}' 2>/dev/null)" = "$WANT" ]; }
if have "$TAG"; then echo "routing image: $TAG ($WANT) present"; exit 0; fi
if [ -n "$REF" ] && have "$REF"; then
  docker tag "$REF" "$TAG"     # a Pi that once pulled it from the registry
elif have "$WANT"; then
  docker tag "$WANT" "$TAG"
else
  if [ "$TAR" = - ]; then gunzip -c | docker load -q; else gunzip -c "$TAR" | docker load -q; fi
  have "$WANT" || { echo "routing image ID after load is not $WANT"; exit 1; }
  docker tag "$WANT" "$TAG"
fi
have "$TAG" && docker image inspect "$TAG" --format "routing image: $TAG {{.Id}} {{.Architecture}} {{.Size}}"
