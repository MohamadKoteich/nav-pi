# Features

This is a developer document: one section per folder in `features/`. Which edition carries which feature is in
[EDITIONS.md](EDITIONS.md); the rules every part of the UI follows are in [UI-RULES.md](UI-RULES.md); how the
device is used is in [OPERATING.md](OPERATING.md).

- A **feature** is one folder, `features/<id>/`, with its UI code, its navd module and the Pi packages it needs.
- `tools/build_edition.py` copies only the features of the chosen edition into the Pi's app (`/opt/nav-pi/app`,
  `/opt/nav-pi/navd`). The Pi **packages**, however, are the same on every edition: the setup installs every
  package of the offline bundle, so switching the edition needs no new packages.

## A feature folder

```
features/<id>/
  feature.json      id, name, requires [..], status (stable | planned | idea), min_ram_mb,
                    app {css, js, pre_js, head_css}, fragments {dock, view, settings},
                    pi {packages, services}, data [map, valhalla, search, fonts, imagery, safety]
  *.js / *.css      app code; registers itself: Shell.view(id, {show, hide}), Shell.onLang(fn),
                    Settings.section({cat, open, close, relang}) (cat: opened only while that category shows)
  settings.html     Settings cards; every top-level card carries data-cat="<category>" (UI-RULES.md, "Layout")
  dock.html …       HTML fragments inserted into the page at build time
  navd_<id>.py      optional navd module: def register(app): app.get / post / get_prefix / thread / status
  navd_<id>_*.py    optional helper modules of that navd module (copied with it)
```

- Fragment kinds are `dock`, `view` and `settings`. The builder refuses any other kind; an earlier `quick` kind
  was removed on 2026-11-22.
- `status: idea` features (camera, obd) are skipped by every build until they are built. No feature has
  `status: planned` today.
- Texts live in `features/core/i18n.js` (English is the default, German the second language).
- To add a feature: create the folder, add its id to the editions that should carry it, and build.

Backend tests for all features: `python3 -m unittest discover tests`. Each feature below also lists its own tests.

## Features

### core (every edition)

