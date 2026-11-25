# Architecture

nav-pi has two halves:

- **The build PC** does the heavy, one-time work: it downloads public data, cuts the map, builds the route graph and
  the search index, and makes the SD card image or the self-contained disk.
- **The Raspberry Pi** only serves and uses the finished files. nav-pi's services listen on `127.0.0.1` only, so
  it needs no network in normal use. On the network it offers SSH (keys only, can be turned off) and Raspberry Pi
  OS's own mDNS responder (avahi). What this does and does not protect: [SECURITY.md](SECURITY.md).

```
 Build PC (once per region / release)                     Raspberry Pi (in the car, offline)
 ─────────────────────────────────────                    ───────────────────────────────────────────────
 00-get-bundle   OS image, Pi packages, Valhalla,  ──┐     Chromium kiosk (labwc, greetd autologin)
                 pmtiles, fonts                       │        └─ the app: http://127.0.0.1:8080
 11-build-map    Protomaps planet → <region>.pmtiles  │             HTML/JS, MapLibre GL, features/*
 12-build-search map → places.sqlite                  ├──►  navd (Python, stdlib)        127.0.0.1:8080
 10-build-routing OSM extract → valhalla_tiles.tar    │        API for every feature, GPS stream (gpsd),
 01-build-image  card image (rootless)                │        voice, Wi-Fi/Bluetooth/USB, updates, trips
 20/21           install app + copy data over SSH  ───┘     pmtiles serve  (map tiles)    127.0.0.1:8081
 40/41           or: one self-contained disk                Valhalla in Docker (routing)  127.0.0.1:8002
                                                            gpsd (GPS receiver)            127.0.0.1:2947
                                                            data: /srv/navdata/<region>/, current -> <region>
```

## Software stack on the Pi

| Layer | What | Language | Version (bundle of 2026-11-23) |
|---|---|---|---|
| Operating system | Raspberry Pi OS Lite 64-bit (Debian 13 "Trixie", arm64), no desktop | — | image 2026-10-06 |
| First boot | cloud-init + `nav-pi-firstboot.service` (`pi/firstboot.sh`) | Bash | — |
| Login / session | greetd logs the user `nav` in automatically and starts the session (`pi/session.sh`) | Bash | greetd 0.10.3 |
| Display server | labwc, a small Wayland compositor; no desktop, panel or window decorations | C | labwc 0.20.2 |
| Kiosk | Chromium full screen in kiosk mode (`pi/kiosk.sh`, details below); Firefox ESR possible | C++ | Chromium 156 |
| The app (UI) | one web page: plain HTML/CSS/JavaScript, no framework, no build step; MapLibre GL JS draws the map with WebGL | JavaScript | MapLibre GL JS 5.8.0 |
| App backend | **navd**: one Python process, standard library only (threaded HTTP server, JSON API, server-sent events for the GPS stream) | Python 3.13 | — |
| Map tiles | `pmtiles serve`: serves vector tiles straight out of the `.pmtiles` file | Go | pmtiles 1.31.2 |
| Routing | Valhalla `valhalla_service`, in Docker, reading the route graph from one `.tar` file | C++ | Valhalla 3.5.1 (gis-ops image, pinned digest) |
| Search | SQLite full-text index (`places.sqlite`), queried by navd | SQL (SQLite) | — |
| GPS | gpsd (any NMEA/UBX receiver), read by navd over gpsd's JSON protocol | C | gpsd 3.25 |
| Sound | PipeWire + WirePlumber (Bluetooth A2DP/AVRCP via BlueZ), espeak-ng for speech | C | PipeWire 1.4.2, espeak-ng 1.52 |
| Network, USB | NetworkManager (`nmcli`), udisks2 (`udisksctl`), polkit rules limit what navd may do | C | — |

nav-pi's own code: roughly 9 600 lines of Python (navd and its feature modules, data builders, tests), 5 700 lines of
browser JavaScript (the app), 3 100 lines of Node.js test scripts, 1 900 lines of Bash (build and install scripts),
1 000 lines of CSS.

### Why a web page in a kiosk

