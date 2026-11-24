#!/bin/bash
# Build the offline/ bundle from public sources (needs internet once; ~1.2 GB download, ~5 min).
# Everything later (image, Pi setup, self-contained disk) then runs without internet.
#   bash scripts/00-get-bundle.sh            # all parts (os, bin, pi-docker and fonts are skipped when already complete)
#   bash scripts/00-get-bundle.sh pi-debs    # only some parts: os pc-wheels pc-debs bin pi-docker pi-debs fonts
# Needs: curl xz-utils python3 docker (for pi-docker) apt-get + e2fsprogs (for pi-debs: Debian/Ubuntu PC).
# No root needed. Sources (all official, all checksum-verified):
#   os/         Raspberry Pi OS Lite 64-bit (PIOS_URL) + its official .sha256
#   pc-wheels/  Python packages of tools/requirements.txt (pip download)
#   pc-debs/    the f3 card tester (apt-get download, the PC's own distribution)
#   bin/        pmtiles PMTILES_VERSION for arm64 + x86_64 (GitHub releases, PMTILES_SHA256_*)
#   pi-docker/  the Valhalla routing engine, arm64 (VALHALLA_IMAGE, pinned digest; image ID checked)
#   pi-debs/    every package the Pi needs on top of the OS image, arm64, with dependencies: resolved by apt in a
#               private folder against the image's own package state and its own signed package sources
#   data/fonts/ Noto Sans Regular map glyphs (github.com/protomaps/basemaps-assets, pinned commit)
. "$(dirname "$0")/common.sh"
FONTS_COMMIT=${FONTS_COMMIT:-028c18f713baecad011301ff7a69acc39bcc2ae7}   # basemaps-assets main on 2026-11-23
# sha256 over the glyph files of that commit (fonts_tree_sum): independent of how GitHub packs the archive.
# Overriding FONTS_COMMIT needs the matching FONTS_TREE_SHA256 (empty = not checked).
FONTS_TREE_SHA256=${FONTS_TREE_SHA256-527fc1714a11203334be7785dc587bef8738dd083d05c2a302af66e08d21707d}
O=$OFFLINE_DIR; mkdir -p "$O" "$WORK_DIR"
PARTS=("$@"); [ "${#PARTS[@]}" -gt 0 ] || PARTS=(os pc-wheels pc-debs bin pi-docker pi-debs fonts)
need curl "sudo apt install curl"; need python3 "sudo apt install python3"
# Pi packages = every feature's pi.packages (features/*/feature.json) + what the setup scripts themselves call
pi_packages() {
  python3 - "$ROOT" <<'PY'
import glob, json, sys
p = {"apt-utils", "cloud-guest-utils"}           # apt-ftparchive (pi/install-debs.sh), growpart (pi/firstboot.sh)
for f in glob.glob(sys.argv[1] + "/features/*/feature.json"):
    p.update(json.load(open(f)).get("pi", {}).get("packages", []) or [])
print("\n".join(sorted(p)))
PY
}

get_os() {
  local f d; f=$(basename "$PIOS_URL"); d="$O/os"; mkdir -p "$d"
  if [ -s "$d/$f" ] && (cd "$d" && sha256sum --quiet -c "$f.sha256" 2>/dev/null); then echo "os: present"; return; fi
  say "os: $f"
  curl -fL --retry 3 -o "$d/$f.sha256" "$PIOS_URL.sha256"
  curl -fL --retry 3 -C - -o "$d/$f" "$PIOS_URL"
  (cd "$d" && sha256sum -c "$f.sha256") || fail "OS image checksum wrong"
}

get_wheels() {
  say "pc-wheels"
  mkdir -p "$O/pc-wheels"
  python3 -m pip download -q -d "$O/pc-wheels" -r "$ROOT/tools/requirements.txt" \
    || fail "pip download failed (sudo apt install python3-pip, or python3 -m ensurepip --user)"
  ls "$O/pc-wheels"
}

get_pcdebs() {
  mkdir -p "$O/pc-debs"
  if ! command -v apt-get >/dev/null; then echo "pc-debs: no apt-get on this PC — skipped (install f3 yourself)"; return; fi
  say "pc-debs: f3"
  (cd "$O/pc-debs" && apt-get download -q f3) || echo "pc-debs: f3 not found in this PC's package sources — skipped"
}

get_bin() {
  local a sum t; mkdir -p "$O/bin"
  for a in arm64 x86_64; do
    if [ $a = arm64 ]; then sum=$PMTILES_SHA256_ARM64; else sum=$PMTILES_SHA256_X86_64; fi
    t="$O/bin/pmtiles-$a.tgz"
    if [ -s "$t" ] && echo "$sum  $t" | sha256sum --quiet -c - 2>/dev/null; then echo "bin: pmtiles $a present"; continue; fi
    say "bin: pmtiles $PMTILES_VERSION $a"
    curl -fsSL --retry 3 -o "$t" \
      "https://github.com/protomaps/go-pmtiles/releases/download/v$PMTILES_VERSION/go-pmtiles_${PMTILES_VERSION}_Linux_$a.tar.gz"
    echo "$sum  $t" | sha256sum -c - || fail "pmtiles $a checksum wrong"
  done
}

