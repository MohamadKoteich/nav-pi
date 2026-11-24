# Developing

How to run the app on the build PC, how to look at the real device from the PC, and what each helper in `pi/`
and `tools/` does. Tests are in [TESTING.md](TESTING.md); the code layout in
[ARCHITECTURE.md](ARCHITECTURE.md#repository-layout); the feature folders in [FEATURES.md](FEATURES.md); the UI
rules in [UI-RULES.md](UI-RULES.md).

## Run the app on your PC

You need a built region (step 3 of [INSTALL.md](INSTALL.md#3-build-the-region-data), `oberbayern` is enough), the
fonts (`bash scripts/00-get-bundle.sh fonts`) and Docker. The app then runs in any desktop browser against the
same map server, routing engine and navd as on the Pi, with fake system tools so that nothing on your PC is
changed. This is what `tools/run-ui-tests.sh` does for each test; by hand:

```bash
R=$PWD/work/data/oberbayern
IMAGE=$(sed -n 's/^VALHALLA_IMAGE=//p' config.env.example)

# 1. the app and navd of one edition (--force: ignore the board limit)
python3 tools/build_edition.py --edition advanced --force --out /tmp/navpi-build

# 2. map tiles and routing (11-build-map.sh put the pmtiles tool in work/bin/)
work/bin/pmtiles serve "$R/map" --interface=127.0.0.1 --port=18081 &
docker run --rm -d --name navpi-dev-valhalla -p 127.0.0.1:18002:8002 -v "$R/valhalla:/custom_files:ro" \
  --entrypoint valhalla_service "$IMAGE" /custom_files/valhalla.json 2

# 3. a data folder like the Pi's /srv/navdata
mkdir -p /tmp/navpi-data /tmp/navpi-state
ln -sfn "$R" /tmp/navpi-data/oberbayern && ln -sfn oberbayern /tmp/navpi-data/current
ln -sfn "$PWD/offline/data/fonts" /tmp/navpi-data/fonts

# 4. navd with fake system tools
APP_DIR=/tmp/navpi-build/app EDITION_FILE=/tmp/navpi-build/edition.json \
NAV_DATA=/tmp/navpi-data NAV_STATE_DIR=/tmp/navpi-state NAV_PORT=18080 \
NMCLI=tests/fake-nmcli NAV_SYSTEMCTL=tests/fake-systemctl LSBLK=tests/fake-lsblk UDISKSCTL=tests/fake-udisksctl \
BACKLIGHT_DIR=/tmp/navpi-no-backlight TILES_URL=http://127.0.0.1:18081 VALHALLA_URL=http://127.0.0.1:18002 \
python3 /tmp/navpi-build/navd/navd.py
```

navd prints `nav-pi navd on http://127.0.0.1:18080 — edition advanced: … — region oberbayern`. Open
`http://127.0.0.1:18080/` in Chromium or Firefox, with the window at the size of your target screen (1280x720 for
the Touch Display 2). Every navd setting is listed in [TESTING.md](TESTING.md#navd-settings-environment-variables).

- **After a change** in `features/`, build the edition again (step 1) and restart navd: the app is served from
  the built copy, not from `features/`.
- **GPS:** without gpsd the app shows *No GPS*; *Simulate* on a route preview drives it. For a fake receiver, run
  `python3 tests/fake_gpsd.py` (port 29470; `--path route.json` with `[[lon, lat], …]` to drive along a line; the
  control port 29471 takes `fix`, `loss`, `unplugged`, `pos`) and start navd with `GPSD_PORT=29470`.
- **Another edition:** `--edition basic` (or audio, full) in step 1.
- **Stop:** Ctrl-C for navd, `kill %1` for pmtiles, `docker rm -f navpi-dev-valhalla`.

## Screenshots

`tools/ui-shots.mjs` walks through the app in headless Chromium (Playwright, see [TESTING.md](TESTING.md)) and
saves a screenshot of each step: start, map, search, route preview, guidance, night mode.

```bash
node tools/ui-shots.mjs http://127.0.0.1:18080 /tmp/shots 1280x720    # defaults: :18080, tools/shots/, 720x1280
```

The UI tests also leave screenshots in `work/ui-shots/`. The headless browser draws the map with software GL:
the pictures are right, frame rates are not.

## On the device

Chromium on the Pi listens for the DevTools protocol on `127.0.0.1:9222`. Forward it over SSH, then drive the
real screen from the PC:

```bash
ssh -N -L 19222:127.0.0.1:9222 nav@nav-pi.local &
node tools/device-probe.mjs                  # WebGL renderer + frame rate while the map zooms, tilts and turns (8 s)
node tools/device-flow.mjs [query] [out-dir] # types a search on the real keyboard, screenshots each step; ROUTE=1 also previews and simulates
node tools/ui-layout-guard.mjs --cdp         # the layout guard on the real screen (TESTING.md)
```

`device-probe.mjs` is the method behind the frame rates in [ARCHITECTURE.md](ARCHITECTURE.md#resources-and-bottlenecks).
The app can also measure itself: `?probe=1` (`KIOSK_QUERY=probe=1` in `/etc/nav-pi/session.env`) writes the
frame rates to navd's journal (`journalctl -u nav-pi | grep PROBE`). For quick app changes during development,
`bash scripts/22-update-app.sh` copies the new app and navd to the Pi and reloads the screen.

## Tools

### On the Pi (`pi/`)

| File | What it does | Run by |
|---|---|---|
| `firstboot.sh`, `nav-pi-firstboot.service` | first boot: grow partitions, check OS files, mount the data partition, run `setup-local.sh` on a self-contained disk; retried until done | the card image (cloud-init installs the unit) |
| `setup-local.sh` | the whole setup from a self-contained disk (packages, Valhalla image, pmtiles, edition, services) | `firstboot.sh` |
| `install-debs.sh <folder>` | turns a folder of `.deb` files into a local apt repository that apt sees alone, and installs all of them | `20-setup-pi.sh`, `setup-local.sh` |
| `load-valhalla.sh <tar.gz or -> <image ID> <tag> [ref]` | loads the routing engine image if needed, checks its ID against the pinned one and gives it a fixed local name (`nav-pi/valhalla:3.5.1`) | `20-setup-pi.sh`, `setup-local.sh` |
| `install-runtime.sh` | installs one built edition: packages, app, navd, units, kiosk, polkit and udev rules | `20-setup-pi.sh`, `setup-local.sh` |
| `install-updates.sh <user> [folder]` | the update machinery: polkit rule, the two root one-shot units, their scripts | `install-runtime.sh`, `22-update-app.sh` |
| `install-boot.sh <user> [folder]` | the small boot and clock items: `set-clock.sh` + its sudoers line, Chromium policy, gpsd options, Valhalla warm-up, no wait-for-network | `install-runtime.sh`, `22-update-app.sh` |
| `set-clock.sh set <epoch> \| save` | root helper that steps the clock to the GPS time (refuses times before 2026-11-01 or 20 years ahead) and remembers it for the next boot | navd (`features/gps/navd_gps.py`) via `sudo -n` |
| `apply-app-update.sh` | root: re-checks a staged app bundle, keeps the current app in `/var/lib/nav-pi/app-prev/`, installs the new one, restarts navd | `nav-pi-app-update.service` |
| `os-update.sh` | root: `apt-get update` + `upgrade`, state and log in `/var/lib/nav-pi/` | `nav-pi-os-update.service` |
| `warm-valhalla.sh` | one small route after Valhalla starts, so the first real route is not cold | `nav-pi-valhalla.service` |
| `session.sh`, `kiosk.sh` | the kiosk session: graphics device, touch mapping, labwc; screen output, rotation, Chromium | greetd, labwc |
| `migrate-legacy-name.sh` | moves an install of the earlier name `pi-nav` to `nav-pi` | `install-runtime.sh` |
| `*.rules.in`, `chromium-policy.json` | polkit rules (Wi-Fi, USB, updates) and the Chromium policy | the installers |

### On the build PC (`tools/`)

| File | What it does |
|---|---|
| `build_edition.py --edition <e> [--hardware <p> \| --model … --ram …] [--out <dir>] [--force] [--check] [--list]` | assembles one edition for one board: `app/`, `navd/`, `edition.json`, `packages.txt`, `services.txt` |
| `build_search.py`, `build_along.py`, `build_safety.py` | the data builders behind `12-build-search.sh`, `13-build-along.sh`, `13-build-safety.sh` |
| `build_along.py <map.pmtiles \| tile URL> <out.sqlite> [--bbox W,S,E,N] [--threads N]` | places along the route (fuel, parking, toilets, rest areas) from every z15 tile; from the file directly, or through `pmtiles serve` for a small map |
| `build_imagery.py`, `imagery_buildinfo.py`, `imagery_extract.py`, `imagery_probe.py` | photo packs: build one, record its sha256, cut a smaller one, test each provider with one real tile ([DATA.md](DATA.md#satellite-and-aerial-photos)) |
| `build_voicepack.py <out> --url <service>` | recorded voice clips through a text-to-speech HTTP service ([DATA.md](DATA.md#voice)) |
| `make_update_manifest.py map\|app\|size-map\|size-app …` | packs an update bundle and writes its `manifest.json` (size + sha256 of every file, taken from the copy); behind `30-make-update-bundle.sh` |
| `valhalla_subset.py <tile dir> <out.tar> --bbox W,S,E,N [--margin 0.5]` | cuts a region out of an existing Valhalla tile directory (for example a Europe graph); behind `ROUTING_FROM_TILES` |
| `valhalla_coverage.py <tile dir> <out.geojson> [--name <n>]` | writes the area a Valhalla graph covers as GeoJSON and prints its bounding box; `regions/europe.geojson` was made with it, for `REGION_POLYGON` |
| `fat_inject.py`, `make_disk.py`, `ext4_extract.py` | image helpers without root: files into the FAT boot partition, the self-contained disk, files out of an ext4 image |
| `run-ui-tests.sh`, `ui-*.mjs`, `test-*.mjs` | the tests ([TESTING.md](TESTING.md)) |
| `device-probe.mjs`, `device-flow.mjs` | the real device over DevTools ([above](#on-the-device)) |
| `ui-shots.mjs` | screenshots of a user flow ([above](#screenshots)) |
| `record_lanes.py`, `record_limits.py` | record the test fixtures in `tools/fixtures/` ([below](#regenerating-the-test-fixtures)) |

### Regenerating the test fixtures

`node tools/test-lanes.mjs` and `node tools/test-speedlimit.mjs` run on recorded Valhalla answers, so they need
no data. Record them again after a Valhalla upgrade or a change of the route-graph build, with a Valhalla that
serves `oberbayern` (or a larger region), for example the one from [Run the app on your PC](#run-the-app-on-your-pc):

```bash
VALHALLA_URL=http://127.0.0.1:18002 python3 tools/record_lanes.py
#   -> tools/fixtures/lanes-munich-ingolstadt.json (Munich -> Ingolstadt on the A9, lanes through navd_nav.lanes())
python3 tools/record_limits.py http://127.0.0.1:18002 tools/fixtures/limits-munich.json 48.1402,11.5600 48.2595,11.4347
#   -> Munich Hauptbahnhof -> Dachau: /route + /trace_attributes for the speed-limit mapping
node tools/test-lanes.mjs && node tools/test-speedlimit.mjs
```

The tests check behaviour along the recorded route, so a re-recorded route can change their expected values:
read the failures before you commit new fixtures.