- The app shell: `index.html` (assembled at build time from every feature's fragments), `shell.js` (dock, views,
  status bar; `Shell.view`, `Shell.onLang`), `settings.js` (the Settings page and its categories, `CATS`),
  `i18n.js` (English and German texts), `keyboard.js` (the on-screen keyboard, [UI-RULES.md](UI-RULES.md#keyboard)),
  `scale.js` (the UI scale, [UI-RULES.md](UI-RULES.md#screen-sizes)), `theme.js` + `solar.js` (light / dark / auto
  from sunrise and sunset, computed offline), `util.js`.
- navd's core, `navd.py`: serves the app, `/edition.js` (the edition plus the region in use), `/api/status`
  (one entry per feature), `/api/probe`, and loads `navd_<id>.py` of every feature in the edition.
- Pi packages: labwc, wlr-randr, chromium, greetd, grim, rsync, fonts-noto-core. The kiosk itself is in `pi/`
  (`session.sh`, `kiosk.sh`).
- Tests: `python3 -m unittest tests/test_static.py`, `node tests/test_solar.js`, `tools/ui-layout-guard.mjs`,
  `tools/ui-keyboard.mjs`, `tools/ui-theme.mjs`.

### nav (every edition)

- The map, search, route preview, turn-by-turn guidance and the simulated drive: `maps.js`, with `guidance.js`
  (maneuvers, voice prompts), `lanes.js` (lane arrows, junction picture), `speedlimit.js` (speed limits from the
  route graph, over-speed warning), `along.js` (places along the route), `roundtrip.js`, `qr.js` + `qrcode.js`
  (share a destination by QR code), `probe.js` (`?probe=1` frame-rate probe), the map styles in `styles/`
  and MapLibre GL JS in `vendor/`.
- navd (`navd_nav.py`): `/tiles/` and `/fonts/` (passed to `pmtiles serve` and read from `/srv/navdata/fonts`),
  `/api/search` (SQLite full-text), `/api/route` (Valhalla), `/api/limits`, `/api/lanes`, `/api/along`.
- Needs the region data (map, route graph, search index, fonts) and Docker for Valhalla. `min_ram_mb` 1800.
- The map opens on Munich (`START` in `maps.js`) until a GPS fix arrives.
- Tests: `node tools/test-lanes.mjs`, `node tools/test-speedlimit.mjs`, `node tools/test-qr.mjs`,
  `python3 -m unittest tests/test_lanes.py tests/test_along.py tests/test_limits_chunks.py`, `tools/ui-routes.mjs`,
  `tools/ui-maptap.mjs`, `tools/ui-lanes.mjs`, `tools/ui-speedlimit.mjs`, `tools/ui-along.mjs`.

### places (every edition)

- The Places page in the rail: Home and Work tiles, favourites, the parked car, recent destinations. It shares
  one store with the Saved places of the Maps search panel (localStorage `navpi.places`, `navpi.parked`,
  `navpi.recents`, kept in Chromium's profile on the device). Details: [UI-RULES.md](UI-RULES.md#layout).
- No navd module: it uses the search and routing of `nav`.
- Test: `tools/ui-places.mjs`.

### display and system

In every edition.


- `display`: orientation, brightness slider, "Dim at night", text and button size.
- `system`: storage, data versions, app version, uptime, Restart / Shut down, and the **Pi health** page
  (processor temperature, load, clock, memory, storage, power supply and throttling, services, 1-hour charts;
  sampled on the Pi, kept in memory only).
- `pi/install-runtime.sh` installs the udev rule (backlight) and the polkit rule (reboot / power-off) they need.

### Updates (part of `system`)

- **Map bundles** (`manifest.json` + region files, built on the build PC by `scripts/30-make-update-bundle.sh`)
  and **app bundles**, from a USB stick or a LAN address.
- A map update is installed next to the old one and switched atomically via `/srv/navdata/current`, with Roll
  back. If two copies do not fit, the map can be replaced in place, only after an explicit warning.
- An OS update with apt, started by the user.
- Never while driving or navigating.
- navd asks for no sudo here: `pi/50-nav-pi-update.rules.in` allows it to start / stop / restart only `nav-pi-tiles`,
  `nav-pi-valhalla`, `nav-pi`, `nav-pi-os-update` and `nav-pi-app-update`. `pi/install-updates.sh` installs the
  rule, the units and their scripts. The rule is not a security boundary: the user navd runs as has
  passwordless sudo, and bundles are not signed ([SECURITY.md](SECURITY.md)).
- Tests: `python3 -m unittest tests/test_updates.py`, `tools/ui-updates.mjs` (recipe in its header;
  `tests/fake-systemctl`).

### wifi (every edition)

- NetworkManager (`nmcli`): list networks, connect with the on-screen keyboard, forget, on/off, in
  *Settings > Connections*. A Wi-Fi icon in the status bar while the radio is on (green = connected), polled every
  30 s.
- Needs `pi/49-nav-pi-wifi.rules.in` (polkit rule for the navd user, installed by `20-setup-pi.sh` /
  `22-update-app.sh`). The feature hides itself where there is no NetworkManager or no Wi-Fi device.
- Tests: `python3 -m unittest tests/test_wifi.py`, `tools/ui-wifi.mjs` (with `NMCLI=tests/fake-nmcli`).

### usb (every edition)

- udisks2: USB sticks are mounted when inserted; free space; Eject = unmount + power-off; a notice on insert and
  removal. `GET /api/usb` returns `[{id, label, path, free, total}]` for other features (for example the GPX
  export).
- **Media import** (audio on the stick → Music / Audiobooks / Podcasts, with progress, skipping identical files,
  never changing the stick) is offered only where `media` exists; basic shows just the stick and Eject.
- Needs the packages udisks2, ntfs-3g, exfatprogs and `pi/49-nav-pi-usb.rules.in` (polkit rule for the navd user,
  installed by `20-setup-pi.sh` / `22-update-app.sh`).
- Tests: `python3 -m unittest tests/test_usb.py` (`tests/fake-usb`), `tools/ui-usb.mjs`.

### voice and lanes (every edition)

- `voice` carries the voice prompt options: `voice.js` (`VoiceOpts`; mute wraps `U.speak`) and a Settings card
  (*Settings > Navigation*: mute, style, turns).
- Lane arrows and the junction picture are part of `nav` (`lanes.js`, navd `POST /api/lanes`), so every edition
  has them.
- Tests: `node tools/test-lanes.mjs`, `python3 -m unittest tests/test_lanes.py`, `tools/ui-lanes.mjs`.

### gps (every edition)

- gpsd relay (`/api/gps` as server-sent events, `/api/gps/info`), the GPS page in the rail, the GPS chip in the
  status bar, and dead reckoning along the route in tunnels.
- Tests: `python3 -m unittest tests/test_gps.py`, `node tests/test_deadreckon.js`, `tools/ui-gps.mjs` (navd with
  `GPSD_PORT=29470`). `tests/fake_gpsd.py` is a fake gpsd; it can also be used by hand:
  `python3 tests/fake_gpsd.py --path route.json`, with the control commands `fix`, `loss`, `unplugged`, `pos`.

### trip (every edition)

- Trip computer A/B and a trip log with replay and GPX export. navd records drives to `/srv/navdata/trips/`
  (created by navd, owned by the navd user).
- Tests: `python3 -m unittest tests/test_trip.py`, `tools/ui-trip.mjs` (navd with `NAV_TRIP_SIM=1 TRIP_END_IDLE=8`;
  without `NAV_TRIP_SIM`, simulated drives are never recorded).

### dashboard (every edition)

- The landscape split screen: the map on the left (62 %), and a column on the right with the clock, trip
  information (while guiding: next maneuver, arrival, distance and time left; otherwise speed and Trip A) and,
  where `media` exists, now playing with play / pause / next.
- Toggle: a map button and a switch in *Settings > Screen* (disabled in portrait), remembered on the device
  (localStorage `navpi.dash`). Portrait = off.
- It reads window events only (`navpi:pos` and `navpi:nav` from maps.js, `navpi:np` from shell.js,
  `window.Media.next`) and redraws once a second. After the toggle it calls `Maps.resize()`.
- Test: `tools/ui-dashboard.mjs`.

### car (every edition)

- Service reminders (oil change, inspection / TÜV, tyres, other) by month and/or km, with optional repeat, stored
  in `/srv/navdata/car/reminders.json` (created by navd; survives browser resets).
- Odometer = the reading the user typed + the km of real drives the trip log recorded since then.
- A due reminder shows a calm notice only when the car stands still (10 s after start, or 90 s after a drive
  ended), never during guidance. *Done* moves it on by its interval, *Tomorrow* snoozes it. Editing is refused
  while moving.
- Tests: `python3 -m unittest tests/test_car.py`, `tools/ui-dashboard.mjs`.

### audio (audio, advanced, full)

- *Settings > Sound*: the output device and the volume through PipeWire (`wpctl`), and a test prompt. navd:
  `GET` / `POST /api/audio`.
- Pi packages: pipewire, wireplumber. `pi/install-runtime.sh` turns on lingering for the user so that PipeWire
  runs from boot.

### bluetooth (audio, advanced, full)

- *Settings > Connections > Bluetooth*: on / off, pair a speaker (scan, then tap it), connect, disconnect,
  remove. Trusted audio devices are reconnected automatically. A Bluetooth icon in the status bar while
  Bluetooth is on (green = a device connected), polled every 30 s.
- Phones pair *to* the Pi: *Media > Phone > Make visible to my phone* opens pairing for 3 minutes, with a
  registered "just works" agent (no PIN; see [SECURITY.md](SECURITY.md)).
- navd (`navd_bluetooth.py`) drives BlueZ through `bluetoothctl`: `GET /api/bt`, `POST /api/bt/<action>`.
- Pi packages: bluez, libspa-0.2-bluetooth.

### media (audio, advanced, full)

- Phone (Bluetooth), Music, Audiobooks, Podcasts. It replaced the earlier `music` and `audiobooks` features on
  2026-11-11. **Basic has no media.**
- The audiobook rules come from `features/media/vendor/reader-core/` (see its `VENDORED.md`).
- Test: `tools/ui-media.mjs`.

### imagery: satellite and aerial photos

In the audio, advanced and full editions; **basic has no imagery**. User-facing overview and licences:
[DATA.md](DATA.md#satellite-and-aerial-photos).

- **Packs** are MBTiles files (TMS scheme) in `/srv/navdata/imagery/<id>.mbtiles`. Packs in the kit
  (`offline/data/imagery/` + `BUILD-INFO`) are copied by `21-push-data.sh` and put on a disk by `40-make-disk.sh`.
- **navd** (`navd_imagery.py`) serves `/sat/<id>/{z}/{x}/{y}` (TMS rows, Content-Type from the bytes, cached
  7 days) and `/api/imagery*` (list, plan, download, pause / resume / cancel, delete, USB list / import).
- **App:** a round "Satellite" map button (in `#fabs`, shown when a pack is installed; a ring = on, but no photos
  in view). It is the only map / satellite switch and is remembered on the device (`navpi.satellite`). Photos sit
  under the labels and the route, only inside a pack's bounds (elsewhere the normal map shows), dimmed at night.
  The attribution is in the map's attribution line (plain text: the kiosk has no links).
- **Settings card "Satellite areas"** (*Settings > Satellite*): installed packs (Show / Delete), download an area
  (the map view or a frame on the map; detail Overview / Standard / High), and import `*.mbtiles` from a USB stick.
- **Provider choice:** each provider has a coarse outline of its coverage (a few km generous). The sharpest
  provider covering the area's centre wins; at equal resolution the smaller region; Sentinel-2 (EOX) last.
- **Providers** (open national or state aerial photography):
  - Germany: Bavaria, Baden-Württemberg, NRW (10 cm), Hesse, Lower Saxony, Bremen, Schleswig-Holstein,
    Mecklenburg-Vorpommern, Berlin (TrueDOP), Brandenburg, Saxony, Thuringia, Rhineland-Palatinate, Saarland
    (20 cm)
  - Austria basemap.at (30 cm), Netherlands PDOK (8 cm), Flanders (15 cm), Wallonia (25 cm), Luxembourg (10 cm,
    CC0), Czechia ČÚZK (25 cm), Spain IGN PNOA (25–50 cm, incl. Balearics / Canaries), metropolitan France IGN
    BD ORTHO
  - elsewhere: EOX Sentinel-2 cloudless 2024, **CC BY-NC-SA, non-commercial only**. Some areas have no open
    aerial source the downloader can use (for example Switzerland, Hamburg, Denmark, Poland, Norway).
- Each provider in `PROVIDERS` (`navd_imagery_plan.py`) has its licence (CC BY 4.0, dl-de/by-2-0, dl-de/zero-2-0,
  Licence Ouverte, Flemish Modellicentie, CC0, or open data without conditions), its attribution string, and a
  `maxzoom` = its native resolution (the detail level is never above it). Requests are WMS 1.1.1 / 1.3.0 GetMap
  in EPSG:3857, or WMTS tiles in the EPSG:3857 / GoogleMapsCompatible matrix (REST or KVP template; `{z:02d}`
  for zero-padded matrix ids).
- **Download:** size estimate and free-space check before starting; a background job with 2 requests at once,
  retries and the User-Agent `nav-pi`; JPEG kept as delivered; written to a hidden `.part` file and renamed when
  complete; an interrupted download resumes.
- Downloads and imports are refused while guiding or moving (faster than 3 m/s).
- Tests: `python3 -m unittest tests/test_imagery.py`, `tools/ui-imagery.mjs` (recipe in its header). Helpers:
  `tools/imagery_extract.py` (cut a smaller pack), `tools/imagery_buildinfo.py`, `tools/imagery_probe.py [ids]`
  (fetches one real tile per provider; run by hand only).

### safety: driver alerts

In the **advanced and full editions only**.

**What it shows.** While guiding, one calm card under the turn arrow (amber = warning, blue = information;
optional chime through `/api/chime`) announces:

- **Sharp curves**, computed in the app from the route's shape: 60 m curvature window, radius < 150 m, turning
  ≥ 30°, advisory speed √(2 m/s² · R). Shown only when the car drives ≥ 40 km/h and at least 10 km/h faster than
  the advisory speed. Turns and roundabouts are left to the turn instructions.
- **Railway level crossings.**
- **Fixed speed cameras**, **opt-in, off by default**. The Settings card says that using a warner while driving
  is illegal in Germany and Switzerland.
- **Entering a low-emission zone** (Umweltzone), comparing the car's sticker (none / red / yellow / green) with
  the zone's. A route preview that enters a zone says so in a notice.
- **Break reminder** after 1.5 / 2 / 3 h of continuous driving (reset by a 15 min stop). It suggests the next rest
  area on the route, or the nearest one; rest areas on the other side of the road (the other carriageway) are
  skipped. It also runs without a route.

A hazard ahead wins over the break card. Points of one crossing or camera within 60 m count as one alert. Each
alert type has its own switch.

**Avoid low-emission zones.** `POST /api/safety/route` (`navd_safety.py`) routes normally, then again with
Valhalla `exclude_polygons` for the zones the route enters (outline simplified to ~200 m, up to 3 rounds). A zone
that holds the start, a stop or the destination cannot be avoided. This needs Valhalla's
`service_limits.max_exclude_polygons_length` (default 10 km of outline) raised: `21-push-data.sh` sets it to
2000 km in the Pi's `valhalla.json` after copying the routing data and restarts `nav-pi-valhalla`
(`40-make-disk.sh` does the same on the disk; the copy on the build PC stays unchanged). Valhalla's time grows
with the number of outline points: Böblingen → Waiblingen around Stuttgart and Ludwigsburg took 19–24 s on the
busy build PC (3 requests; a normal route 0.3 s). UNTESTED on the Pi.

**Data.** `scripts/13-build-safety.sh` reads an OpenStreetMap `.pbf` with `tools/build_safety.py` (a Python
standard-library PBF reader, no osmium). Germany (4.6 GiB `.pbf`): 3 min on 2026-11-23 (24 min once on a busy
build PC).
Output: `work/data/<REGION>/safety/safety.json` (1.6 MB for Germany); `21-push-data.sh` copies it.

- **Coverage is the area of the `.pbf`, not the region.** The Germany extract of 2026-11-23 gave 5 204 cameras,
  59 369 level crossings, 3 776 rest areas and 32 low-emission zones (1.6 MB, 3 min).
- Low-emission zones are the German Umweltzonen tagged `boundary=low_emission_zone` in OSM. A zone that is not
  tagged this way is missing. `access=green_sticker_germany`, or an "Umweltzone" or
  unnamed zone without that tag, is taken as green. Zones for lorries only are left out. A named zone of another
  kind is shown as "own rules".
- Sharp curves work everywhere: they need no data.
- **School zones are not built.** OSM has no usable school-zone tagging for cars (315
  `hazard=school_zone|children` nodes in all of Germany in the 2026-11-23 extract, with no zone geometry or
  times), so a warning based on it would be random.

**Hooks.** maps.js sends `navpi:guide`, `navpi:navstop`, `navpi:preview`, `navpi:routebody` (listeners may change
the route URL) and `navpi:avoidfail`.

**Tests:** `python3 -m unittest tests/test_safety.py`, `node tools/test-safety.mjs`, `tools/ui-safety.mjs` (needs a
Valhalla with the German graph and the raised limit).

### camera and obd: ideas

`camera` (reverse camera) and `obd` (OBD-II car data over an ELM327 adapter) have only a `feature.json` with
`status: idea`. Every build skips them, so the full edition currently builds the same app as advanced.
