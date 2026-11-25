# Status: what works, what is tested, what is not

nav-pi is a **working prototype**. This page says, for each part, how it was checked. The levels are:

- **On hardware:** run on a real Raspberry Pi 4 or 5 with the 5" Touch Display 2.
- **Automated:** unit tests, or browser tests (Playwright, headless Chromium on the build PC) against the real
  app, real map tiles and a real Valhalla routing engine, with a **simulated** GPS position
  ([TESTING.md](TESTING.md)).
- **Partly:** some of it was run on hardware; the notes say what is still missing.
- **Untested:** built, but never run in the situation it is meant for.
- **Not built:** planned only.

Last updated: 2026-11-24.

The Pi-side numbers (frame rate, route times) come from one Pi 5 8 GB in 2026-11; every other board and every
number marked as an estimate still waits for a real measurement.

## The most important limits

1. **No real drive yet.** Navigation, rerouting, voice prompts, lane guidance and driver alerts have only been
   tested with simulated GPS positions moving along real routes. A u-blox USB receiver was detected by gpsd on a
   Pi 4 (indoors: 2 satellites, no fix). A GPS fix and a real drive have not happened.
2. **No car installation.** 12 V power, a read-only system (so cutting the ignition can't corrupt the card),
   heat and antenna placement are not built.
3. **Touch.** The layout and gestures were checked on the device with synthetic touch events (Chrome DevTools
   Protocol). Hands-on finger use of most screens is not confirmed.
4. **Data from public sources.** The scripts that build the offline bundle and the region data from public
   sources are new. They are tested on the build PC (see [below](#data-built-from-public-sources)), but a Pi has
   not yet been set up from them end to end.

## Hardware

| Item | Level | Notes |
|---|---|---|
| Raspberry Pi 5, 8 GB, SD card (option A) | on hardware | image build, card test + write + read-back, first boot, app and data install with sha256 check on the Pi; map at ~60 fps |
| Raspberry Pi 4, 8 GB | on hardware | runs the advanced edition from an SD card, 5" Touch Display 2, landscape |
| Self-contained disk on a Pi 4 8 GB (option B, 256 GB microSD, Germany + Munich photos) | on hardware | 2026-11-25: written and read back (GNU dd), first boot stopped at the Valhalla image because the bundle lacked `docker-cli` (Debian 13 only recommends it; fixed in `features/nav/feature.json`). After installing it, setup finished: all services active, integrity OK (2), a Munich route answered. Idle after start: 713 MiB RAM used of 7.8 GiB; largest processes Chromium (~270 MiB main + renderers), Valhalla ~175 MiB, labwc ~100 MiB, dockerd ~90 MiB |
| Pi 4 with 2 or 4 GB, Pi 5 with 4 GB | untested | the hardware profiles are estimates |
| Other 64-bit boards (`hardware/90-generic.conf`) | untested | the profile is an estimate |
| HDMI and other touch screens | automated | UI scaling checked at 800x480 up to 1920x1200 in the browser; output and touch mapping on a real HDMI screen untested |
| u-blox USB GPS | partly | detected by gpsd, no fix (indoors) |
| Bluetooth speaker | partly | paired and connected over A2DP, voice streamed to it; automatic reconnect not confirmed |
| Phone audio over Bluetooth | untested | the code path exists, but no real phone has been tried |
| USB sticks, USB keyboard | untested on hardware | tested with fake udisks/lsblk tools |

## App features

| Feature | Level | Notes |
|---|---|---|
| Map, day/night/auto theme, rotation, UI scale | on hardware + automated | |
| Search, Home/Work/favourites, recents | automated | real search index and routing |
| Routing: options, alternatives, stops, parked car | automated | real Valhalla 3.5.1 |
| Guidance: turn card, lanes, junction view, speed + limit, voice | automated | simulated drive along a real recorded route |
| Satellite layer (Munich) | on hardware | simulated drive with photos on the Pi 4; frame rate while really driving unknown |
| Satellite download over Wi-Fi on the Pi | untested | the same downloader was run on the build PC (`tools/build_imagery.py`, 2026-11-23) |
| Places along the route, round trip, share by QR | automated | QR not scanned with a real phone |
| Driver alerts (curves, crossings, cameras, low-emission zones, break reminder) | automated | needs a real drive |
| Media: music, audiobooks, podcasts | automated | playback on the Pi's speaker untested |
| Wi-Fi, Bluetooth, USB, updates, brightness, restart/shut down | automated | with fake system tools; the polkit rules and real device actions are mostly untested |
| Trip computer, trip log, GPX export | automated | |
| On-screen keyboard, map gestures | on hardware (synthetic touch) | real finger use not confirmed |
| Clock set from GPS when offline | untested | needs a GPS fix |
| Offline install (no internet on the Pi) | on hardware | with an earlier bundle, built before the current public-source scripts existed |
| Migration from the earlier name `pi-nav` | automated | `tests/test_migrate.py` on a fake root; not yet run on a device |

## Data built from public sources

Checked on 2026-11-23 on an x86_64 Ubuntu build PC (6 cores, 30 GB RAM):

| Step | Result |
|---|---|
| `00-get-bundle.sh` | all parts downloaded and checksum-verified: OS image (official sha256), pmtiles (pinned sha256), Valhalla arm64 image (config digest = the pinned ID), 235 Pi packages (378 MB), fonts. Total ~1.2 GB in ~4 min |
| Pi packages self-sufficient? | yes: with only the bundle as package source, apt resolves the full install against the OS image's package state (227 new, 8 upgraded, 0 errors). Simulation on the PC, not yet installed on a Pi from this bundle |
| Upper Bavaria: map | `11-build-map.sh` from the newest Protomaps build (2026-11-23, basemap v4.15.2): 518 MB, 7.5 min |
| Upper Bavaria: search | `12-build-search.sh`: 31 MB, 185 484 entries (29 k places, 94 k streets, 63 k POIs), 41 s |
| Upper Bavaria: routing | `10-build-routing.sh` from the Geofabrik extract (261 MB) with Valhalla 3.5.1: 70 tiles, 302 MB, 16 min including the download. No crash (the `admin_access` errors in its log are expected for regional extracts) |
| The app on that data | navd + `pmtiles serve` + Valhalla on the build PC: route Marienplatz → Munich airport (38.8 km, 30 min), offline search answers. `tools/ui-layout-guard.mjs` with a test route in Munich: ALL PASS (898 checks at 1280x720, 720x1280, 800x480, 1920x1080, including route sheet and simulated guidance) |
| The route UI tests (`ui-routes.mjs` and others) on that data | not run on that day: their fixtures were then outside Upper Bavaria. The fixtures have since moved to Munich (Munich to Ingolstadt and to Berchtesgaden), so they run on `oberbayern` data; a full `run-ui-tests.sh` on `oberbayern` on 2026-11-24: 18 of 18 PASS |
| Germany: map | from the same Protomaps build, 4 download threads: 7.6 GiB, 16 min |
| Germany: search, along the route, driver alerts | 454 MB (2.86 M entries) in 15 min; 19 MB (198 k places) in 2.4 min; 1.6 MB (5 204 cameras, 59 369 level crossings, 32 low-emission zones) in 3 min |
| Germany: routing from scratch | `10-build-routing.sh` with Valhalla 3.5.1: 1 151 tiles, 4.9 GiB, 3 h 37 min including the 4.9 GB download. **No crash** (the crash seen once during development did not happen with this extract) |
| The full UI test suite on the Germany data | `bash tools/run-ui-tests.sh` (2026-11-24, 1280x720): all 17 tests that need no photo pack PASS: layout-guard, routes, places, maptap, lanes, along, safety, speedlimit, theme, media, trip, wifi, keyboard, usb, updates, gps, dashboard. Four tests were brought up to date first (current keyboard, current route data, console filter, runner ports). `imagery` needs the Munich photo pack |
| Munich aerial pack | `tools/build_imagery.py` built the full pack on 2026-11-24: 96 154 tiles, 0 refused, 1.2 GB. Its `BUILD-INFO` (`tools/imagery_buildinfo.py`) and the `imagery` UI test with it were not run yet |

## Known issues

- **Route graph builds:** Valhalla 3.5.1 crashed once on an older Germany extract during development; the build
  of 2026-11-23 completed. See [DATA.md](DATA.md#routing) if it happens to you.
- **Search has no house numbers.**
- **Voice** is espeak-ng (robotic) unless you add a recorded voice pack.
- **Protomaps builds expire:** use `PMTILES_SRC=latest` (the default), not a fixed date.
- **No prebuilt data:** you build the region data yourself (see [INSTALL.md](INSTALL.md#3-build-the-region-data)).
- **On-screen keyboard** on very small or very dense screens: some keys are below 44 px (the layout test reports
  this as a warning).

## Not built (roadmap)

- **In the car:** 12 V power, read-only root filesystem, heat management, bootloader update policy.
- **GPS:** automatic receiver detection (also GPIO modules, Bluetooth GPS, phone as GPS), a GPS compatibility
  table, a real-drive test. Plan: [PLATFORMS.md](PLATFORMS.md).
- **Platforms:** Intel N100/N150 mini PCs (amd64), Pi 3 (basic edition only), screen output and resolution
  choice in Settings.
- **Search:** house numbers.
- **Prebuilt data downloads** (so you don't need to build the region yourself).
- **Not planned:** online-only features (live traffic, fuel prices, weather), Android Auto / CarPlay. Phone calls
  and messages, voice commands, OBD-II and a reverse camera are ideas, not commitments.
