# Installing nav-pi

This guide takes you from an empty build PC to a running nav-pi. The words it uses (offline bundle, region data,
BUILD-INFO, update bundle, edition, …) are explained in [GLOSSARY.md](GLOSSARY.md), together with a diagram of
the whole pipeline.

There are two ways to put nav-pi on the Pi:

- **Option A: SD card + setup over the network.** Write a small card image, then the build PC installs the
  app and copies the data over Ethernet. Best if you develop, or want to update often.
- **Option B: one self-contained disk (USB SSD or microSD card).** The build PC writes one disk that holds
  everything. Plug it into the Pi and it sets itself up, with no PC and no internet.

| | Option A | Option B |
|---|---|---|
| Medium | microSD card, 64 GB or more | USB SSD, or a microSD card of 128 GB or more |
| During setup | Ethernet cable between PC and Pi | nothing |
| Tested | on a Pi 5 and a Pi 4 | partly (see [STATUS.md](STATUS.md)) |

Both start with the same three steps: configure, get the offline bundle, build the region data.

All commands run on the build PC, from the `nav-pi` folder. When something is wrong, a script stops with a line
`########## STOP: <reason> ##########` and says what to do. After each step below, **Done when** shows the line
that means it worked.

**Running a script again** is safe, but not every script skips finished work:

| Script | When run again |
|---|---|
| `00-get-bundle.sh` | skips the OS image, pmtiles, the Valhalla image and the fonts when they are present and match their pinned checksums (a changed `VALHALLA_IMAGE_ID_ARM64` fetches the image again); downloads `pc-wheels`, `pc-debs` and `pi-debs` again (`pi-debs` is resolved from scratch) and rewrites `SHA256SUMS` |
| `11-build-map.sh`, `12-build-search.sh`, `13-build-*.sh` | build again from the start |
| `10-build-routing.sh` | reuses the downloaded `.osm.pbf` (`--refresh` downloads it again), builds the whole route graph again |
| `01-build-image.sh` | builds the image again (reuses the unpacked OS image) |
| `02-flash-sd.sh` | tests the card with `f3probe` again (this erases it), then writes it |
| `20-setup-pi.sh` | installs again; sends the Valhalla image only if the Pi does not have it |
| `21-push-data.sh` | copies only what changed (resumes an interrupted copy) and checks the sha256 again |
| `40-make-disk.sh`, `41-write-disk.sh` | build and write again from the start |

---

## 0. Requirements

**Build PC:** 64-bit Linux on x86_64 (tested: Ubuntu, Debian).

