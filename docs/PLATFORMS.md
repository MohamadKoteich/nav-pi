# Platforms, screens and GPS receivers: plan

This is a developer document. It describes planned work, not current features.

**Goal:** one nav-pi for Raspberry Pi 5, 4 and 3, and for Intel mini PCs (N100 / N150). The maps,
the app and the features are the same everywhere. Only the OS, the boot firmware and a few
system tools differ per processor. nav-pi should also work on **any screen** (Pi touch displays,
HDMI touch screens, plain HDMI monitors, a mini PC's built-in panel), fit itself to it, and let the user
adjust the screen in Settings.

Most of this is a plan; what is already built is marked **Done**. "UNTESTED" means built but not run on real
hardware. The current test status of everything is in [STATUS.md](STATUS.md).

## What is already common (no change per platform)
- **App:** a web page in Chromium (MapLibre) plus the Python service `navd`, with features in `features/<id>/`
  and editions in `editions/*.conf`. None of it depends on the processor.
- **Data:** `.pmtiles` map, Valhalla tile tar, search/along SQLite, safety JSON, fonts, imagery MBTiles and the
  optional recorded voice clips. None of it depends on the processor, so one region build serves every platform.
- **Per-board tuning:** `hardware/*.conf` (edition cap, map zoom, Valhalla threads, pixel ratio, tilt);
  `90-generic.conf` already catches any other 64-bit board by RAM.

## What is per processor (the platform layer)
| Piece | Raspberry Pi (arm64) today | Intel mini PC (amd64) to build |
|---|---|---|
| OS + first boot | Raspberry Pi OS Lite trixie image, cloud-init files injected into the FAT boot partition (`scripts/01-build-image.sh`, `tools/fat_inject.py`) | Debian 13 trixie amd64: a prebuilt UEFI disk image or an unattended (preseed) install from USB, same `pi/firstboot.sh` |
| Offline packages | `offline/pi-debs` (arm64, 235 packages, 378 MB on 2026-11-23) | a second amd64 set (same package list) |
| Routing engine | `offline/pi-docker/valhalla-3.5.1-arm64.tar.gz` | the amd64 image of the same 3.5.1 tag, pinned by its own image id |
| pmtiles tool | `offline/bin/pmtiles-arm64.tgz` | `offline/bin/pmtiles-x86_64.tgz` (already in the kit) |
| Board detection | `/proc/device-tree/model` + RAM (`pi/setup-local.sh`, `scripts/common.sh`) | DMI (`/sys/class/dmi/id/product_name`, CPU model) + RAM; today it falls back to `uname -m` |
| Display / backlight | DSI panel or HDMI, Pi backlight sysfs | eDP/HDMI; backlight via `/sys/class/backlight/intel_backlight` or DDC/CI on an external monitor |
| Car power | 12 V → 5 V 5 A converter | many N100 mini PCs take 12 V directly; a shutdown when the ignition is switched off is still needed (part of the car installation, not built) |

Scripts that today say `arm64` (`scripts/20-setup-pi.sh`, `pi/setup-local.sh`, `scripts/40-make-disk.sh`,
`scripts/common.sh`) would pick the set by architecture instead of assuming it.

## Board verdicts (estimates, UNTESTED unless marked)
| Board | Verdict |
|---|---|
| Pi 5 8 GB | done, MEASURED 2026-11-11 (60 fps map, everything on) |
| Pi 4 8 GB | runs the advanced edition from an SD card on a real Pi 4 (frame rate not measured) |
| Pi 4 2/4 GB, Pi 5 4 GB | profiles exist (`hardware/10`, `20`, `40`), never run on a real board |
| Intel N100 / N150 | expected to fit well: faster than a Pi 5, usually 8–16 GB RAM and NVMe, Intel graphics supported by Mesa/Chromium. Needs packaging and an install path only; no app change expected (UNTESTED) |
| Pi 3 (1 GB) | **basic edition only**: lighter map (zoom 14), probably a smaller region, Valhalla run without Docker (saves RAM). Map will be slow on its VideoCore IV GPU (not measured) |
| Pi Zero 2 W (512 MB) | **not with this design**: Chromium alone takes most of the RAM before routing starts. It would need a separate, much lighter app without a browser, which is a different project |
| Pi Zero / Zero W (original) | **no**: ARMv6 32-bit, no Valhalla image for it |

## Any screen: fit itself, and Settings to adjust it

**State on 2026-11-13:** rotation (4 buttons), brightness and dim at night (`features/display/`). The session
prefers a DSI panel over HDMI and drives only that GPU (`pi/session.sh`). Touch was mapped to the screen by
device name. Gaps found by reading the code at that time:

- rotation was applied only to a **DSI** output (fixed 2026-11-22, see below);
- touch controllers were found by a name list only (fixed 2026-11-22, see below);
- there is no setting for **resolution or refresh rate**; the mode is whatever the screen reports first;
- brightness only works where a sysfs backlight exists (Pi panels); HDMI monitors show no slider.

**Done 2026-11-22** (rules: [UI-RULES.md, "Screen sizes"](UI-RULES.md#screen-sizes)):

- **UI scale for any screen:** `features/core/scale.js` + `html { zoom }`. One number from the screen's short side,
  the panel's physical size when known (`?mm=` from `pi/kiosk.sh`; only panels denser than the Touch Display 2,
  ~295 ppi, are scaled up) and the user's choice; layout classes short / tiny / narrow / wide. Checked in headless
  Chromium at 10 sizes, advanced and basic editions (layout guard ALL PASS).
- **Settings > Screen > Text and button size** (Smaller / Normal / Larger): stored on the device, applied at once.
  It is not locked while driving.
- **Rotation on HDMI too:** `pi/kiosk.sh` picks the connected output (DSI first, then HDMI / eDP / DP, then any)
  instead of DSI only, and passes the EDID panel size to the app. UNTESTED on a Pi.
- **Touch mapping for any touchscreen:** `pi/session.sh` maps every input device with `INPUT_PROP_DIRECT` (the
  kernel's "this is a touchscreen" flag) to the output; the name list stays as a fallback. Checked with sample
  input only; UNTESTED on a Pi.

**Still open:** output choice when several screens are connected, resolution + refresh rate (wlr-randr) with the
"Keep these settings? 15 s" revert, DDC/CI brightness for HDMI monitors, touch calibration, mouse cursor when a
mouse is present, larger map labels on big screens (MapLibre text scale; the map keeps its own pixel size).

Wanted behaviour:
1. **Auto-fit on first start:** use the screen's preferred mode; pick a UI scale from its size and pixel density
   so buttons stay finger-sized on 5" to 15"; landscape by default (portrait-native panels turned 90, as now).
2. **Settings → Screen** (full Settings page): output (when more than one is connected),
   resolution + refresh rate from the list the screen reports, UI size (e.g. 75–200 %), rotation for any output,
   brightness where the hardware allows it (sysfs backlight, DDC/CI for HDMI monitors), touch calibration /
   "touch is on the wrong side" fix.
3. **Safe change:** a new resolution/scale shows "Keep these settings? Reverting in 15 s" and goes back by itself
   if not confirmed, so a mode the screen can't show never locks the user out. Never while driving.
4. **Works with mouse/keyboard too** (a monitor without touch): the cursor shows when a mouse is present.
5. Settings persist in `/srv/navdata/` like the rotation does, and are reapplied at boot by `pi/kiosk.sh` via `wlr-randr`.

## GPS receivers: automatic detection (plan)

**Goal:** most commercial receivers work without configuration. The user plugs in or pairs a receiver, and within
a few seconds the GPS page shows it and a fix comes. No settings, no terminal. Same on every platform (Pi and
Intel). Open items: see [STATUS.md](STATUS.md).

What exists (2026-11-13): `gpsd` 3.25 (Debian 13) with its own udev hotplug rule; `pi/install-runtime.sh`
replays USB events so that a receiver plugged in before the setup is picked up. navd only talks to gpsd
(`features/gps/navd_gps.py`), so everything below happens in the system layer and the app stays the same. Only a
u-blox on `ttyACM0` has been seen (Pi 4, 2026-11-12); a real end-to-end fix and drive are still open.

gpsd already decodes the protocols commercial receivers use: NMEA 0183 (every chip family: u-blox, MediaTek/Airoha,
SiRF, Quectel, Broadcom), u-blox UBX, SiRF binary, Garmin binary. **The gap is finding the device, not decoding it.**

| Kind | Examples (UNTESTED) | How it connects | What nav-pi must do |
|---|---|---|---|
| USB puck, native USB | u-blox 7/8/9/10 sticks (VK-162/172 type), Garmin GPS 18x USB | `ttyACM*` (u-blox), Garmin via `garmin_gps` | already covered by gpsd's rule; verify on hardware |
| USB puck behind a USB-serial chip | GlobalSat BU-353 (Prolific PL2303), many no-name pucks (CP210x, CH340/CH341, FTDI) | `ttyUSB*` | gpsd's rule lists only some chip ids on purpose (the same chips sit in Arduinos and OBD cables) → a **probe** (below) |
| Module on the Pi's pins (UART) | NEO-6M/7M/M8N, BN-880, Adafruit GPS HAT, Waveshare L76X | `/dev/serial0` | Pi only: free the UART from the serial console and enable it in `config.txt` at image build; probe it at boot |
| Bluetooth GPS (SPP) | Garmin GLO, Bad Elf, Dual XGPS, Qstarz | RFCOMM | pair in the Bluetooth settings, the paired device offered as "Use as GPS"; needs BlueZ in every edition that wants it (basic has no `bluetooth` today) |
| Phone as GPS | Android apps that send NMEA over the network or Bluetooth | `udp://` / `tcp://` or RFCOMM | optional source in the GPS page; phone on the nav-pi Wi-Fi or Bluetooth |
| GNSS in an LTE/5G modem (mini PCs, M.2) | Quectel EC25/EM05, Sierra EM7455 | extra `ttyUSB` NMEA port after an AT command, or ModemManager | later; probe only if a modem is present |

**The probe:** on every new `ttyACM*`/`ttyUSB*`/`serial0`, open it **read-only**, listen ~2 s per common
speed (9600, 4800, 38400, 115200) for NMEA sentences (`$GP`/`$GN`/`$GL`/`$GA`/`$GB…`) or UBX sync bytes; if found,
hand it to gpsd (`gpsdctl add`); if not, leave it alone. Never write to a device that has not proved itself a GPS
(a later OBD-II/ELM327 cable is also a USB-serial device). Configuration that writes (u-blox to 5–10 Hz via `ubxtool`,
car dynamic model) only for a receiver that answered as u-blox.

**Behaviour:**
- several receivers → use the one with the best fix (USB/UART before phone), switch over when it loses the fix;
- GPS page shows receiver name, chip family, protocol, rate and source (USB / pins / Bluetooth / phone);
- a plugged device that is not a GPS (e.g. a "GPS tracker" like the GF-07, which is a 2G modem) → a plain message
  "this device sends no GPS data", not silence;
- the system clock is set from the GPS (gpsd → chrony), so a box with no clock battery and no internet has the right time.

**Testing without buying every receiver:** recorded NMEA/UBX streams per chip family played into a pseudo-terminal
(like `tests/fake_gpsd.py`) prove the probe and the speeds; a short list of real receivers is checked on hardware and
written into a compatibility table here (status UNTESTED until measured).