The UI is a web page because MapLibre GL JS was chosen as the vector map renderer: it is open source, draws on
the GPU with WebGL and runs in any modern browser. So the same app can be tested in a desktop browser
([TESTING.md](TESTING.md)) and runs unchanged on any board. The cost is Chromium's memory use; see
[Resources and bottlenecks](#resources-and-bottlenecks).

### Boot to screen

1. **The firmware** boots Raspberry Pi OS. `systemd` starts gpsd, Docker, `nav-pi-tiles`, `nav-pi-valhalla` and
   `nav-pi` (navd). None of them waits for the network.
2. **greetd** logs in the user `nav` with no password prompt and runs `pi/session.sh`. That script applies
   per-board graphics settings and the touch-screen mapping, then starts labwc.
3. **labwc** runs `pi/kiosk.sh`. That script picks the screen output (a DSI panel first, then HDMI / eDP / DP),
   applies the rotation chosen in Settings, reads the panel's physical size, then starts Chromium with
   `--kiosk` (full screen, no address bar, no tabs) and these flags:
   - `--ozone-platform=wayland`, `--disable-pinch`, no overscroll navigation
   - no first-run, error or crash bubbles; translation turned off
   - `--password-store=basic`
   - its own profile in `~/.config/nav-pi-chromium`
4. **Chromium** opens `http://127.0.0.1:8080/?kiosk=1`. If Chromium or labwc exits, the loop in `kiosk.sh`, and
   greetd itself, start it again.
5. **A managed Chromium policy** (`pi/chromium-policy.json`) turns off the browser's own interruptions: password
   saving, autofill, translation and notification prompts.

Chromium's DevTools port 9222 listens on `127.0.0.1` only. It is used over an SSH tunnel for on-device tests
([TESTING.md](TESTING.md#on-the-device)). Firefox ESR can be used instead of Chromium (`BROWSER=firefox` in
`/etc/nav-pi/session.env`, after installing `firefox-esr`); it is not installed by default.

## What happens when you drive

| Action | Path |
|---|---|
| Map on screen | MapLibre requests tiles from navd (`/tiles/…`) → navd passes the request to `pmtiles serve`, which reads them from `<region>.pmtiles` (random reads on the card) → the browser decodes them in web workers and draws them with WebGL on the GPU |
| Search "Marienplatz" | app → navd `/api/search` → SQLite full-text query, nearby results first (within ~70 km of the map position) |
| Route | app → navd `/api/route` → Valhalla `/route` (car costing, your avoid options) → the app draws the route and the alternatives |
| Guidance | gpsd → navd (a stream of positions to the app) → the app snaps the position to the route, chooses the next maneuver, lanes and voice prompt (`features/nav/guidance.js`, `lanes.js`) → navd `/api/speak` → espeak-ng or recorded clips → PipeWire |
| Off route | the app asks navd/Valhalla for a new route from the current position (rerouting, fully offline) |
| GPS lost (tunnel) | dead reckoning along the route from the last speed (`features/gps/`) until the fix returns |
| Places along the route | navd reads `along.sqlite` (R*Tree index) or, without it, decodes the map tiles ahead (next 60 km); two small Valhalla matrix calls estimate the detour |
| Satellite layer | navd serves tiles from `.mbtiles` packs (SQLite) under the vector labels |

## Map and data sources

| Data | Comes from | Built by |
|---|---|---|
| Vector map | [Protomaps](https://protomaps.com) daily planet build (from OpenStreetMap, basemap schema v4), cut to the region | `scripts/11-build-map.sh` (official `pmtiles` tool) |
| Route graph | [Geofabrik](https://download.geofabrik.de) OpenStreetMap extract, compiled by Valhalla | `scripts/10-build-routing.sh` (the pinned Valhalla image) |
| Search index | the cut map (places, streets, POIs) | `scripts/12-build-search.sh` (`tools/build_search.py`) |
| Places along the route | the cut map's POI layer | `scripts/13-build-along.sh` |
| Driver alerts | the OpenStreetMap extract (cameras, level crossings, low-emission zones) | `scripts/13-build-safety.sh` |
| Fonts | protomaps/basemaps-assets (Noto Sans) | `scripts/00-get-bundle.sh fonts` |
| Aerial photos | national mapping agencies (WMS) or Sentinel-2 cloudless, downloaded per area | on the Pi, or `tools/build_imagery.py` |

Details, sizes and licences: [DATA.md](DATA.md).

## Resources and bottlenecks

Which process needs what, and why:

| Part | CPU | RAM | Notes |
|---|---|---|---|
| **Chromium + MapLibre (the UI)** | the main steady load: decoding vector tiles (web workers) and drawing every frame while the map moves; the GPU does the drawing | **the largest consumer** (measured on a Pi 4 8 GB, idle after start, 2026-11-25: ~270 MiB main process + renderers; whole system 713 MiB) | load grows with screen resolution (`MAP_PIXEL_RATIO`), 3-D tilt (`MAP_MAX_PITCH`), map detail (the zoom level the map was cut to) and the satellite layer (raster tiles) |
| **Valhalla (routing)** | short bursts: about 2–25 ms per car route on a Pi 5 (more for long routes, alternatives and the matrix calls of "places along the route"); idle otherwise | grows with use: graph tiles are read from the `.tar` and cached up to `max_cache_size` (1 GB in the generated config); plus the Docker daemon | `VALHALLA_THREADS` (1–2 per board) caps parallel work; the first route after boot is slower (cold cache, warmed by `pi/warm-valhalla.sh`) |
| **navd** | low: JSON API, GPS stream, small SQLite queries | small | one Python process, standard library only |
| **pmtiles serve** | low | small cache (`--cache-size=256`) | the map file itself is read from the card on demand, never loaded whole |
| **gpsd, PipeWire, espeak-ng** | low; espeak only while speaking | small | — |
| **Storage** | — | — | random reads of map tiles and graph tiles: a fast A2 card or a USB SSD makes panning and the first routes noticeably quicker |

**Bottlenecks, in order:**

1. **RAM, on small boards.** Chromium and the routing cache need the most memory. This is why the 2 GB Pi 4 profile
   allows only the basic edition, with 1 routing thread, no 3-D tilt and a lighter map: above zoom 14 the app enlarges
   the zoom-14 tiles instead of loading more detailed ones (see [hardware/README.md](../hardware/README.md)).
2. **Map drawing on the Pi 4.** The Pi 4's GPU is much weaker than the Pi 5's. Panning and 3-D tilt, at high
   resolution or with satellite photos, are the heaviest UI work. The Pi 4 profiles use a pixel ratio of 1 and less tilt.
3. **Storage speed**, for the first look at a new area and the first routes after boot.

Route planning itself is not a bottleneck: it takes milliseconds, and the work is done before you start driving.

**Tuning settings** (per board, in `hardware/*.conf`, picked automatically from the model and RAM):

| Setting | 2 GB Pi 4 | 4 GB Pi 4 | 8 GB Pi 4 | 4 GB Pi 5 | 8 GB Pi 5 | other boards |
|---|---|---|---|---|---|---|
| default / largest edition | basic / basic | audio / audio | audio / advanced | audio / advanced | advanced / full | basic / advanced |
| `MAP_MAXZOOM` | 14 | 15 | 15 | 15 | 15 | 15 |
| `VALHALLA_THREADS` | 1 | 2 | 2 | 2 | 2 | 2 |
| `MAP_PIXEL_RATIO` | 1 | 1 | 1 | 1 | 1.5 | 1 |
| `MAP_MAX_PITCH` (3-D tilt, degrees) | 0 | 45 | 50 | 55 | 60 | 45 |

Only the 8 GB Pi 5 profile was measured. The 8 GB Pi 4 has run the advanced edition, but its frame rate was not
measured; the other profiles are estimates. See [STATUS.md](STATUS.md) and [hardware/README.md](../hardware/README.md).

**Measured on a Raspberry Pi 5, 8 GB (2026-11-11):** map at about 60 fps, a car route in 2–25 ms. The frame rate
comes from `tools/device-probe.mjs`, which connects to the kiosk over the DevTools port, prints the WebGL
renderer and counts frames for 8 s while the map zooms, tilts and turns
([DEVELOPING.md](DEVELOPING.md#on-the-device)); the app's own `?probe=1` (`features/nav/probe.js`) does the same
and writes the result to the journal. How the route times were taken was not recorded. Every other Pi-side
number on this page is an estimate until it is measured on the board in question.

## Repository layout

| Path | Content |
|---|---|
| `features/<id>/` | one folder per feature: `feature.json` (UI parts, navd module, Pi packages, services), JS/CSS/HTML, `navd_<id>.py` ([FEATURES.md](FEATURES.md#a-feature-folder)) |
| `features/core/` | the app shell (`index.html`, `shell.js`, settings, keyboard, UI scale, theme) and `navd.py` |
| `editions/*.conf` | which features each edition contains (basic ⊂ audio ⊂ advanced ⊂ full) |
| `hardware/*.conf` | board profiles: model + RAM → allowed editions, default edition, tuning (see above) |
| `tools/build_edition.py` | assembles one edition for one board: `app/`, `navd/`, `edition.json`, `packages.txt`, `services.txt` |
| `scripts/` | the build-PC steps, numbered in the order you run them (see [INSTALL.md](INSTALL.md)) |
| `pi/` | everything that runs on the Pi: first boot, installers, kiosk/session, systemd units, polkit/udev rules, update helpers |
| `templates/` | cloud-init `user-data` / `network-config` for the first boot |
| `tools/` | data builders (search, along-route, safety, imagery), image helpers (`fat_inject.py`, `make_disk.py`, `ext4_extract.py`), UI tests and their runner |
| `tests/` | unit tests (Python + Node) and fake system tools (`fake-nmcli`, `fake-systemctl`, …) |
| `regions/` | GeoJSON outlines for region presets (`europe.geojson`) |
| `offline/` | the offline bundle (not in git; see [offline/README.md](../offline/README.md)) |
| `work/`, `disk/` | build output (not in git): region data, images, the self-contained disk |

## Services on the Pi

| Unit | What it does |
|---|---|
| `nav-pi-firstboot.service` | first boot: grows the filesystem, mounts the data partition (self-contained disk), runs the local setup; retries until it succeeds |
| `greetd` → `pi/session.sh` → labwc → `pi/kiosk.sh` | logs the user `nav` in and starts Chromium full screen on the app; comes back after a crash |
| `nav-pi.service` | navd, the app's backend (runs as `nav`) |
| `nav-pi-tiles.service` | `pmtiles serve` for `/srv/navdata/current/map` |
| `nav-pi-valhalla.service` | Valhalla `valhalla_service` in Docker, read-only on `/srv/navdata/current/valhalla` |
| `nav-pi-app-update.service`, `nav-pi-os-update.service` | root one-shots started from *Settings > System > Updates* |

navd runs as the user `nav`. It does not call `sudo` for its normal work; polkit rules allow that user these
actions without a login session:

- the Wi-Fi actions (scan, connect, forget, radio on/off)
- mounting, unmounting and powering off removable drives
- reboot and power-off
- start, stop and restart of five units: `nav-pi-tiles`, `nav-pi-valhalla`, `nav-pi` (after a region switch) and
  the two update units

A sudoers entry allows one helper as root, the one that sets the clock from GPS.

**These rules describe what navd needs; they are not a security boundary.** The user `nav` also has
passwordless sudo for everything (set by `templates/user-data.tmpl`, used by the setup scripts over SSH) and is in
the `docker` group. Anything that runs as `nav`, navd included, can become root. App update bundles are applied
as root by `pi/apply-app-update.sh` and are not signed. See [SECURITY.md](SECURITY.md) for the full picture and
the places to change if you want to harden a device.

Paths: app in `/opt/nav-pi/`, state in `/var/lib/nav-pi/` (update logs, the previous app in `app-prev/`),
settings in `/etc/nav-pi/`, data in `/srv/navdata/`.

## Design decisions

| Decision | Choice | Why |
|---|---|---|
| OS | Raspberry Pi OS Lite 64-bit (Trixie), pinned image | best-supported OS for Pi 4/5; cloud-init first boot; no desktop to carry |
| UI technology | a web page in a Chromium kiosk, MapLibre GL JS for the map | an open-source, GPU-drawn vector map renderer; the same app runs and is tested in any browser |
| First boot | cloud-init creates the user and SSH key; a retrying systemd one-shot (`pi/firstboot.sh`) does the rest | cloud-init's own package step ran before the clock was right (the Pi has no clock battery) and failed |
| Offline install | packages come from a local apt repository built from the bundle (`pi/install-debs.sh`), apt sees only that | against the image's own package lists, apt preferred internet copies of the same versions and failed offline |
| Login | SSH key only, no password set, no generated credentials; optional: no SSH at all | nobody gets a password they didn't choose |
| Image build | rootless: the official image plus files injected into the FAT boot partition (`tools/fat_inject.py`) | works on any Linux PC without loop mounts or root |
| Card writing | safety checks → `f3probe` → direct-I/O write → read-back sha256 | a card written without verification once booted with a corrupted system |
| Heavy work | map cut, route graph and search index on the build PC; the Pi only serves and routes | a Germany graph build wants a PC with 16 GB RAM (recommended; the peak was not measured, about 5 GB was seen); the Pi has an SD card and typically 4–8 GB |
| Map | Protomaps basemap (`.pmtiles`) served locally | one file per region, read on demand, no tile database to import |
| Routing | Valhalla 3.5.1, the same pinned multi-arch image on PC and Pi | the graph built on the PC is always readable by the engine on the Pi |
| Guidance | own JavaScript (`features/nav/guidance.js`, `lanes.js`) on Valhalla's maneuvers | full control over prompts, lanes and rerouting offline |
| Search | own SQLite index with prefix search, built from the map tiles | Photon/Nominatim need a JVM or PostgreSQL and a much bigger index |
| Backend | one Python process (`navd`), standard library only | no pip packages on the Pi, few moving parts, easy to read |
| Editions | features assembled per edition and board (`tools/build_edition.py`) | a 2 GB Pi 4 runs only the app parts it can carry; the Pi packages are the same on every edition (all of the offline bundle is installed) |
| UI | full-screen head-unit shell: starts on the map, left rail (Maps, Places, Media, Trips, GPS, Settings), status bar for information only, one UI scale for every screen | map first, few taps, readable at a glance while driving |
| Not chosen | Organic Maps / CoMaps desktop (no turn-by-turn on Linux), OsmAnd in Waydroid (fragile), Pure Maps + OSM Scout Server (less control) | |
