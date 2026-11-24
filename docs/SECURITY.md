# Security model

**Short version:** nav-pi is built to be private (offline, no accounts, no telemetry), not to resist someone who
can touch the device. Anyone with physical access to a nav-pi, or to its card or disk, can take full control of
it. **The security of a device you build is your responsibility.** This page says plainly what the design
protects, what it does not, and where to start if you want to harden it.

Checked against the code on 2026-11-24.

## What the design does

- **Offline by default.** Nothing connects to the internet unless the user starts it (satellite downloads, OS
  updates). Map, routing, search and voice run on the device.
- **Local services listen on `127.0.0.1` only:** navd (8080), `pmtiles serve` (8081), Valhalla in Docker
  (8002, published on `127.0.0.1` only), gpsd (2947), Chromium's DevTools port (9222).
- **SSH accepts keys only.** The image sets no password for the user `nav` (`lock_passwd: true`,
  `ssh_pwauth: false` in `templates/user-data.tmpl`). SSH can be left out entirely (`SSH_PUBKEY_FILE=none`) or
  turned off later (`scripts/24-lock-device.sh`).
- **The kiosk** has no address bar or browser UI, and a managed Chromium policy (`pi/chromium-policy.json`)
  turns off password saving, autofill, translation and notifications.
- **Integrity checks against damage, not attacks.** Every file of the offline bundle is checked against an
  official or pinned checksum. Region data carries a sha256 in its `BUILD-INFO`, and every copy to the Pi is
  checked against it. Update bundles list the sha256 of each file, and the Pi checks the copy. This catches a
  bad card, cable or stick. It does not prove who made the files.
- **polkit rules** (`pi/49-nav-pi-*.rules.in`, `pi/50-nav-pi-update.rules.in`, the power rule in
  `pi/install-runtime.sh`) and one sudoers entry (`/etc/sudoers.d/nav-pi-clock`) describe the system actions
  navd needs: Wi-Fi, USB mounts, reboot / power-off, five units, the clock. navd asks for nothing else.

## What it does not do

1. **The user `nav` has passwordless sudo for everything.** `templates/user-data.tmpl` creates it with
   `sudo: ALL=(ALL) NOPASSWD:ALL` and the `sudo` group; the setup scripts rely on this over SSH.
   **navd runs as `nav`.** So any bug that lets someone run code inside navd, the kiosk, or anything else
   running as `nav`, gives them root. The polkit rules and the clock sudoers entry are not a security
   boundary while this blanket sudo exists.
2. **`nav` is in the `docker` group** (`scripts/20-setup-pi.sh`, `pi/setup-local.sh`). Docker group membership
   is root-equivalent on its own.
3. **navd's HTTP API has no authentication.** Any process on the device can call it. The Chromium DevTools port
   (`--remote-debugging-port=9222` in `pi/kiosk.sh`, used for on-device tests) gives any local process full
   control of the app.
4. **Update bundles are not signed.** `features/system/navd_system_updates.py` checks each file against the
   sha256 in the bundle's own `manifest.json`. Whoever writes the bundle also writes the manifest. An app bundle
   is installed by `pi/apply-app-update.sh`, **as root**, and the new navd then runs as `nav` (with sudo). So
   **anyone with a USB stick and a few minutes at the screen can install their own code**, while the car is
   parked. The same goes for a bundle served on the LAN: anyone at the screen can type a new update address.
   Map bundles are just as unauthenticated (wrong data, not code).
5. **`24-lock-device.sh` only removes SSH keys and turns SSH off.** It does not remove the sudo rule or the
   docker group, and it does not turn off USB or LAN updates. A "locked" device is still open to point 4 and to
   point 6.
6. **Nothing on the card or disk is encrypted.** Take it out and read it on any PC: trips
   (`/srv/navdata/trips/`), places and settings (Chromium's profile in `~nav/.config/nav-pi-chromium/`), Wi-Fi
   passwords (`/etc/NetworkManager/system-connections/`), Bluetooth pairings (`/var/lib/bluetooth/`). Anyone
   who can write to it can also change the system, for example add an SSH key.
7. **Bluetooth pairing has no PIN.** *Make visible to my phone* opens pairing for 3 minutes with "just works"
   pairing (`features/bluetooth/navd_bluetooth.py`): anyone in range during that window can pair.
8. **Other network listeners come from Raspberry Pi OS:** SSH on port 22 on every interface (while enabled), and
   `avahi-daemon` (mDNS, UDP 5353), which makes `nav-pi.local` resolve. The image also ships `rpi-connect-lite`
   (Raspberry Pi Connect), which does nothing until someone signs in to it. There is no firewall.
9. **No automatic security updates.** The OS packages are the ones in your offline bundle. *Settings > System >
   Updates > Update system (apt)* upgrades them, only when the user starts it, with internet on the Pi.
10. **Build-time downloads are only partly pinned.** The OS image, pmtiles, the Valhalla image, the Pi packages
    and the fonts are checked against official or pinned checksums. The Protomaps map and the Geofabrik
    `.osm.pbf` are fetched over HTTPS without a checksum against the source.

## If you want to harden it

None of this is built. These are the places to change, roughly in order of value:

| Change | Where |
|---|---|
| Sign update bundles: sign `manifest.json` on the build PC (for example `ssh-keygen -Y sign`, minisign or signify), bake the public key into the image, refuse unsigned bundles on the Pi | `tools/make_update_manifest.py`, `features/system/navd_system_updates.py` (`scan`, `parse_manifest`), `pi/apply-app-update.sh` |
| Or turn off USB and LAN updates on a handed-over device | remove `pi/50-nav-pi-update.rules.in` and the update units (`pi/install-updates.sh`), or build without the update part of `features/system/` |
| Run navd as its own unprivileged user, not in `sudo` or `docker`, and keep the polkit rules for that user | `pi/install-runtime.sh` (the `nav-pi.service` unit), the polkit rule templates, `pi/install-boot.sh` (clock sudoers) |
| Drop blanket sudo for `nav`, or use a separate admin user for SSH. The build-PC scripts use `sudo` over SSH, so they would need that admin user | `templates/user-data.tmpl`, `scripts/20-setup-pi.sh`, `21-push-data.sh`, `22-update-app.sh`, `03-check-pi.sh` |
| Make `24-lock-device.sh` also remove the sudo rule and the docker group, and turn off USB updates | `scripts/24-lock-device.sh` |
| Remove `nav` from the `docker` group (navd does not call Docker; the `nav-pi-valhalla` unit runs it as root) | `scripts/20-setup-pi.sh`, `pi/setup-local.sh` |
| Remove the DevTools port on devices that are not used for testing | `pi/kiosk.sh` |
| Require a PIN for Bluetooth pairing | `features/bluetooth/navd_bluetooth.py` (`--agent NoInputNoOutput`) |
| Turn off avahi and rpi-connect, add an nftables rule that drops inbound traffic except SSH | a step in `pi/install-runtime.sh` |
| Check the Geofabrik extract against its published `.md5` | `scripts/10-build-routing.sh` |
| Encrypt the data partition | not practical without a key entry at every boot; assume the card can be read |

If you build devices for other people, also read the licence notes in the [README](../README.md#licence) and
[THIRD-PARTY.md](THIRD-PARTY.md).

## Reporting a security problem

Open an issue on GitHub. If the details should not be public, say so in the issue (without the details) and ask
for a private channel.
