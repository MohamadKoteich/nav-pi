# Glossary and pipeline

The words the nav-pi documents use, one term per thing.

## From public data to a running Pi

```
 Build PC                                                                         Raspberry Pi
 ─────────────────────────────────────────────────────────────────────            ──────────────────────
 config.env ── 00-get-bundle ──► offline bundle (offline/)                         
                                   OS image, Pi packages, Valhalla image,
                                   pmtiles, fonts
            ── 11-build-map ───► region data (work/data/<region>/)
               12-build-search      map/<region>.pmtiles      + BUILD-INFO
               10-build-routing     search/places.sqlite      + BUILD-INFO
               13-build-* (opt.)    valhalla/valhalla_tiles.tar + BUILD-INFO
                                    along/, safety/ (optional)

 Option A:  01-build-image ─► card image (work/nav-pi.img) ─ 02-flash-sd ─► microSD ─► first boot
            then over Ethernet:  20-setup-pi (packages, routing engine, app)  ──────► navd + kiosk
                                 21-push-data (region data, sha256-checked)   ──────► /srv/navdata/<region>/

 Option B:  40-make-disk ─► self-contained disk (disk/) ─ 41-write-disk ─► USB SSD or big microSD
            first boot sets itself up from the disk, no PC, no network        ──────► navd + kiosk

 Later:     30-make-update-bundle ─► update bundle (USB stick or LAN) ──────────────► Settings > System > Updates
            22-update-app / 43-update-card (app only, from this checkout)
```

## Terms

| Term | Meaning |
|---|---|
| **build PC** | The x86_64 Linux PC that downloads the public data and does all the heavy work. The Pi never builds anything. |
| **offline bundle** | The `offline/` folder, filled by `scripts/00-get-bundle.sh`: the Raspberry Pi OS image, every Pi package, the Valhalla Docker image, the pmtiles tool, the map fonts and a few build-PC helpers, each checksum-verified (`offline/SHA256SUMS`). With it, no later step needs the internet except the region-data downloads. See [offline/README.md](../offline/README.md). |
| **region** | The area you build data for, named by `REGION` in `config.env` (for example `oberbayern`, `germany`). Its box is `REGION_BBOX`, its OpenStreetMap extract `OSM_PBF`. See [DATA.md](DATA.md#region-presets). |
| **region data** | What the `1x-build-*` scripts write to `work/data/<region>/`: the map, the search index, the route graph and, optionally, places along the route and driver alerts. On the Pi it lives in `/srv/navdata/<region>/`; `/srv/navdata/current` links to the region in use. |
| **BUILD-INFO** | A small text file next to each part of the region data (and in `offline/data/imagery/`): source, date, tool version and the sha256 of the result. `21-push-data.sh`, `40-make-disk.sh` and the update bundles check every copy against it. |
| **route graph** | Valhalla's compiled road network for the region, `valhalla/valhalla_tiles.tar`. Built by `10-build-routing.sh` from the Geofabrik `.osm.pbf` extract; read by the same pinned Valhalla image on the Pi. |
| **`.pmtiles`** | The vector map: one file per region, cut from a Protomaps planet build, served by `pmtiles serve`. |
| **`.mbtiles`** | A satellite or aerial photo pack (SQLite, TMS tile scheme), optional. Not tied to a region. See [DATA.md](DATA.md#satellite-and-aerial-photos). |
| **kit** | The `nav-pi` folder as a whole: the code, the offline bundle and, if you keep it there, region data. `06-export.sh` copies the kit to another PC; a self-contained disk carries a copy in `/srv/navdata/kit`. |
| **card image** | `work/nav-pi.img`, built by `01-build-image.sh`: the official Raspberry Pi OS image plus nav-pi's first-boot files on its boot partition. Used for option A. |
| **self-contained disk** | `disk/` (`head.img`, `data.img`, `manifest.json`), built by `40-make-disk.sh`: OS, app, region data and the kit on one disk. Used for option B. |
| **update bundle** | A folder with `manifest.json` (size and sha256 of every file) plus the files, built by `30-make-update-bundle.sh`. Holds either new region data (*map bundle*) or a new app (*app bundle*). Installed from a USB stick or a PC on the LAN in *Settings > System > Updates*. |
| **feature** | One folder `features/<id>/`: UI code, optional navd module, the Pi packages it needs. See [FEATURES.md](FEATURES.md). |
| **edition** | A list of features (`editions/<name>.conf`): basic, audio, advanced, full. See [EDITIONS.md](EDITIONS.md). |
| **hardware profile** | A board description (`hardware/*.conf`): which editions a board may run, its default edition, and tuning (map detail, tilt, routing threads). Picked from the Pi's model and RAM. See [hardware/README.md](../hardware/README.md). |
| **navd** | nav-pi's backend: one Python process (standard library only) that serves the app on `127.0.0.1:8080` and talks to GPS, sound, Wi-Fi, Bluetooth, USB, routing and the map server. systemd unit `nav-pi`. |
| **kiosk** | The screen session: greetd logs the user `nav` in, labwc (a Wayland compositor) starts, Chromium shows the app full screen with no browser controls. |
| **first boot** | The one-time setup on the Pi (`pi/firstboot.sh`, unit `nav-pi-firstboot`): grows the partitions and, on a self-contained disk, installs everything from the disk. It retries on every boot until it succeeds. |

## Option A or option B?

| | Option A: SD card + setup over the network | Option B: self-contained disk |
|---|---|---|
| Medium | microSD card, 64 GB or more | USB SSD, or a microSD card of 128 GB or more (in a USB reader on the PC) |
| Needs during setup | Ethernet between PC and Pi, SSH | nothing: no PC, no network |
| Setup time on the Pi | first boot ~1–5 min, then `20-setup-pi.sh` + `21-push-data.sh` | first boot ~15 min |
| Good for | development, frequent updates over SSH | a finished device, a device for someone else (can be built with no SSH key) |
| Updates | `22-update-app.sh`, `21-push-data.sh`, or update bundles | update bundles from a USB stick or the LAN, or `43-update-card.sh` with the disk in the PC |
| Tested | yes, on a Pi 5 and a Pi 4 | partly: booted on a Pi 4; a fresh first boot with the current scripts is not re-run ([STATUS.md](STATUS.md)) |

Step-by-step: [INSTALL.md](INSTALL.md).
