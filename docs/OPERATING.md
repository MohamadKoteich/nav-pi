# Using and maintaining a nav-pi

This page starts where [INSTALL.md](INSTALL.md) ends: the Pi shows the map. It covers the first use on the
device, keeping the data current, rolling back, resetting, cleaning up the build PC, and what to look at when
something does not work. Which parts you have depends on the edition ([EDITIONS.md](EDITIONS.md)): basic has no
Media, Bluetooth or satellite photos; only advanced and full have driver alerts.

Nothing on the device has been tested on a real drive yet ([STATUS.md](STATUS.md)).

## First use

**The screen.** The app starts on the map, centred on Munich until the GPS has a fix. The rail on the left (a bar
at the bottom in portrait) has Maps, Places, Media, Trips, GPS and, at the end, Settings. The status bar at the
top only shows information: clock, what is playing, Bluetooth, Wi-Fi and GPS.

**Language.** *Settings > System > Language*: English (default) or German. It also sets the voice and the turn
instructions.

**Search and drive.**

1. Tap *Where to?* on the map and type with the on-screen keyboard (hold a key for accents). Search finds towns,
   streets and places offline, nearby ones first. It has **no house numbers**.
2. Tap a result: the route preview shows the route, alternatives (tap the grey line) and the arrival time.
   *Route options* avoids motorways, tolls, ferries or unpaved roads; *Add stop* adds stops.
3. *Go* starts guidance: turn card, lanes, speed and limit, voice prompts. Off the route, it recalculates by
   itself.
4. Without a GPS fix you can still try it: *Simulate* drives the route.