get_docker() {
  need docker "https://docs.docker.com/engine/install/ — your user must be in the docker group"
  local t="$O/pi-docker/valhalla-3.5.1-arm64.tar.gz" tmp cfg
  mkdir -p "$O/pi-docker"
  # present = saved from the pinned image: its ID is recorded beside it (<file>.id); a bundle without that record is
  # checked once from the archive's manifest. A changed VALHALLA_IMAGE / VALHALLA_IMAGE_ID_ARM64 fetches it again.
  if [ -s "$t" ]; then
    if [ "$(cat "$t.id" 2>/dev/null)" = "$VALHALLA_IMAGE_ID_ARM64" ]; then echo "pi-docker: present ($VALHALLA_IMAGE_ID_ARM64)"; return; fi
    cfg=$(tar -xzOf "$t" manifest.json 2>/dev/null | python3 -c 'import json,sys; m=json.load(sys.stdin); print(m[0]["Config"].split("/")[-1].replace(".json",""))' 2>/dev/null || true)
    if [ "sha256:$cfg" = "$VALHALLA_IMAGE_ID_ARM64" ]; then echo "$VALHALLA_IMAGE_ID_ARM64" > "$t.id"; echo "pi-docker: present ($VALHALLA_IMAGE_ID_ARM64)"; return; fi
    echo "pi-docker: $t is not the pinned image ${VALHALLA_IMAGE_ID_ARM64} (it is sha256:${cfg:-?}) — fetching it again"
    rm -f "$t" "$t.id"
  fi
  say "pi-docker: Valhalla arm64 ($VALHALLA_IMAGE)"
  docker pull -q --platform linux/arm64 "$VALHALLA_IMAGE" >/dev/null || fail "docker pull failed"
  tmp="$WORK_DIR/valhalla-arm64.tar"
  docker save --platform linux/arm64 -o "$tmp" "$VALHALLA_IMAGE" 2>/dev/null || docker save -o "$tmp" "$VALHALLA_IMAGE"
  # the image ID the Pi will see after `docker load` = the config digest in the saved manifest
  cfg=$(tar -xOf "$tmp" manifest.json | python3 -c 'import json,sys; m=json.load(sys.stdin); print(m[0]["Config"].split("/")[-1].replace(".json",""))')
  [ "sha256:$cfg" = "$VALHALLA_IMAGE_ID_ARM64" ] || { rm -f "$tmp"; fail "saved image config sha256:$cfg is not the pinned arm64 image $VALHALLA_IMAGE_ID_ARM64"; }
  gzip -1 -c "$tmp" > "$t.part" && mv -f "$t.part" "$t" && rm -f "$tmp"
  echo "$VALHALLA_IMAGE_ID_ARM64" > "$t.id"
  ls -l "$t"
}

