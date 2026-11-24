# offline/: the offline bundle

This folder holds the **offline bundle**: everything the setup needs, so the Pi never needs internet. It is
**not in git**, only this README. `bash scripts/00-get-bundle.sh` fills it from official public sources (about
1.2 GB) and writes `SHA256SUMS`. From then on, the image build, the Pi setup and the self-contained disk run
without internet. Check a copy at any time with `cd offline && sha256sum --quiet -c SHA256SUMS`. To copy the
code, this bundle and your region data to another PC, use `bash scripts/06-export.sh /media/usb`.

Parts can be fetched one by one: `bash scripts/00-get-bundle.sh <part>…`, with the parts
`os pc-wheels pc-debs bin pi-docker pi-debs fonts`. Without arguments, it runs all parts. The OS image, pmtiles,
the Valhalla image and the fonts are skipped when they are present and still match their pinned checksums; a
changed `VALHALLA_IMAGE_ID_ARM64` (or `FONTS_COMMIT` with `FONTS_TREE_SHA256`) fetches that part again.
`pc-wheels`, `pc-debs` and `pi-debs` are downloaded again on every run (`pi-debs` is resolved from scratch).

The offline bundle is one of three things that travel together as the **kit** (code + offline bundle + region
data, see [docs/GLOSSARY.md](../docs/GLOSSARY.md)). It is not an *update bundle*: those are made by
`scripts/30-make-update-bundle.sh` for a Pi that is already set up.

| Folder | Content | Source and check | Used by |
|---|---|---|---|
| `os/` | Raspberry Pi OS Lite 64-bit (Trixie), `.img.xz` + `.sha256` | `PIOS_URL` in config.env; the official sha256 | `01-build-image`, `40-make-disk` |
| `pc-wheels/` | pyfatfs and its dependencies (build PC) | PyPI, versions pinned in `tools/requirements.txt` | `01-build-image` |
| `pc-debs/` | the `f3` card tester (build PC) | the PC's own apt sources | `02-flash-sd` |
| `bin/` | pmtiles for arm64 (Pi) and x86_64 (PC) | official GitHub releases, sha256 pinned in config.env | `20-setup-pi`, `11-build-map`, `40-make-disk` |
| `pi-docker/` | the Valhalla 3.5.1 routing engine, arm64 (`docker save`, gzip) | `VALHALLA_IMAGE` (pinned digest); the saved config digest must equal `VALHALLA_IMAGE_ID_ARM64` (default in `scripts/common.sh`; change both together) | `20-setup-pi`, `40-make-disk` |
| `pi-debs/` | every package the Pi needs on top of the OS image, arm64, with dependencies (235 files, 378 MB on 2026-11-23) | the OS image's own Debian + Raspberry Pi sources and signing keys, resolved by apt against the image's own package state | `20-setup-pi`, `40-make-disk` |
| `data/fonts/` | Noto Sans Regular map glyphs | github.com/protomaps/basemaps-assets at a pinned commit (`FONTS_COMMIT` in `scripts/00-get-bundle.sh`; the glyph files are checked against `FONTS_TREE_SHA256`) | `21-push-data` (unless `FONTS_DIR` is set), `40-make-disk` (always this folder) |
| `data/<region>/` (optional) | prebuilt region data (`map/`, `search/`, `valhalla/`, …), if you keep it with the kit | `scripts/1x-build-*` write to `work/data/<region>/`; copy or hard-link it here | `21-push-data`, `30-make-update-bundle`, `40-make-disk` (they fall back to `work/data/`) |
| `data/imagery/` (optional) | satellite / aerial photo packs (`.mbtiles`) + `BUILD-INFO` | `tools/build_imagery.py`, then `tools/imagery_buildinfo.py` | `21-push-data` (falls back to `work/data/imagery/`), `40-make-disk` (only this folder) |
| `data/voice/` (optional) | recorded voice prompts | `tools/build_voicepack.py` | `21-push-data` (falls back to `work/data/voice/`), `40-make-disk` (only this folder) |
| `SHA256SUMS` | the checksum of every file in the bundle | written by `00-get-bundle.sh` (files added later, such as region data or packs, are only included after a re-run) | all |

## How the Pi package list is made

`00-get-bundle.sh pi-debs` builds the package list without root and without a Pi:

1. It unpacks the OS image and reads three things from its root partition with `debugfs` (via
   `tools/ext4_extract.py`): `/var/lib/dpkg/status`, `/etc/apt` and `/usr/share/keyrings`.
2. It runs apt in a private folder with `APT::Architecture=arm64`, the image's own package sources and signing
   keys, and the image's package state. It asks for every package in `features/*/feature.json` (`pi.packages`)
   plus `apt-utils` and `cloud-guest-utils`, without recommended packages.
3. apt downloads exactly what is missing from the image, plus the upgrades those packages require, with
   signatures checked as on a real Pi.

On the Pi, `pi/install-debs.sh` turns the folder into a local apt repository that apt sees **alone**, so the
install never reaches for the internet. It installs **every** package in the folder, whatever the edition: a
smaller edition leaves out app parts, not packages.

Re-run `00-get-bundle.sh` (or one part, for example `00-get-bundle.sh pi-debs`) after changing `PIOS_URL` or a
feature's packages.
