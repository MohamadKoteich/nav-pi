# Third-party software, data and closed-source parts

nav-pi's own code is © 2026 MohamadKoteich, licensed under the GNU GPL version 3 (see [LICENSE](../LICENSE) and
the [README](../README.md#licence)). Everything below is **not** nav-pi's and keeps its own licence. The licences
are listed for orientation; the authoritative text is each project's own (on the Pi:
`/usr/share/doc/<package>/copyright`). Check them before you redistribute the files.

If you distribute a device or an image with nav-pi, you also distribute Raspberry Pi OS and its packages. Many of
them are GPL-licensed, so you must offer their source code too. The Debian and Raspberry Pi archives provide it.

## Closed-source parts

**nav-pi's own code and every program it adds to the Pi are open source.** The closed-source parts are all
firmware that comes with Raspberry Pi OS or the hardware. nav-pi neither adds nor changes them:

| Closed part | Where | Why it is there |
|---|---|---|
| Raspberry Pi boot firmware (`raspi-firmware`: `start4.elf`, `fixup*.dat`, …) | the OS image's boot partition | the Pi cannot boot without it; it runs on the VideoCore processor |
| Raspberry Pi bootloader (EEPROM) | on the board itself | part of the Pi 4 / Pi 5 hardware |
| Wi-Fi and Bluetooth chip firmware (`firmware-brcm80211`, `bluez-firmware`) | the OS image | the on-board Wi-Fi/Bluetooth chip needs it |
| Firmware for USB adapters (`firmware-atheros`, `firmware-realtek`, `firmware-mediatek`, `firmware-libertas`) | the OS image | only used if such a USB Wi-Fi/Bluetooth adapter is plugged in |
| GPS receiver firmware | inside the receiver | part of the receiver hardware |

These come from Debian's and Raspberry Pi's `non-free-firmware` sections, as installed by the official Raspberry Pi
OS image. The packages nav-pi adds on top (`offline/pi-debs/`) contain **no** non-free package; this was checked on
2026-11-23 for all 235. Chromium is Debian's open-source build, with no closed plugins. The graphics driver is the
open-source Mesa V3D driver.

