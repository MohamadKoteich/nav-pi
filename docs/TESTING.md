# Testing

How to run the app on your PC without tests is in [DEVELOPING.md](DEVELOPING.md).

## Unit tests (no data, no network, a few seconds)

```bash
python3 -m unittest discover tests            # Python: navd features, installers, migration (fake system tools in tests/)
for t in tests/test_*.js; do node "$t"; done  # dead reckoning, sun times
node tools/test-lanes.mjs                     # lane arrows + voice prompts along a recorded route (tools/fixtures/)
node tools/test-safety.mjs
node tools/test-speedlimit.mjs
node tools/test-qr.mjs                        # QR encoder, checked by an independent decoder
```

Run these before every commit. They need Python 3.11+ and Node 20+. No pip or npm packages are needed, and they
change nothing on your PC.

## Browser UI tests (Playwright)

The `tools/ui-*.mjs` scripts drive the **real app** in headless Chromium: the app and navd built from this tree,
real map tiles (`pmtiles serve`), real routing (Valhalla, the same pinned image as on the Pi) and the region's
search index. The GPS position is simulated.

They need Docker, Node.js 20+ and Playwright, the offline bundle's fonts (`bash scripts/00-get-bundle.sh fonts`)
and a built region: map, search and routing from `11-build-map.sh`, `12-build-search.sh` and `10-build-routing.sh`
(see [INSTALL.md](INSTALL.md#3-build-the-region-data)). One command runs them all:

```bash
npm install playwright && npx playwright install chromium     # once (or set PLAYWRIGHT_DIR to an existing node_modules/playwright)
bash tools/run-ui-tests.sh                                    # all tests, region from config.env (oberbayern by default)
bash tools/run-ui-tests.sh routes trip                        # some of them (--list shows the names)
REGION=germany bash tools/run-ui-tests.sh                     # another region you have built
```

The runner works like this:

- It builds the editions and starts the map tile server and Valhalla.
- For each test it starts its own navd on a free port, with a data folder of its own and fake system tools
  (`tests/fake-nmcli`, `fake-systemctl`, `fake-lsblk`, `fake-udisksctl`, `fake_gpsd.py`). Nothing on your PC
  is changed: no Wi-Fi, systemd, USB, backlight or GPS.
- It creates the fixtures each test needs (an audiobook, a USB stick, update bundles, a satellite pack extract).
- It prints PASS / FAIL / SKIP per test, and ends with `<n> test(s) failed` when something failed. Screenshots and
  the logs of failed tests go to `work/ui-shots/` (`OUT=` to change it). A test whose data is missing (the photo
  pack, or a region that does not cover Munich) is SKIPped with the reason.
- It removes everything else when it ends; `KEEP=1` keeps the temp folder.

Runner settings: `SIZE=720x1280` tests portrait (default `1280x720`); `OUT`, `KEEP`, `PLAYWRIGHT_DIR` as above;
`REGION` / `NAVPI_CONFIG` choose the data. A few tests also read their own settings (listed in their header):
`SIZES=` (layout guard: only these screen sizes), `ONLY=` (routes, lanes, along, safety, dashboard: only some
parts), `BASIC=1` (test the basic edition's layout).

| Test | What it checks | Needs |
|---|---|---|
| Test | What it checks | Needs |
|---|---|---|
| `layout-guard` | nothing cut off, overlapping or zoomable at 10 screen sizes (480x320 up to 1920x1200), every page and Settings category | a region that covers Munich |
| `routes`, `places`, `maptap` | route preview, options, alternatives, stops, Home/Work, parked car, map gestures | a region that covers Munich |
| `lanes`, `speedlimit` | lane arrows, junction view, voice options, speed-limit sign along a real route | a region that covers Munich |
| `along` | places along the route, round trip, QR share | a region that covers Munich + `13-build-along.sh` |
| `safety` | driver alerts, speed cameras, low-emission zones | a region that covers Munich + `13-build-safety.sh` |
| `trip`, `gps`, `dashboard` | trip computer + log, GPS page + dead reckoning, split screen | a region that covers Munich |
| `theme` | light / dark / auto | any region |
| `imagery` | satellite layer, downloads (simulated, no network), USB import | `offline/data/imagery/munich.mbtiles` ([DATA.md](DATA.md#satellite-and-aerial-photos)) |
| `media`, `wifi`, `keyboard`, `usb`, `updates` | media player, Wi-Fi, on-screen keyboard, USB import/eject, update bundles | any region |

The map and route tests use fixed places in and around Munich (Munich to Ingolstadt and to Berchtesgaden), so the
small `oberbayern` preset is enough; `germany` and `europe` work too. On a region that does not cover them, the
runner reports these tests as SKIP, not FAIL. The headless browser renders with software GL, so frame rates measured there mean nothing.

**Rule for UI changes:** run `bash tools/run-ui-tests.sh layout-guard` after every UI change, and the whole
suite before a release.

### Running one test by hand

Each `tools/ui-*.mjs` header lists the navd settings it needs. The runner (`tools/run-ui-tests.sh`) shows the
exact command for every test. The basic setup (a running `pmtiles serve` and Valhalla: see
[DEVELOPING.md](DEVELOPING.md#run-the-app-on-your-pc)):

```bash
python3 tools/build_edition.py --edition advanced --out /tmp/navpi-build
APP_DIR=/tmp/navpi-build/app EDITION_FILE=/tmp/navpi-build/edition.json NAV_DATA=<a navdata folder> NAV_PORT=18080 \
NMCLI=tests/fake-nmcli NAV_SYSTEMCTL=tests/fake-systemctl TILES_URL=<pmtiles serve> VALHALLA_URL=<Valhalla> \
python3 /tmp/navpi-build/navd/navd.py
node tools/ui-routes.mjs http://127.0.0.1:18080 /tmp/shots 1280x720
```

### navd settings (environment variables)

navd reads these from its environment. On the Pi, `nav-pi.service` sets `NAV_DATA`, `APP_DIR`, `EDITION_FILE`,
`XDG_RUNTIME_DIR` and `WAYLAND_DISPLAY`; everything else keeps its default. Add more with
`sudo systemctl edit nav-pi`.

| Variable | Default | Meaning |
|---|---|---|
| `NAV_PORT` | `8080` | the port navd listens on |
| `NAV_BIND` | `127.0.0.1` | the address navd listens on. Do not open it to the network: the API has no authentication ([SECURITY.md](SECURITY.md)) |
| `NAV_DATA` | `/srv/navdata` | the data folder (regions, `current`, fonts, media, trips, car, imagery, updates) |
| `NAV_REGION` | the folder `$NAV_DATA/current` links to, else `europe` | the region to serve |
| `APP_DIR` | `app/` next to `navd.py` | the built app (`tools/build_edition.py` output) |
| `EDITION_FILE` | `edition.json` next to `navd.py` | which features to load; without it only the core runs |
| `TILES_URL` | `http://127.0.0.1:8081` | `pmtiles serve` |
| `VALHALLA_URL` | `http://127.0.0.1:8002` | Valhalla |
| `GPSD_HOST`, `GPSD_PORT` | `127.0.0.1`, `2947` | gpsd (`tests/fake_gpsd.py` for tests) |
| `GPS_STALE_S` | `4` | seconds without a position before the fix counts as lost |
| `GPSCLOCK_HELPER`, `GPSCLOCK_EVERY_S` | `/usr/local/lib/nav-pi/set-clock.sh`, `600` | the root helper that sets the clock from GPS, and how often |
| `NMCLI` | `nmcli` | NetworkManager tool (`tests/fake-nmcli`, state in `FAKE_NM_STATE`) |
| `NAV_SYSTEMCTL` | `systemctl` | systemd tool (`tests/fake-systemctl`, log in `FAKE_SYSTEMCTL_LOG`) |
| `LSBLK`, `UDISKSCTL` | `lsblk`, `udisksctl` | USB tools (`tests/fake-lsblk`, `tests/fake-udisksctl`, state in `FAKE_USB_STATE`) |
| `USB_POLL` | `2` | seconds between USB checks |
| `BACKLIGHT_DIR` | `/sys/class/backlight` | screen brightness |
| `NAV_VCGENCMD`, `THERMAL_FILE`, `CPUFREQ_FILE`, `PROC_DIR`, `UPTIME_FILE` | the Pi's tools and files | Pi health readings |
| `NAV_NO_SAMPLER` | empty | `1` = do not sample Pi health in the background |
| `NAV_STATE_DIR` | `/var/lib/nav-pi` | update logs and state |
| `NAV_UPDATE_DIRS` | empty | extra folders (`:`-separated) searched for update bundles, besides USB sticks |
| `NAV_UPDATE_RESERVE` | `500000000` | bytes always kept free by a map update |
| `NAV_REBOOT_FILE` | `/run/reboot-required` | marks that an OS update wants a restart |
| `NAV_IMAGERY` | `$NAV_DATA/imagery` | photo packs |
| `IMAGERY_FAKE_FETCH` | empty | tests only: seconds per fake tile download, no network |
| `ALONG_TILE_KM` | `60` | how far ahead places along the route are read from the map tiles when there is no `along.sqlite` |
| `TRIP_END_IDLE` | `600` | seconds standing still before a recorded drive ends |
| `TRIP_KEEP`, `TRIP_MAX_MB` | `100`, `50` | how many trips, and how many MB of them, are kept |
| `TRIP_MEDIA` | `/media` | where USB sticks are mounted (GPX export) |
| `NAV_TRIP_SIM` | empty | `1` = record simulated drives too (tests) |
| `PIPER_MODEL` | empty | a Piper voice model; with `piper` on the `PATH`, used instead of espeak-ng ([DATA.md](DATA.md#voice)) |
| `NAV_LOG` | empty | `1` = log every HTTP request |
| `WAYLAND_DISPLAY` | `wayland-0` | the kiosk's display (rotation) |

## On the device

Chromium on the Pi exposes the DevTools protocol on `127.0.0.1:9222`, reachable only on the device itself.
Forward it over SSH, then run a test with `--cdp`:

```bash
ssh -N -L 19222:127.0.0.1:9222 nav@nav-pi.local &
node tools/ui-layout-guard.mjs --cdp          # the real screen; restores the device's settings afterwards
node tools/ui-keyboard.mjs --cdp
```

Touch events sent this way are synthetic. A real check needs a finger on the real panel.
Screenshot of the real screen:
`ssh nav@nav-pi.local 'XDG_RUNTIME_DIR=/run/user/$(id -u) WAYLAND_DISPLAY=wayland-0 grim /tmp/s.png'`.
