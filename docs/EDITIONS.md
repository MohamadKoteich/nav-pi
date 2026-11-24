# Editions and hardware profiles

- An **edition** (`editions/<name>.conf`) is a list of features: basic, audio, advanced or full.
- A **hardware profile** (`hardware/*.conf`) says which editions a board may run, which one it gets by default,
  and tunes the app for it ([hardware/README.md](../hardware/README.md)).
- A **feature** is one folder, `features/<id>/`. The features, one section each, are in
  [FEATURES.md](FEATURES.md); the rules every part of the UI follows (layout, screen sizes, keyboard, map
  gestures) are in [UI-RULES.md](UI-RULES.md).

The builder (`tools/build_edition.py`) copies only the chosen edition's features into the Pi's app. The Pi
packages are not trimmed: the setup installs every package of the offline bundle on every edition
(`pi/install-debs.sh`), so a smaller edition saves RAM and screen clutter, not disk space.

## Editions

| Edition | Features | Default on | Allowed on |
|---|---|---|---|
| basic | core gps voice nav places display wifi usb system trip dashboard car | Pi 4 up to 2 GB, other boards | every board |
| audio | basic + audio bluetooth media imagery | Pi 4 4–8 GB, Pi 5 up to 4 GB | every board except the 2 GB Pi 4 |
| advanced | audio + safety (driver alerts) | Pi 5 8 GB and more | Pi 4 8 GB, Pi 5, other boards |
| full | advanced + camera, obd (both not built yet) | — | Pi 5 8 GB and more |

In short: basic is GPS navigation only; audio adds sound, Bluetooth, media and satellite photos; advanced adds
driver alerts (sharp curves, level crossings, speed cameras (opt-in), low-emission zones, break reminder). The
`camera` and `obd` features are ideas (`status: idea`), so full currently builds the same app as advanced.

Commands:

```bash
python3 tools/build_edition.py --list           # editions, hardware profiles, features and their status
bash scripts/20-setup-pi.sh                     # board detected -> its default edition
EDITION=basic bash scripts/22-update-app.sh     # switch the Pi to another edition (takes seconds)
EDITION=full HARDWARE=10-rpi4-2gb …             # refused: too big for the board
FORCE_EDITION=1 EDITION=full …                  # override the limit (at your own risk)
```

You can also set `EDITION=` / `HARDWARE=` in `config.env`. An update keeps the edition the Pi already runs
unless you set `EDITION`. All Pi packages from the offline bundle are installed on every edition, so switching
the edition needs no new packages.

On a **self-contained disk** (`40-make-disk.sh`), `EDITION` from `config.env` is written onto the disk; empty
means the Pi picks its profile's default at the first boot. `FORCE_EDITION` does not apply there: an edition
above the board's limit makes the first boot fail.

## Hardware profiles

See [hardware/README.md](../hardware/README.md). Detection: the board model (`/proc/device-tree/model`) and RAM.
The profiles span 2 GB (Pi 4, basic edition only) to 16 GB (Pi 5); 8 GB is recommended. Only the 8 GB Pi 5
profile is measured (map at about 60 fps with `tools/device-probe.mjs`). The 8 GB Pi 4 has run the advanced
edition without a frame-rate measurement; the other profiles are estimates and marked UNTESTED in their files.
Per-board tuning values: [ARCHITECTURE.md](ARCHITECTURE.md#resources-and-bottlenecks).

## Where the earlier sections went

This file used to hold the feature descriptions and the UI rules as well. Older links point here:

- feature folders, the features, updates, imagery, driver alerts (also school zones):
  [FEATURES.md](FEATURES.md)
- layout, drive view, keyboard, map gestures, **screen sizes**, layout guard: [UI-RULES.md](UI-RULES.md)