**Online services** used only when you start them: the Protomaps build server, Geofabrik and the aerial-photo map
servers deliver open data over HTTP. Optional voice clips are rendered by a text-to-speech HTTP service that you
run yourself (none ships with nav-pi; [DATA.md](DATA.md#voice)), for example one built on Piper. No closed program of theirs runs on your PC or on the Pi. The **Sentinel-2
cloudless** photos are free to use, but for **non-commercial use only** (CC BY-NC-SA 4.0).

## Open-source software on the Pi

| Project | Role in nav-pi | Licence |
|---|---|---|
| [Raspberry Pi OS](https://www.raspberrypi.com/software/) (Debian 13 "Trixie") | the operating system | many: mostly GPL / LGPL / BSD / MIT (plus the firmware above) |
| [Linux kernel](https://kernel.org) | the kernel | GPL-2.0 |
| [systemd](https://systemd.io) | services, boot | LGPL-2.1+ |
| [cloud-init](https://cloud-init.io) | first-boot user, key, hostname | Apache-2.0 / GPL-3.0 (dual) |
| [APT](https://salsa.debian.org/apt-team/apt) (+ apt-utils) | offline package install | GPL-2.0+ |
| [greetd](https://sr.ht/~kennylevinsen/greetd/) | automatic login into the kiosk session | GPL-3.0 |
| [labwc](https://labwc.github.io) | Wayland compositor (display server) | GPL-2.0 |
| [wlr-randr](https://sr.ht/~emersion/wlr-randr/) | screen output, rotation | MIT |
| [grim](https://sr.ht/~emersion/grim/) | screenshots for on-device tests | MIT |
| [Mesa](https://mesa3d.org) (V3D) | GPU driver for WebGL | MIT |
| [Chromium](https://www.chromium.org) (Debian build) | the kiosk browser that runs the app | BSD-3-Clause and others |
| [Firefox ESR](https://www.mozilla.org/firefox/enterprise/) (optional, not installed by default) | alternative kiosk browser | MPL-2.0 |
| [MapLibre GL JS](https://maplibre.org) 5.8.0 (included in this repo) | map rendering in the app | BSD-3-Clause |
| [Python](https://www.python.org) 3.13 | runs navd (standard library only) | PSF License |
| [SQLite](https://sqlite.org) | search index, places-along-the-route, photo packs | public domain |
| [Valhalla](https://github.com/valhalla/valhalla) 3.5.1 | route planning | MIT |
| [docker-valhalla](https://github.com/gis-ops/docker-valhalla) (GIS • OPS) | the Valhalla container image | MIT |
| [Docker Engine / Moby](https://mobyproject.org) (`docker.io`), containerd, runc | runs the Valhalla container | Apache-2.0 |
| [pmtiles / go-pmtiles](https://github.com/protomaps/go-pmtiles) 1.31.2 | serves the map tiles | BSD-3-Clause |
| [gpsd](https://gpsd.io) 3.25 | reads the GPS receiver | BSD-2-Clause |
| [PipeWire](https://pipewire.org) + [WirePlumber](https://pipewire.pages.freedesktop.org/wireplumber/) | sound, Bluetooth audio | MIT |
| [BlueZ](http://www.bluez.org) | Bluetooth | GPL-2.0+ / LGPL-2.1+ |
| [espeak-ng](https://github.com/espeak-ng/espeak-ng) | speech for voice prompts | GPL-3.0+ |
| [NetworkManager](https://networkmanager.dev) | Wi-Fi | GPL-2.0+ |
| [udisks2](https://www.freedesktop.org/wiki/Software/udisks/), ntfs-3g, exfatprogs | USB sticks | GPL-2.0+ |
| [polkit](https://github.com/polkit-org/polkit) | limits what navd may do | LGPL-2.0+ |
| [cloud-guest-utils](https://github.com/canonical/cloud-utils) (`growpart`) | grows the data partition | GPL-3.0 |
| [Noto fonts](https://fonts.google.com/noto) (`fonts-noto-core`, map glyphs from [basemaps-assets](https://github.com/protomaps/basemaps-assets)) | UI and map labels | SIL Open Font License 1.1 |
| reader-core (a small audio-player library, three files included in `features/media/vendor/reader-core/`, see its `VENDORED.md`) | audiobook player rules | GPL-3.0 in this repository |

## Open-source tools on the build PC

| Project | Role | Licence |
|---|---|---|
| Debian / Ubuntu, Bash, coreutils | the build PC | GPL and others |
| [Docker Engine](https://docs.docker.com/engine/) | builds the route graph, saves the Valhalla image | Apache-2.0 |
| Valhalla (same image as on the Pi) | builds the route graph | MIT |
| pmtiles | cuts the map | BSD-3-Clause |
| [Python](https://www.python.org) | data builders, image tools | PSF License |
| [pyfatfs](https://github.com/nathanhi/pyfatfs), [PyFilesystem2](https://github.com/PyFilesystem/pyfilesystem2), appdirs, six, setuptools | writes the image's boot partition without root | MIT |
| [e2fsprogs](https://e2fsprogs.sourceforge.net) (`debugfs`, `mke2fs`), util-linux (`sfdisk`) | reads/writes disk images without root | GPL-2.0 |
| [f3](https://github.com/AltraMayor/f3) | tests SD cards for fake capacity | GPL-3.0 |
| APT | resolves the Pi packages (arm64) | GPL-2.0+ |
| curl, xz, rsync, OpenSSH | downloads, compression, copying to the Pi | curl / 0BSD-style / GPL-3.0 / BSD |
| [Node.js](https://nodejs.org) + [Playwright](https://playwright.dev) (optional) | browser UI tests | MIT / Apache-2.0 |

The Protomaps planet builds are made upstream with [Planetiler](https://github.com/onthegomap/planetiler)
(Apache-2.0), from OpenStreetMap data.

## Data

| Data | Source | Licence / attribution |
|---|---|---|
| Map, search, routing, places along the route, driver alerts | OpenStreetMap, via Protomaps builds and Geofabrik extracts | **© OpenStreetMap contributors**, Open Database License (ODbL) 1.0 |
| Protomaps basemap | [protomaps.com](https://protomaps.com) | ODbL (OpenStreetMap-derived); credit Protomaps |
| Aerial photos (downloaded on demand) | national mapping agencies, for example Bayerische Vermessungsverwaltung (DOP20) and IGN (BD ORTHO) | per provider, mostly open data with attribution (for example CC BY 4.0, Licence Ouverte 2.0) |
| Sentinel-2 cloudless (downloaded on demand) | EOX IT Services, contains modified Copernicus Sentinel data | **CC BY-NC-SA 4.0: non-commercial use only** |

The app shows the map and photo credits on screen. Keep them when you show or publish the map.