| Program | Debian/Ubuntu package | Needed for |
|---|---|---|
| curl, xz, python3 (+ venv, pip) | `curl xz-utils python3 python3-venv python3-pip` | everything |
| git | `git` | the self-contained disk and `06-export.sh` (they copy the committed code) |
| Docker | [docs.docker.com/engine/install](https://docs.docker.com/engine/install/) | routing build, offline bundle |
| apt-get, debugfs, mke2fs, sfdisk | `apt e2fsprogs fdisk` (present on Debian/Ubuntu) | downloading the Pi packages, the self-contained disk |
| ssh, rsync | `openssh-client rsync` | setup over the network (option A), updates, `06-export.sh` |
| mDNS name lookup | `avahi-daemon libnss-mdns` (usual on desktop installs) | reaching the Pi as `nav-pi.local`; without it, give the Pi's IP address to every script |
| nmcli, **NetworkManager 1.40 or newer** | `network-manager` | only `42-add-wifi.sh` (it uses `nmcli --offline`; Ubuntu 22.04 ships 1.36, which is too old) |
| sudo | — | only for writing the card or disk |

**Docker without sudo:** add your user to the `docker` group, then **log out and in again** (or run `newgrp docker`
in the terminal you use):

```bash
sudo usermod -aG docker "$USER"
```

The card tester `f3` comes with the offline bundle (as a `.deb` from your PC's own package sources) and is
installed by `02-flash-sd.sh` when it is missing.

**Disk space, RAM and time on the build PC:**

| | Upper Bavaria (default) | Germany |
|---|---|---|
| Free disk, option A | ~12 GB | ~35 GB |
| Free disk, option B (adds `disk/`) | ~20 GB | ~65 GB |
| RAM | 8 GB recommended | 16 GB recommended |
| Data build time (bundle + map + search + route graph) | ~30 min | ~4.5 h |
| End to end, including card writing and Pi setup | ~1 h | ~5 h |

The disk figures are estimated from the files the steps leave behind (2026-11-23/24): the offline bundle
(1.2 GB), the unpacked OS image and the card image (3.1 GB each), the Valhalla image in Docker (1.8 GB), and the
region data (Upper Bavaria 1.5 GB, Germany 23 GB, both including the `.osm.pbf` download). The RAM figures are
recommendations: the peak was not measured (the Germany route graph build used about 5 GB when checked). The
build times were measured on 2026-11-23 on a 6-core PC; the end-to-end times are rough estimates. Each step's
own time is given below.

**Raspberry Pi:**

- a Pi 4 or Pi 5. The hardware profiles cover 2 GB (basic edition only) up to 16 GB; **8 GB is recommended**. See
  the [hardware table](../README.md#hardware).
- a touch screen (tested: Raspberry Pi Touch Display 2)
- a microSD card (option A) or a USB SSD or large microSD card (option B)
- a **bench power supply** for the setup: the official 27 W USB-C supply (5 V, 5 A) for a Pi 5, the official 15 W
  supply (5 V, 3 A) for a Pi 4. A weak supply causes random failures; *Settings > Pi health* shows under-voltage.
- for option A: an Ethernet cable to the same network as the build PC

---

## 1. Configure

```bash
git clone https://github.com/MohamadKoteich/nav-pi.git
cd nav-pi
cp config.env.example config.env
```

Open `config.env` and check these settings:

- `PI_HOSTNAME` (default `nav-pi`): the Pi will be reachable as `nav-pi.local`.
- `TIMEZONE`, `KEYBOARD_LAYOUT`, and `BROWSER_LANG` (the kiosk browser's own language; the app's language is chosen on the device).
- **The region** (`REGION`, `REGION_BBOX`, `REGION_POLYGON`, `OSM_PBF`). The default is Upper Bavaria with Munich
  (`oberbayern`): small and quick. Germany and Europe are written out below it, and
  [DATA.md](DATA.md#your-own-region) explains how to set up any other area.
- `SSH_PUBKEY_FILE`: empty = `~/.ssh/id_ed25519.pub`, created if missing. Only this key can log in to the Pi.
  `none` = no key and SSH turned off (only for option B, see
  [Handing a device over](#handing-a-device-over)).

Every setting is explained in `config.env.example`. Two ways to change settings without editing the file:

- **for one run:** put the setting in front of the command, e.g. `REGION=germany bash scripts/11-build-map.sh`.
  A non-empty value given this way wins over the file. Settings that exist only for one run are listed in
  [Settings for one run](#settings-for-one-run).
- **a second settings file:** `NAVPI_CONFIG=~/germany.env bash scripts/…` reads that file instead of `config.env`.
  This is handy for building several regions.

### What needs `sudo`

Only these steps touch your PC's disks. Each one checks that the target is a whole disk on USB, and the
writing steps check the card or ask you to confirm before they erase anything:

| Step | Why |
|---|---|
| `sudo bash scripts/02-flash-sd.sh` | test, write and read back the SD card |
| `sudo bash scripts/41-write-disk.sh /dev/sdX` | write and read back the self-contained disk (you type its serial number to confirm) |
| `sudo bash scripts/42-add-wifi.sh /dev/sdX` | put a Wi-Fi network on a card or disk |
| `sudo bash scripts/43-update-card.sh /dev/sdX` | update the app on a card or disk |

`/dev/sdX` is the disk's device name; `lsblk -o NAME,SIZE,TRAN,MODEL,SERIAL` lists it. Everything else runs as
your normal user. That includes Docker, which needs your user in the `docker` group.

## 2. Get the offline bundle

```bash
bash scripts/00-get-bundle.sh
```

This downloads about 1.2 GB from official sources into `offline/` (the **offline bundle**) and checks every
file (about 4 minutes on the test PC). It contains:

- the Raspberry Pi OS Lite image
- every package the Pi needs (arm64, resolved by apt against that exact OS image)
- the Valhalla routing engine (Docker image, arm64, pinned by digest)
- the pmtiles tool
- map label fonts
- a few helpers for the build PC

See [offline/README.md](../offline/README.md) for the full list and sources. To fetch only some parts, name
them, for example `bash scripts/00-get-bundle.sh fonts`.

**Done when** it prints `<n> files checksummed in …/offline/SHA256SUMS (<size>)`, followed by a `Next:` line that
points to step 3.

After this step, only the data downloads in step 3 use the internet.

## 3. Build the region data

```bash
bash scripts/11-build-map.sh       # map: cut out of the newest Protomaps planet build (reads only your region over HTTP)
bash scripts/12-build-search.sh    # search index: built from the map you just cut
bash scripts/10-build-routing.sh   # route graph: downloads the OpenStreetMap extract (Geofabrik), builds it with Valhalla
```

Run them in this order: the search index needs the map. Measured on 2026-11-23 for Upper Bavaria: map 7.5 min,
search 41 s, route graph 16 min including the download.

**Done when** each one prints its `BUILD-INFO` (ending in a `sha256=` or `tar_sha256=` line) and then the size of
its file, for example `494M …/work/data/oberbayern/map/oberbayern.pmtiles`. A missing input stops the script with
a `STOP:` line instead.

Optional extras:

```bash
bash scripts/13-build-along.sh     # places along the route (fuel, parking, toilets, rest areas)
SAFETY_PBF=work/data/oberbayern/valhalla/oberbayern-latest.osm.pbf bash scripts/13-build-safety.sh   # driver alerts
```

- Without `13-build-along.sh` the Pi still finds places along the route, but only for the next 60 km, from the map
  tiles.
- `13-build-safety.sh` needs a local OpenStreetMap `.pbf` file. `10-build-routing.sh` leaves the downloaded extract
  in `work/data/<region>/valhalla/<region>-latest.osm.pbf`; for another region, put its name in both places of the
  path. `SAFETY_COVERAGE=<name>` sets the area name the Settings page shows (default: from the file name, for
  example `Oberbayern`). Driver alerts are part of the advanced and full editions.

Output goes to `work/data/<region>/`. Each part has a `BUILD-INFO` file with its source, date and sha256. The
scripts that copy the data check the copy against it.

Satellite and aerial photos are optional. The Pi can download areas itself over Wi-Fi (*Settings > Satellite*),
or you can build a pack on the build PC with `tools/build_imagery.py`. See
[DATA.md](DATA.md#satellite-and-aerial-photos).

> **Germany:** set the Germany preset in `config.env`, then the same commands. The route graph takes several
> hours (3 h 37 min on the test PC). Set `MAP_DOWNLOAD_THREADS=4` for a faster map cut (fine for a country; keep
> 1 for Europe).

---

## Option A: SD card + setup over the network

### A1. Build and write the card

```bash
bash scripts/01-build-image.sh       # no root: official image + nav-pi first-boot files -> work/nav-pi.img
sudo bash scripts/02-flash-sd.sh     # finds the card by itself; name it (/dev/sdX) if several are plugged in
```

`01-build-image.sh` only adds files to the image's boot partition. It checks that the rest of the image is
byte-identical to the official one.

**Done when** it prints `DONE: …/work/nav-pi.img`, the image's sha256 and
`Next: insert the microSD card, then  sudo bash scripts/02-flash-sd.sh`.

`02-flash-sd.sh` takes these steps, in this order:

1. **Safety checks.** It only accepts a removable USB disk of 8–512 GB that holds no mounted system folder, and
   refuses internal disks. `CHECK_ONLY=1` runs only the checks (no root needed).
2. Checks the image's checksum.
3. **Tests the card with `f3probe`** for fake capacity (a few minutes). ⚠ This erases the card.
4. Writes the image (~3 GB; about 4 minutes in a slow reader).
5. **Reads the card back** and compares it with the image.

**Done when** it prints `SUCCESS: card tested genuine, written and verified.` Only remove the card then.

### A2. First boot

Put the card in the Pi, connect the **Ethernet cable** and the screen, then power on. The first boot takes a few
minutes. It grows the system partition, checks every OS file against its package checksum, and sets up the user
`nav` with your SSH key (no password). It installs nothing; the packages come from the build PC in step A3. If
it fails, it runs again on the next boot. Log: `/var/log/nav-pi-firstboot.log`.

```bash
bash scripts/03-check-pi.sh          # waits for the Pi, prints a health report
```

**Done when** the report ends in `RESULT: HEALTHY`.

If `nav-pi.local` does not resolve on your network, use the IP address from your router:
`bash scripts/03-check-pi.sh 192.168.1.50`. The same `[host]` argument works for every script below.

### A3. Install the app and copy the data

```bash
bash scripts/20-setup-pi.sh          # packages, routing engine, pmtiles, and the edition for this board
bash scripts/21-push-data.sh         # map, search, routing, plus fonts and the optional parts you built
```

`20-setup-pi.sh` also sets the Pi's clock from the build PC (the Pi has no clock battery). The edition is chosen
from the board's model and RAM (see [EDITIONS.md](EDITIONS.md)). To choose it yourself:
`EDITION=basic bash scripts/20-setup-pi.sh`.

**Done when** `20-setup-pi.sh` lists the units (`nav-pi-tiles`, `nav-pi-valhalla`, `nav-pi`, `greetd`) and prints
`DONE. Next: bash scripts/21-push-data.sh`. Before the first data copy, `nav-pi-tiles` and `nav-pi-valhalla` show
as inactive: they start once there is a region.

`21-push-data.sh` checks the free space on the Pi, copies the data (an interrupted copy resumes), and checks the
sha256 of the map, search, routing and optional parts on the Pi (fonts and voice clips are copied without a
check). When map, search and routing are verified, it switches the Pi to the region.

**Done when** it prints `switched from nothing to oberbayern` (or `already on oberbayern`), then the free space on
the Pi. The screen shows the map. What to do on the device next: [OPERATING.md](OPERATING.md).

Log in: `ssh nav@nav-pi.local` (key only).

---

## Option B: a self-contained disk

```bash
bash scripts/40-make-disk.sh                  # no root; writes ./disk (head.img + data.img + manifest.json)
sudo bash scripts/41-write-disk.sh /dev/sdX   # ERASES the disk: you type its serial number to confirm; reads it back
sudo bash scripts/42-add-wifi.sh /dev/sdX     # optional: a Wi-Fi network the Pi joins at boot
```

The disk carries the OS, the region data of `REGION`, the fonts, all Pi packages, the routing engine and the code.
The code is the committed git `HEAD`: commit your changes first, or `40-make-disk.sh` stops.

**What `40-make-disk.sh` takes from where** (this differs from `21-push-data.sh`):

| Part | `40-make-disk.sh` | `21-push-data.sh` |
|---|---|---|
| region data | `offline/data/<region>/`, else `work/data/<region>/` | the same |
| fonts | `offline/data/fonts/` only (`FONTS_DIR` is not used) | `FONTS_DIR`, else `offline/data/fonts/` |
| voice pack | `offline/data/voice/` only | `offline/data/voice/`, else `work/data/voice/` |
| photo packs | `offline/data/imagery/` only | `offline/data/imagery/`, else `work/data/imagery/` |

**The edition:** `EDITION` from `config.env` is written onto the disk. Empty (the default) means the Pi picks the
default edition for its model and RAM at the first boot. An edition the board may not run makes the first boot
fail (`FORCE_EDITION` does not apply on a disk).

**Disk size:** the system partition is 64 GiB by default (`ROOT_GIB=64`), and the data partition follows it. So
the disk must hold 64 GiB plus the region data; a 64 GB card is too small with the default setting.
`41-write-disk.sh` prints the size the image needs and refuses a disk that is too small.

**Done when** `40-make-disk.sh` prints `DONE: …/disk (head.img + data.img + manifest.json)`, and
`41-write-disk.sh` prints `SUCCESS: disk written and verified.` `42-add-wifi.sh` ends with
`Done: Wi-Fi '<name>' added to the Pi (…)`.

The target can be a **USB SSD** or a **microSD card** in a USB card reader. `41-write-disk.sh` accepts only a whole
USB disk that is big enough and has nothing of your PC mounted on it. `CHECK_ONLY=1` runs only the checks;
`sudo env VERIFY_ONLY=1 bash scripts/41-write-disk.sh /dev/sdX` only reads an already written disk back and
compares it.

- **microSD card:** put it in the Pi's card slot, then power on.
- **USB SSD:** plug it into a **blue USB 3 port**, with no SD card in the Pi, then power on.

On the first boot the Pi:

- grows the partitions
- installs every package from the disk
- picks the edition for its model and RAM (or the one written onto the disk)
- starts the navigator

This takes about 15 minutes. The screen shows a text console until it is done. Log:
`/var/log/nav-pi-firstboot.log` (readable later with the disk in a PC, or over SSH).

- **Pi 4:** it needs a bootloader that boots from USB. Every Pi 4 sold since late 2020 has one. For older
  boards, update the bootloader once with an SD card: Raspberry Pi Imager → *Misc utility images* → *USB boot*.
- **Status:** see [STATUS.md](STATUS.md). The disk path has been booted on a Pi 4, but a complete fresh first
  boot with the current kit has not been re-run since the last fixes.

---

## Updating

| What | How |
|---|---|
| The app, over the network | `bash scripts/22-update-app.sh [host]` (keeps the installed edition; `EDITION=` / `HARDWARE=` to change). Done when it prints `updated; screen reloads in a few seconds` |
| The app, card or disk in the PC | `sudo bash scripts/43-update-card.sh /dev/sdX` (keeps the edition; the previous app stays as `/opt/nav-pi/app.prev`) |
| The app, from a USB stick or a PC on the LAN | `bash scripts/30-make-update-bundle.sh app <target>`, then *Settings > System > Updates* on the Pi |
| The map, from a USB stick or a PC on the LAN | `bash scripts/30-make-update-bundle.sh map [region] <target>`, then *Settings > System > Updates* |
| The same region with newer OpenStreetMap data | see [below](#refreshing-a-region-with-newer-openstreetmap-data) |
| Another region | change the preset in `config.env`, build it (step 3), `bash scripts/21-push-data.sh` |
| Music, audiobooks, podcasts | `bash scripts/23-push-media.sh <folder> Music\|Audiobooks\|Podcasts [host]`, or import from a USB stick on the Pi |
| Raspberry Pi OS packages | *Settings > System > Updates* on the Pi (needs internet on the Pi, started by you) |

Notes on update bundles (`30-make-update-bundle.sh`, done when it prints `done. On the Pi: Settings > Updates > Check …`):

- `<target>` is a folder or a mounted USB stick. To fetch a bundle over the LAN instead, serve its folder from the
  build PC (`python3 -m http.server 8000 --directory <bundle folder>`) and enter `http://<build PC>:8000` once in
  *Settings > System > Updates*.
- An app bundle is built for one edition and board profile: by default `advanced` for `50-rpi5-8gb`. Set
  `EDITION=` and `HARDWARE=` for other boards.
- A map bundle contains map, search and routing (not the `.osm.pbf`). The Pi installs it as a new folder
  `<region>-<OSM date>` and keeps the old map for roll-back, so it needs about twice the bundle's size free. If
  that does not fit, it can replace the map in place, but only after an explicit warning.
- Updates are never applied while driving or navigating.
- Bundles are checked for damage (sha256), but they are **not signed**: see [SECURITY.md](SECURITY.md).

### Refreshing a region with newer OpenStreetMap data

The map always comes from the newest Protomaps build (`PMTILES_SRC=latest`). `10-build-routing.sh` normally
reuses the `.osm.pbf` it downloaded before (it says so: `reusing the extract downloaded <date>`); `--refresh`
downloads the current extract instead.

```bash
bash scripts/11-build-map.sh
bash scripts/12-build-search.sh
bash scripts/10-build-routing.sh --refresh                      # or REFRESH=1 bash scripts/10-build-routing.sh
bash scripts/13-build-along.sh                                  # if you use it
SAFETY_PBF=work/data/oberbayern/valhalla/oberbayern-latest.osm.pbf bash scripts/13-build-safety.sh   # if you use it
```

Then put it on the Pi in one of two ways:

- **Over SSH:** `bash scripts/21-push-data.sh`. It copies into the same region folder. When the region was already
  the active one, it prints `already on <region>` and does not restart the map services, so restart them (or
  reboot): `ssh nav@nav-pi.local sudo systemctl restart nav-pi-tiles nav-pi-valhalla nav-pi`.
- **As a map bundle** (any device, also without SSH): `bash scripts/30-make-update-bundle.sh map /media/usb`, then
  *Settings > System > Updates*. The old data stays for roll-back until you delete it.

Other updates on the device (roll back, delete old regions): [OPERATING.md](OPERATING.md).

**Devices installed under the earlier project name `pi-nav`:** the first `22-update-app.sh` (or `20-setup-pi.sh`)
run moves the installation to the new name. It keeps the data, the settings and the hostname.
The script is `pi/migrate-legacy-name.sh`.

## Handing a device over

A device for someone else should not keep your SSH key. There are two ways:

- **Lock it after you set it up:** `bash scripts/24-lock-device.sh [host]` removes every SSH key from the device
  and turns SSH off. It asks you to type `LOCK` first (`YES=1` skips the question). Done when it prints
  `DONE: <host> has no SSH keys and SSH is off.`
- **Build it without a key:** set `SSH_PUBKEY_FILE=none` and use option B (the self-contained disk).

Either way, nobody can log in over the network afterwards: there is no password and no key. App and map updates
still work from a USB stick (*Settings > System > Updates*). The recipient can always reflash the card with their
own key. A fresh card or disk carries none of your Wi-Fi networks, Bluetooth pairings, places, trips or media.
Those live only on the device that used them.

**What locking does not do:** it does not stop someone with physical access. Unsigned update bundles from a USB
stick can install any code, and the card or disk can be read and changed in any PC. Read
[SECURITY.md](SECURITY.md) before you give a device away.

## Copying the whole kit to another PC

`bash scripts/06-export.sh /media/usb` copies these to a folder or disk, then verifies the copy:

- the code at the last commit
- the offline bundle
- the region data you built, without the large build inputs (`.osm.pbf`, Valhalla's loose tile folder): about
  1 GB for Upper Bavaria, 13 GB for Germany (2026-11-24)

The disk must be ext4, exFAT or NTFS (FAT32 cannot hold files over 4 GB). Another PC can then set up a Pi with no
internet at all. Done when it prints `DONE: <target>/nav-pi — start with README.md and docs/INSTALL.md …`.

## Settings for one run

These are not in `config.env` (or only as a comment there); put them in front of the command.

| Setting | Scripts | Meaning |
|---|---|---|
| `NAVPI_CONFIG=<file>` | all | read this settings file instead of `config.env` |
| `OFFLINE_DIR=<folder>` | all | where the offline bundle is (default `./offline`) |
| `CHECK_ONLY=1` | `02-flash-sd.sh`, `41-write-disk.sh` | run the safety checks only, write nothing (no root needed) |
| `VERIFY_ONLY=1` | `41-write-disk.sh` | only read the disk back and compare it with the image (`sudo env VERIFY_ONLY=1 bash …`) |
| `YES=<serial>` | `41-write-disk.sh` | skip typing the serial number (it must match the disk's) |
| `YES=1` | `24-lock-device.sh` | skip typing `LOCK` |
| `DISK_DIR=<folder>` | `40-make-disk.sh`, `41-write-disk.sh` | where the self-contained disk is built (default `./disk`) |
| `DISK_HOSTNAME=<name>` | `40-make-disk.sh` | hostname of that disk (default `PI_HOSTNAME`) |
| `ROOT_GIB=<n>` | `40-make-disk.sh` | size of the system partition in GiB (default 64) |
| `EDITION`, `HARDWARE`, `FORCE_EDITION=1` | `20`, `22`, `30`, `43` (`40`: `EDITION` only) | choose the edition / hardware profile, or allow an edition above the board's limit ([EDITIONS.md](EDITIONS.md)) |
| `SAFETY_PBF=<file>`, `SAFETY_COVERAGE=<name>` | `13-build-safety.sh` | the `.osm.pbf` to read, and the area name shown in Settings |
| `REFRESH=1` (or `--refresh`) | `10-build-routing.sh` | download the OpenStreetMap extract again instead of reusing the one downloaded before |
| `FONTS_COMMIT=<commit>`, `FONTS_TREE_SHA256=<sum>` | `00-get-bundle.sh fonts` | another commit of protomaps/basemaps-assets, and the sha256 of its glyph files (empty = not checked) |
| `VALHALLA_IMAGE_ID_ARM64`, `VALHALLA_TAG` | all | the arm64 Valhalla image's ID and its local name on the Pi; see `config.env.example` |
| `IMG_OUT`, `EXTRA_FAT` | `01-build-image.sh` | used by `40-make-disk.sh`: another output file, extra files for the boot partition |

The UI test runner has its own settings: [TESTING.md](TESTING.md).

## Troubleshooting

| Symptom | Cause | Fix |
|---|---|---|
| `docker: permission denied` | your user is not in the `docker` group yet, or you did not log in again | `sudo usermod -aG docker "$USER"`, log out and in |
| `f3probe` says counterfeit or damaged | fake or broken card | use another card |
| read-back differs | faulty card reader or card | try another reader |
| writing looks slow | slow reader (~12 MB/s) | writes use direct I/O, so the progress is real; 3 GB ≈ 4 min |
| `03-check-pi.sh` finds no Pi | no Ethernet, or `.local` names don't resolve | pass the IP address from your router; on the PC, install `avahi-daemon libnss-mdns` |
| `REMOTE HOST IDENTIFICATION HAS CHANGED`, or a script stops saying the host key changed | you reflashed the card: same name, new SSH host key | `ssh-keygen -R nav-pi.local` (or the IP address), then run the script again |
| first boot `failed` | see `/var/log/nav-pi-firstboot.log` on the Pi | fix the cause, then `ssh nav@nav-pi.local sudo reboot` (it retries) |
| no map labels | fonts missing | `bash scripts/00-get-bundle.sh fonts`, then `21-push-data.sh` |
| map cut runs out of memory | merged range requests | the script already uses `--overfetch=0` and one download thread; close other big programs |
| `42-add-wifi.sh`: `nmcli` does not know `--offline` | NetworkManager older than 1.40 on the PC | update NetworkManager, or add the network on the Pi (*Settings > Connections*) |
| `sudo` on the Pi says "Illegal instruction" | corrupted card (seen once, after an unverified write) | reflash with `02-flash-sd.sh`, which verifies everything |

Problems on the running device (no map, no route, no sound, Bluetooth, GPS): [OPERATING.md](OPERATING.md#troubleshooting-on-the-device).
