# nav-pi

**Offline car navigation and media head unit for the Raspberry Pi.**

nav-pi turns a Raspberry Pi 4 or 5 with a touch screen into a car navigator that works with **no internet
connection at all**: offline map, offline route planning with turn-by-turn voice guidance, offline search for
places and streets, plus a media player (Bluetooth audio from a phone, music, audiobooks, podcasts). It has no
account, no cloud service and no telemetry. It only goes online when you start something that needs it, such as
downloading satellite photos over Wi-Fi.

The heavy work (cutting the map, building the route graph and the search index) is done once on a Linux
**build PC**. The Pi receives the finished files and only does the live work: drawing the map, routing and
guidance.

> **Before you start**
>
> - **What you end up with:** a Raspberry Pi with a touch screen that boots straight into an offline navigator
>   and media player, with the map, routes and search for one region (Upper Bavaria by default, any other area
>   you build).
> - **Who it is for:** people comfortable in a Linux terminal. You need a **Linux PC (x86_64) with Docker** to
>   build everything yourself; there are **no prebuilt images or map downloads**.
> - **Time:** about 1 hour end to end for Upper Bavaria (download, build, card, setup), about 5 hours for all of
>   Germany. Mostly waiting.
> - **Parts:** a Raspberry Pi 4 or 5 (8 GB recommended), the Raspberry Pi Touch Display 2, a genuine microSD card
>   (64 GB or more) or a USB SSD, a 5 V bench power supply (5 A USB-C for a Pi 5), an Ethernet cable for the
>   setup, optionally a u-blox USB GPS receiver and a Bluetooth speaker. Details: [Hardware](#hardware).
> - **Screenshots:** none are published yet. `tools/ui-shots.mjs` walks through the app in a headless browser and
>   saves screenshots of every step ([docs/DEVELOPING.md](docs/DEVELOPING.md)).

> **Project status: working prototype, not yet road-tested.** The app runs on real Raspberry Pi 4 and 5
> hardware with a 5" touch screen. Navigation has only been tested with **simulated GPS positions**. A real
> drive with a GPS receiver has not been done yet, and the in-car installation (12 V power, heat, read-only
> system) is not built. See **[docs/STATUS.md](docs/STATUS.md)** for exactly what was tested, how, and what wasn't.

---

## Features

- **Map:** vector map (OpenStreetMap data, Protomaps basemap) drawn with MapLibre GL JS. Day, night or automatic
  theme (from sunrise and sunset, computed offline). Optional satellite / aerial photo layer.
- **Routing:** Valhalla routing engine running on the Pi, with alternative routes, stops, avoiding
  motorways / tolls / ferries / unpaved roads, and offline rerouting.
- **Guidance:** turn card, lane arrows, junction pictures, ETA bar, current speed and speed limit, and spoken
  prompts (espeak-ng; recorded clips can be added, see [docs/DATA.md](docs/DATA.md#voice)). English and German UI.
- **Search:** offline search for places, streets and points of interest (no house numbers yet). Home, Work,
  favourites, recent destinations, parked-car marker, places along the route (fuel, parking, toilets, rest areas).
- **Driver alerts** (advanced and full editions, from OpenStreetMap data): sharp curves, level crossings, speed
  cameras (opt-in), low-emission zones, break reminder.
- **Media:** phone audio over Bluetooth (A2DP/AVRCP), local music, audiobooks and podcasts (with resume). Music
  is lowered while the voice speaks.
- **Device:** Wi-Fi and Bluetooth settings, USB sticks (import media, export trips as GPX), trip computer and
  trip log, split-screen dashboard, brightness, rotation, UI size for any screen, offline app and map updates
  from a USB stick or a PC on the LAN.

The Pi installs one of four **editions**: basic, audio, advanced or full. An edition is a set of features; the
setup picks one that fits the board's model and RAM (for example, a 2 GB Pi 4 gets basic). You can choose another
one within the board's limit. See [docs/EDITIONS.md](docs/EDITIONS.md).

## How it works

- **OS:** Raspberry Pi OS Lite 64-bit (Debian 13), with no desktop. It boots straight into a **kiosk** (a single
  full-screen app): greetd logs in automatically, the labwc Wayland compositor starts, and Chromium runs full
  screen with no browser controls.
- **The UI** is a web page: plain HTML/CSS/JavaScript, no framework. The map is drawn on the GPU by **MapLibre GL JS**.
- **The backend, navd**, is one Python process (standard library only). It serves the app and its API, and talks
  to the GPS (gpsd), sound (PipeWire, espeak-ng), Wi-Fi (NetworkManager) and USB (udisks2).
- **Map tiles** are served by `pmtiles serve` from one file per region.
- **Routing** runs in **Valhalla** (C++, in Docker).
- **Search** uses an SQLite full-text index.
- **Map data** is OpenStreetMap: the map from Protomaps builds, the routing graph from Geofabrik extracts.
- **Resource use:** Chromium drawing the map uses the most RAM and causes the steady CPU/GPU load. Routing takes
  milliseconds per route, plus a graph cache in RAM.

Details, bottlenecks and tuning per board are in [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md).

## Hardware

| Part | Recommendation | Notes |
|---|---|---|
| Board | Raspberry Pi 4 or 5, **8 GB recommended** | the hardware profiles span 2 GB (basic edition only) to 16 GB. Run on hardware: Pi 5 8 GB and Pi 4 8 GB. The other profiles are estimates ([hardware/](hardware/README.md)) |
| Screen | Raspberry Pi Touch Display 2 (5" or 7") | tested on the 5". The UI scales to HDMI and other touch screens, but this is not tested on hardware |
| Storage | genuine microSD card, 64–256 GB, A2 class, **or** a USB SSD | the flash script tests the card for fake capacity first. A self-contained disk needs more than 64 GB ([INSTALL.md](docs/INSTALL.md#option-b-a-self-contained-disk)) |
| GPS | USB receiver with a **u-blox M8/M9/M10** chip and an external antenna | a u-blox receiver was detected by gpsd on a Pi 4 (indoors, no fix). A real drive is untested |
| Sound | Bluetooth speaker, USB audio adapter, or HDMI audio | the Pi 5 has no headphone jack |
| Cooling | Pi 5 Active Cooler or a cooling case for the Pi 4 | cars get hot |
| Power for the setup | official supply: 27 W USB-C (5 V, 5 A) for a Pi 5, 15 W (5 V, 3 A) for a Pi 4 | a weak supply causes random failures |
| Car power | 12 V → 5 V, 5 A converter | car installation is not built yet |

**Build PC:** a 64-bit x86_64 Linux PC (tested with Debian and Ubuntu) with Docker (your user in the `docker`
group), `sudo` (only for writing the card or disk), internet for the one-time downloads, and enough RAM and disk
space for your region (see [Regions](#regions) below). The full list is in
[INSTALL.md](docs/INSTALL.md#0-requirements).

## Quick start

Full step-by-step guide: **[docs/INSTALL.md](docs/INSTALL.md)**. In short:

```bash
git clone https://github.com/MohamadKoteich/nav-pi.git && cd nav-pi
cp config.env.example config.env        # region (Upper Bavaria by default), hostname, timezone, keyboard

bash scripts/00-get-bundle.sh           # 1. downloads OS image, Pi packages, routing engine, tools (~1.2 GB)
bash scripts/11-build-map.sh            # 2. map for your region (public OpenStreetMap / Protomaps data, ~8 min)
bash scripts/12-build-search.sh         #    search index (~1 min)
bash scripts/10-build-routing.sh        #    route graph (~16 min)
bash scripts/01-build-image.sh          # 3. the SD card image (no root needed)
sudo bash scripts/02-flash-sd.sh        # 4. tests the card, writes it, reads it back
#    card into the Pi, Ethernet cable, power on, then:
bash scripts/03-check-pi.sh             # 5. waits for the Pi, prints a health report
bash scripts/20-setup-pi.sh             # 6. installs packages, routing engine and the app (no internet needed)
bash scripts/21-push-data.sh            # 7. copies map, routes and search to the Pi
```

Each step ends with a clear success line (listed in [INSTALL.md](docs/INSTALL.md)); on a problem it stops with
`STOP: <reason>`. First steps on the device: [docs/OPERATING.md](docs/OPERATING.md).

**Next step: all of Germany.** Switch `config.env` to the `germany` preset (written out there) and run steps 2
and 7 again. It takes about 4.5 hours on a 6-core PC and ~35 GB of disk space.

Alternatively, `scripts/40-make-disk.sh` and `41-write-disk.sh` build **one self-contained disk** (a USB SSD or a
microSD card) that holds the OS, the app and the region data. The Pi sets itself up from it on the first boot,
with no PC and no internet (see [docs/INSTALL.md](docs/INSTALL.md#option-b-a-self-contained-disk)).

### Regions

A **region** is the area whose map, route graph and search index you build. `config.env.example` has three
presets:

| Preset (`config.env`) | Map | Routing | Build PC (RAM recommended, peak not measured) | Status |
|---|---|---|---|---|
| `oberbayern` (Upper Bavaria incl. Munich, default) | 0.5 GB | 0.3 GB | 8 GB RAM, ~12 GB disk, ~25 min | built and tested from public sources on 2026-11-23 |
| `germany` | 7.6 GiB | 4.9 GiB | 16 GB RAM, ~35 GB disk, ~4.5 h | built and tested from public sources on 2026-11-23/24 |
| `europe` | ~48 GB | ~34 GB | an existing Europe route graph | the route graph cannot be built from scratch on a normal PC |

Germany takes a few hours to build, mostly the route graph (3.6 h on a 6-core PC). Any other area works the same
way: [docs/DATA.md](docs/DATA.md#your-own-region).

**No prebuilt data is published yet.** You build the region data yourself with the scripts above, from public
OpenStreetMap data.

## Documentation

| Document | Content |
|---|---|
| [docs/GLOSSARY.md](docs/GLOSSARY.md) | the terms used everywhere, a diagram of the build pipeline, option A or B |
| [docs/INSTALL.md](docs/INSTALL.md) | step-by-step setup: bundle, data, SD card or self-contained disk, first boot, updates |
| [docs/OPERATING.md](docs/OPERATING.md) | using the device: first steps, Bluetooth, Wi-Fi, GPS, maps and updates on the device, roll back, reset, troubleshooting |
| [docs/SECURITY.md](docs/SECURITY.md) | the security model: what is protected, what is not, how to harden it |
| [docs/DATA.md](docs/DATA.md) | where each piece of data comes from, sizes, licences, satellite photos, voice |
| [docs/STATUS.md](docs/STATUS.md) | what is tested on hardware, what is only tested automatically, what is untested, known issues, roadmap |
| [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md) | how it works: OS, kiosk, languages, UI, map sources, CPU and RAM use, bottlenecks, design decisions |
| [docs/EDITIONS.md](docs/EDITIONS.md) | editions (feature sets) and hardware profiles |
| [docs/DEVELOPING.md](docs/DEVELOPING.md) | for developers: running the app on the PC, the helper tools |
| [docs/TESTING.md](docs/TESTING.md) | for developers: unit tests, browser UI tests, navd settings |
| [docs/FEATURES.md](docs/FEATURES.md) | for developers: the feature folders, one section each |
| [docs/UI-RULES.md](docs/UI-RULES.md) | for developers: layout, screen sizes, keyboard, map gestures |
| [docs/PLATFORMS.md](docs/PLATFORMS.md) | for developers: plans for other boards, screens and GPS receivers |
| [hardware/README.md](hardware/README.md) | hardware profiles (Pi model + RAM → edition, tuning) |
| [offline/README.md](offline/README.md) | the offline bundle: what is in it and where it comes from |
| [docs/THIRD-PARTY.md](docs/THIRD-PARTY.md) | the open-source projects used, the data sources, their licences, and the closed-source parts |
| [CONTRIBUTING.md](CONTRIBUTING.md) | how to contribute, and the licence terms for contributions |

## Privacy and security

- **Offline by default.** Nothing connects to the internet unless you start it (satellite downloads, OS updates).
  Map, routing, search and voice all run on the device. nav-pi's services (navd, map tiles, routing, gpsd) listen
  on `127.0.0.1` only. On the network, the Pi offers SSH (keys only, can be turned off) and the mDNS name service
  of Raspberry Pi OS.
- **No passwords.** The image creates the user `nav` with SSH **key** login only (the build PC's public key).
  No password is set. For a device you give away, `scripts/24-lock-device.sh` removes every key and turns SSH
  off, or you build a self-contained disk with `SSH_PUBKEY_FILE=none`
  (see [INSTALL.md](docs/INSTALL.md#handing-a-device-over)).
- **No telemetry or accounts.** Trips, places and settings stay on the device. Chromium runs as a kiosk with
  password saving, autofill, translation and notifications turned off by policy.
- **Not protected against physical access.** The user `nav`, which also runs the app's backend, has passwordless
  sudo; update bundles from a USB stick are checked for damage but not signed, and the card is not encrypted. So
  anyone who can touch the device can take it over, even after `24-lock-device.sh`. **The security of a device
  you build is your responsibility:** [docs/SECURITY.md](docs/SECURITY.md) says what is and isn't protected and
  where to harden it.

## Contributing

Bug reports, test results from real hardware and pull requests are welcome. Results from a real drive with a GPS
receiver, or from boards and screens that are not tested yet, are especially useful. Before you open a pull
request, run the tests ([docs/TESTING.md](docs/TESTING.md)) and read [CONTRIBUTING.md](CONTRIBUTING.md), which
also sets out the licence terms for contributions.

## Licence

nav-pi is free software: you can redistribute it and/or modify it under the terms of the **GNU General Public
License version 3** ([LICENSE](LICENSE)). Copyright © 2026 MohamadKoteich.

In short (the full terms are in [LICENSE](LICENSE); this summary does not replace them):

- **You may** use nav-pi, study it, change it, and share or sell it, also built into a device.
- **If you distribute it, changed or not** (as code, an image or a device), you must give the recipients the
  complete source code of your version under the same GPL-3.0 terms. You may not add closed-source parts to it.

**Other licence terms** (for example, a product with closed parts) are available only from the copyright holder.
Contributions are accepted on the terms in [CONTRIBUTING.md](CONTRIBUTING.md).

**Open source:** nav-pi and every program it installs are open source. The only closed-source parts are firmware
that comes with Raspberry Pi OS and the hardware: the Pi's boot firmware and bootloader, and Wi-Fi/Bluetooth and
GPS chip firmware. Details: [docs/THIRD-PARTY.md](docs/THIRD-PARTY.md#closed-source-parts).

Third-party components (Raspberry Pi OS and its packages, MapLibre GL JS, Valhalla, pmtiles, gpsd, Chromium and
others) and data (© OpenStreetMap contributors, ODbL; Protomaps basemap; aerial photography providers) keep their own
licences. See [docs/THIRD-PARTY.md](docs/THIRD-PARTY.md). If you show the map, keep the
"© OpenStreetMap contributors" credit.