get_pidebs() {
  need apt-get "pi-debs needs a Debian/Ubuntu build PC (apt)"; need debugfs "sudo apt install e2fsprogs"
  need sfdisk "sudo apt install fdisk"; need xz "sudo apt install xz-utils"
  get_os
  local xz img sb start n
  xz="$O/os/$(basename "$PIOS_URL")"; img="$WORK_DIR/$(basename "${xz%.xz}")"; sb="$WORK_DIR/pi-apt"
  [ -s "$img" ] || { say "pi-debs: unpack the OS image"; xz -dkc "$xz" > "$img.part" && mv -f "$img.part" "$img"; }
  say "pi-debs: read the image's package state and sources (no root: debugfs on the root partition)"
  rm -rf "$sb"; mkdir -p "$sb"/{root,lists/partial,archives/partial,etc}
  start=$(sfdisk -J "$img" | python3 -c 'import json,sys; print(json.load(sys.stdin)["partitiontable"]["partitions"][1]["start"])')
  dd if="$img" of="$sb/rootfs.ext4" bs=512 skip="$start" conv=sparse status=none
  debugfs -R "dump /var/lib/dpkg/status $sb/status" "$sb/rootfs.ext4" 2>/dev/null
  python3 "$ROOT/tools/ext4_extract.py" "$sb/rootfs.ext4" "$sb/root" /etc/apt /usr/share/keyrings
  rm -f "$sb/rootfs.ext4"
  [ -s "$sb/status" ] || fail "could not read /var/lib/dpkg/status from the image"
  # the image's own sources, keys pointed into the sandbox
  find "$sb/root/etc/apt" -name '*.sources' -o -name '*.list' | while read -r f; do
    sed -i "s#/usr/share/keyrings/#$sb/root/usr/share/keyrings/#g; s#/etc/apt/trusted.gpg.d/#$sb/root/etc/apt/trusted.gpg.d/#g" "$f"; done
  APT=(apt-get -q -o "Dir::State=$sb" -o "Dir::State::Lists=$sb/lists" -o "Dir::State::status=$sb/status"
       -o "Dir::Etc=$sb/root/etc/apt" -o "Dir::Etc::SourceList=$sb/root/etc/apt/sources.list"
       -o "Dir::Etc::SourceParts=$sb/root/etc/apt/sources.list.d" -o "Dir::Etc::Preferences=$sb/etc/none"
       -o "Dir::Etc::PreferencesParts=$sb/root/etc/apt/preferences.d" -o "Dir::Etc::Trusted=$sb/root/etc/apt/trusted.gpg"
       -o "Dir::Etc::TrustedParts=$sb/root/etc/apt/trusted.gpg.d" -o "Dir::Cache=$sb" -o "Dir::Cache::archives=$sb/archives"
       -o APT::Architecture=arm64 -o "APT::Architectures::=arm64" -o Debug::NoLocking=1
       -o Acquire::Languages=none -o APT::Install-Recommends=false)
  say "pi-debs: package lists (Raspberry Pi + Debian archives, arm64)"
  "${APT[@]}" update || fail "apt update in the sandbox failed"
  mapfile -t PK < <(pi_packages)
  say "pi-debs: download ${#PK[@]} packages + dependencies: ${PK[*]}"
  "${APT[@]}" install -y --download-only "${PK[@]}" || fail "apt could not resolve the Pi packages"
  rm -rf "$O/pi-debs"; mkdir -p "$O/pi-debs"
  mv "$sb"/archives/*.deb "$O/pi-debs/"
  n=$(find "$O/pi-debs" -name '*.deb' | wc -l)
  [ "$n" -gt 0 ] || fail "no packages downloaded"
  echo "pi-debs: $n .deb ($(du -sh "$O/pi-debs" | cut -f1))"
  rm -rf "$sb"
}

fonts_tree_sum() {   # fonts_tree_sum <dir with "Noto Sans Regular/">
  (cd "$1" && find "Noto Sans Regular" -type f -print0 | LC_ALL=C sort -z | xargs -0 sha256sum | sha256sum | cut -d' ' -f1)
}

get_fonts() {
  local d="$O/data/fonts" tmp="$WORK_DIR/basemaps-assets.tgz" x="$WORK_DIR/fonts.part" got
  if [ -d "$d/Noto Sans Regular" ]; then
    if [ -z "$FONTS_TREE_SHA256" ] || [ "$(fonts_tree_sum "$d")" = "$FONTS_TREE_SHA256" ]; then echo "fonts: present"; return; fi
    echo "fonts: $d/Noto Sans Regular is not the pinned set — fetching it again"
  fi
  say "fonts: Noto Sans Regular glyphs (protomaps/basemaps-assets @ $FONTS_COMMIT)"
  curl -fsSL --retry 3 -o "$tmp" "https://github.com/protomaps/basemaps-assets/archive/$FONTS_COMMIT.tar.gz" || fail "fonts download failed"
  rm -rf "$x"; mkdir -p "$x"
  tar xzf "$tmp" -C "$x" --strip-components=2 --wildcards "*/fonts/Noto Sans Regular/*" || fail "fonts not in the archive"
  rm -f "$tmp"
  got=$(fonts_tree_sum "$x")
  [ -z "$FONTS_TREE_SHA256" ] || [ "$got" = "$FONTS_TREE_SHA256" ] || { rm -rf "$x"; fail "fonts checksum wrong: $got, expected $FONTS_TREE_SHA256"; }
  mkdir -p "$d"; rm -rf "$d/Noto Sans Regular"; mv "$x/Noto Sans Regular" "$d/"; rm -rf "$x"
  ls "$d/Noto Sans Regular" | wc -l
}

for p in "${PARTS[@]}"; do
  case "$p" in
    os) get_os;; pc-wheels) get_wheels;; pc-debs) get_pcdebs;; bin) get_bin;;
    pi-docker) get_docker;; pi-debs) get_pidebs;; fonts) get_fonts;;
    *) fail "unknown part '$p' (os pc-wheels pc-debs bin pi-docker pi-debs fonts)";;
  esac
done

say "SHA256SUMS"
(cd "$O" && find . -type f ! -name SHA256SUMS ! -name README.md -print0 | sort -z | xargs -0 sha256sum > SHA256SUMS)
echo "$(wc -l < "$O/SHA256SUMS") files checksummed in $O/SHA256SUMS ($(du -sh "$O" | cut -f1))"
echo "Next: build the region data (map, search, routing):  bash scripts/11-build-map.sh && bash scripts/12-build-search.sh && bash scripts/10-build-routing.sh"
