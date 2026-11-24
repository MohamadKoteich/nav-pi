#!/bin/bash
# Install the bundled Pi packages OFFLINE, as root:  bash install-debs.sh <folder with .deb files>
# The folder becomes a local apt repository and apt is told to see ONLY it (plus what is installed).
# Why (2026-11-12, Pi 4 first boot): `apt-get install --no-download *.deb` against the image's own package
# lists failed with "Unable to fetch some archives" — for 326 packages the lists offer the SAME version
# from the internet archive and apt took that copy instead of the file on the disk.
set -euo pipefail
REPO=$(cd "${1:?folder with .deb files}" && pwd)
L=/var/lib/nav-pi/apt
install -d "$L/lists/partial" "$L/parts"
# index built here (apt-ftparchive is part of apt-utils in every Raspberry Pi OS image): no PC tool needed
(cd "$REPO" && apt-ftparchive packages . > Packages)
echo "deb [trusted=yes] file:$REPO ./" > "$L/sources.list"
APT=(apt-get -q -o "Dir::Etc::SourceList=$L/sources.list" -o "Dir::Etc::SourceParts=$L/parts"
     -o "Dir::State::Lists=$L/lists" -o Acquire::Languages=none)
"${APT[@]}" update >/dev/null
mapfile -t PKGS < <(awk '/^Package:/{print $2}' "$REPO/Packages" | sort -u)
echo "${#PKGS[@]} packages from $REPO (local repository only)"
DEBIAN_FRONTEND=noninteractive "${APT[@]}" install -y -o Dpkg::Options::=--force-confold "${PKGS[@]}" >/dev/null
echo "packages installed"