A **long press** on the map (half a second) opens a sheet for that point: *Drive here*, *Start here*, *Park here*,
*Save*. A short tap does nothing, on purpose ([UI-RULES.md](UI-RULES.md#map-gestures)).

**Home, Work and favourites.** On the *Places* page, tap *Home* or *Work* and choose an address (search, *My
position*, or the map centre). *Add* or the star on a route preview saves a favourite. *Park here* on a long press
marks the parked car; its *P* marker offers the walk back. Recent destinations appear here and in the search
panel. All of this is stored on the device only.

**GPS.** Plug in a USB receiver (a u-blox chip is the tested kind) and put its antenna where it sees the sky. gpsd
finds it by itself. The *GPS* page shows the receiver, the satellites and the fix (2D or 3D); the GPS chip in the
status bar turns from *No GPS* to *GPS searching* to *GPS*. A first fix outdoors can take a few minutes. In
tunnels the position is estimated along the route for a few minutes. With a fix, the Pi also sets its clock
from GPS (it has no clock battery). A GPS fix on a real drive has not been tested yet.

**Wi-Fi** (only needed for satellite downloads, OS updates and LAN updates). *Settings > Connections > Wi-Fi >
Search networks*, tap a network, type the password, *Connect*. A phone hotspot works like any other network.
From the PC you can also put a network on the card or disk with `42-add-wifi.sh` ([INSTALL.md](INSTALL.md#option-b-a-self-contained-disk)).

**Bluetooth** (audio, advanced, full).

- **A speaker:** put it in pairing mode, then *Settings > Connections > Bluetooth > Pair new device* and tap it.
  Paired speakers reconnect by themselves.
- **A phone** (to play its music, podcasts or audiobooks through the car): *Media > Phone > Make visible to my
  phone*. For the next 3 minutes, choose `nav-pi` in the phone's Bluetooth menu. Pairing needs no PIN, so do it
  where nobody else is pairing ([SECURITY.md](SECURITY.md)). Afterwards the phone reconnects by itself.

**Sound.** *Settings > Sound*: output device, volume, *Test voice*. *Settings > Navigation*: voice prompts (mute,
full or short, all turns or major ones only) and the speed warning. Music is lowered while the voice speaks.

**Media** (audio, advanced, full). The *Media* page has *Phone*, *Music*, *Audiobooks* and *Podcasts*. Put files
on the device in one of two ways:

- from the build PC: `bash scripts/23-push-media.sh <folder> Music|Audiobooks|Podcasts [host]`
- from a USB stick: plug it in, *Settings > Connections > USB > Import music*, and choose where each folder goes.
  Nothing on the stick is changed.

Formats: mp3, m4a, m4b, aac, ogg, opus, flac, wav. Audiobooks and podcasts resume where you stopped and have a
playback speed and a sleep timer.

**Satellite photos** (audio, advanced, full). *Settings > Satellite > Download an area*: use the map view or
choose a frame on the map, pick the detail, *Download*. It needs Wi-Fi with internet and works only while parked;
an interrupted download resumes. Packs built on the PC or copied to a USB stick can be imported there too. The
round *Satellite* button on the map then switches the photos on and off. Check each provider's licence: the
Sentinel-2 photos used outside the national aerial services are for non-commercial use only
([DATA.md](DATA.md#satellite-and-aerial-photos)).

**Driver alerts** (advanced, full). *Settings > Driver alerts*: sharp curves, level crossings, break reminder,
speed cameras (off by default; check your country's law first) and low-emission zones with your car's sticker.
They need the data from `13-build-safety.sh`, except sharp curves.

**Screen.** *Settings > Screen*: light / dark / auto (from sunrise and sunset), rotation, brightness, dim at
night, text and button size, split screen (landscape only).

**Other.** *Trips*: trip computer A/B and a log of drives with replay and GPX export to a USB stick. *Settings >
Car*: service reminders by date or km. *Settings > Pi health*: temperature, load, memory, storage, power supply
and the services. *Settings > System*: versions, free space, *Restart*, *Shut down*.

### Terminal on the screen

With a USB keyboard plugged into the Pi, **Settings > System > Terminal** (or **Ctrl+Alt+T**) opens a full-screen
terminal (`foot`) over the app, logged in as `nav`. `sudo` works without a password (see
[SECURITY.md](SECURITY.md)). Type `exit` to close it and get the app back. Typical uses: `sudo nmtui` to set up
Wi-Fi, `journalctl -u nav-pi` to read logs, `nano ~/.ssh/authorized_keys` to add an SSH key.

## Map data on the device

*Settings > System > Updates* lists the **map data on this unit**: the region in use, the previous one, and any
other. Updates only work while parked and not navigating.

- **Install newer map data:** build it on the PC ([INSTALL.md](INSTALL.md#refreshing-a-region-with-newer-openstreetmap-data)),
  then a map bundle from a USB stick or the LAN, or `21-push-data.sh` over SSH.
- **Roll back** to the previous map: *Roll back to previous map*. Rolling back again goes forward.
- **Delete** a region you no longer need: its *Delete* button (not offered for the one in use). Over SSH:
  `ls /srv/navdata` shows the regions; `rm -rf /srv/navdata/<region>` removes one that `current` does not point
  to (`readlink /srv/navdata/current`).
- **Switch** to another region you pushed earlier: run `21-push-data.sh` with that `REGION` again (it copies
  nothing new and switches), or install it as a map bundle.

## App updates and rolling back

| Updated with | Previous version kept in | Roll back |
|---|---|---|
| an app bundle (*Settings > System > Updates*) | `/var/lib/nav-pi/app-prev/` (app, navd, edition.json; one generation) | over SSH, see below |
| `43-update-card.sh` (card in the PC) | `/opt/nav-pi/app.prev`, `/opt/nav-pi/navd.prev` | move them back, the same way |
| `22-update-app.sh` (over SSH) | nothing | check out the older commit on the PC and run `22-update-app.sh` again |

Roll back an app bundle over SSH:

```bash
ssh nav@nav-pi.local
P=/var/lib/nav-pi/app-prev
sudo rsync -a --delete $P/app/ /opt/nav-pi/app/
sudo rsync -a --delete $P/navd/ /opt/nav-pi/navd/
sudo install -m 0644 $P/edition.json /opt/nav-pi/edition.json
sudo systemctl restart nav-pi
```

Without SSH (a locked device), install an app bundle of the older version: the Pi marks it *older than
installed* and offers *Install anyway*. The log of the last app update is `/var/lib/nav-pi/app-update.log`.

**OS updates:** *Settings > System > Updates > Update system (apt)*, with Wi-Fi and internet. It never starts by
itself. Log: `/var/lib/nav-pi/os-update.log`.

## Reset and reflash

There is no factory-reset button. Two ways:

- **Reflash** (everything goes): write the card again with `02-flash-sd.sh` and repeat option A, or write the disk
  again with `41-write-disk.sh`. Afterwards the PC needs `ssh-keygen -R nav-pi.local`, because the Pi has a new SSH
  host key.
- **Remove only the personal data**, over SSH:

  | Data | Where |
  |---|---|
  | places, recents, parked car, keyboard and screen choices | Chromium's profile: `~nav/.config/nav-pi-chromium/` |
  | trips | `/srv/navdata/trips/` |
  | service reminders, odometer | `/srv/navdata/car/` |
  | media | `/srv/navdata/media/` |
  | Wi-Fi networks and passwords | `/etc/NetworkManager/system-connections/` |
  | Bluetooth pairings | `/var/lib/bluetooth/` |
  | rotation, brightness | `/srv/navdata/rotation`, `/srv/navdata/brightness.json` |

  Stop the kiosk and navd first (`sudo systemctl stop greetd nav-pi`), delete, then reboot.

None of this is a secure erase: see [SECURITY.md](SECURITY.md) before you give a device away.

## Cleaning up the build PC

Everything nav-pi writes on the build PC:

| What | Remove with |
|---|---|
| region data, images, builds, the Python helper, UI test screenshots | `rm -rf work/` |
| the offline bundle (and any packs in `offline/data/`) | `rm -rf offline/*` (keep `offline/README.md`, it is in git) |
| the self-contained disk | `rm -rf disk/` |
| the Valhalla image in Docker (~1.8 GB) | `docker image ls ghcr.io/gis-ops/docker-valhalla/valhalla`, then `docker image rm <image ID>` |
| the `f3` card tester, if `02-flash-sd.sh` installed it from the bundle | `sudo apt remove f3` |
| the Pi's entry in your SSH known hosts | `ssh-keygen -R nav-pi.local` |
| the SSH key `01-build-image.sh` created, if you had none before | `~/.ssh/id_ed25519` and `.pub` (only if you use it for nothing else) |
| Playwright, if you installed it for the UI tests | `rm -rf node_modules package.json package-lock.json`, and its browsers in `~/.cache/ms-playwright/` |

## Screen session settings

`/etc/nav-pi/session.env` on the Pi is read by `pi/session.sh` and `pi/kiosk.sh` at every start of the kiosk.
None of these is needed normally.

| Setting | Meaning |
|---|---|
| `BROWSER=firefox` | use Firefox ESR instead of Chromium (install `firefox-esr` first; not in the offline bundle) |
| `BROWSER_LANG=<code>` | Chromium's own language (`--lang`, default `de`); written here from `BROWSER_LANG` in `config.env` by the setup |
| `CHROMIUM_BIN=<path>` | another Chromium binary |
| `CHROMIUM_FLAGS_EXTRA=<flags>` | extra Chromium command-line flags |
| `KIOSK_QUERY=<a=b&c=d>` | extra query parameters for the app's URL (for example `probe=1`, the frame-rate probe) |
| `WLR_DRM_DEVICES=/dev/dri/cardN` | the graphics device labwc drives (default: the one with the connected screen, DSI first) |
| `LABWC_DEBUG=1` | debug log of labwc in `/run/user/<uid of nav>/labwc.log` |

After a change: `sudo systemctl restart greetd`.

## Troubleshooting on the device

Log in with `ssh nav@nav-pi.local`. *Settings > Pi health* shows the state of the four main services without
SSH.

| Symptom | Look at | Notes |
|---|---|---|
| black screen or a text console | `journalctl -u greetd -b`, `/run/user/$(id -u nav)/labwc.log` | after a first boot of a self-contained disk, the console stays until the setup is done (~15 min) |
| first boot did not finish | `/var/log/nav-pi-firstboot.log`, `journalctl -u nav-pi-firstboot -b` | it retries on every boot; `sudo reboot` after fixing the cause |
| app shows no data, or an error page | `journalctl -u nav-pi -b` | navd prints its edition and region at start; `curl -s 127.0.0.1:8080/api/status` |
| map grey, no tiles | `journalctl -u nav-pi-tiles -b`, `ls -l /srv/navdata/current` | the unit starts only when `/srv/navdata/current/map` exists |
| no map labels | `ls /srv/navdata/fonts` | push the fonts: `21-push-data.sh` |
| no route | `journalctl -u nav-pi-valhalla -b`, `docker logs nav-pi-valhalla` | the first route after boot is slower (cold cache) |
| no GPS | `journalctl -u gpsd -b`, `ls /dev/ttyACM* /dev/ttyUSB*`, `gpspipe -w -n 10` | *GPS* page; a receiver indoors may see satellites without a fix |
| no sound, speaker not found | `journalctl --user -u wireplumber -u pipewire -b` (as `nav`), `wpctl status`, `journalctl -u bluetooth -b` | *Settings > Sound* shows the output |
| Wi-Fi does not connect | `journalctl -u NetworkManager -b`, `nmcli device` | enterprise (company) networks are not supported |
| USB stick not shown | `journalctl -u udisks2 -b`, `lsblk` | NTFS and exFAT need the bundled `ntfs-3g` / `exfatprogs` |
| an app update failed | `/var/lib/nav-pi/app-update.log`, `journalctl -u nav-pi-app-update` | the previous app is in `/var/lib/nav-pi/app-prev/` |
| an OS update failed | `/var/lib/nav-pi/os-update.log`, `journalctl -u nav-pi-os-update` | needs internet on the Pi |
| slow, hot, or random resets | *Settings > Pi health* (power supply, speed limiting) | under-voltage: use a stronger supply |
| wrong clock | `date`; *GPS* page (time from GPS) | `20-setup-pi.sh` sets it from the PC; a GPS fix sets it too |

When you report a problem, add the relevant log lines ([CONTRIBUTING.md](../CONTRIBUTING.md)).
