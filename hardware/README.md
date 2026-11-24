# Hardware profiles

A hardware profile (`hardware/*.conf`) says which editions a board may run and tunes the app and services for it.

The setup (`scripts/20-setup-pi.sh`, or the first boot of a self-contained disk) reads the board model from
`/proc/device-tree/model` and the RAM from the Pi. It then picks the first profile, in file-name order, whose
`MATCH_MODEL` matches the model and whose `MAX_RAM_MB` is not exceeded. `90-generic.conf` matches any board, so
every board gets a profile. `HARDWARE=<file name without .conf>` (for example `HARDWARE=50-rpi5-8gb`) forces a
profile.

| Key | Meaning |
|---|---|
| `MATCH_MODEL` | regular expression matched against `/proc/device-tree/model` (`.` matches any board) |
| `MAX_RAM_MB` | the profile applies up to this much RAM |
| `DEFAULT_EDITION` | the edition installed when none is chosen |
| `MAX_EDITION` | the largest edition allowed (basic < audio < advanced < full); `FORCE_EDITION=1` overrides it |
| `MAP_MAXZOOM` | most detailed map level the app loads on this board (15 = full detail, 14 = lighter: above 14 the zoom-14 tiles are enlarged). The map file itself is cut once for all boards, up to `MAP_MAXZOOM` in `config.env` |
| `VALHALLA_THREADS` | routing worker threads |
| `MAP_PIXEL_RATIO` | upper limit for the map's render resolution (caps the screen's device pixel ratio; lower = cheaper) |
| `MAP_MAX_PITCH` | largest 3-D tilt of the map in degrees (0 = flat, the cheapest) |

| Profile | Board | Default / largest edition | Status |
|---|---|---|---|
| `10-rpi4-2gb` | Pi 4 / Pi 400, up to 2 GB | basic / basic | estimate, untested |
| `20-rpi4-4gb` | Pi 4 / Pi 400, 4 GB | audio / audio | estimate, untested |
| `30-rpi4-8gb` | Pi 4 / Pi 400, 8 GB | audio / advanced | runs the advanced edition on a Pi 4 8 GB; frame rate not measured |
| `40-rpi5-4gb` | Pi 5 / Compute Module 5, up to 4 GB | audio / advanced | estimate, untested |
| `50-rpi5-8gb` | Pi 5 / Compute Module 5, 8–16 GB | advanced / full | measured on a Pi 5 8 GB (2026-11-11): map at about 60 fps (`tools/device-probe.mjs`), a route in 2–25 ms |
| `90-generic` | any other board | basic / advanced | estimate, untested |

The profiles span 2 GB (Pi 4, basic edition only) to 16 GB; 8 GB is recommended. A Pi 5 with 2 GB gets the
`40-rpi5-4gb` profile (audio edition by default), which is untested. All values per profile are in
[docs/ARCHITECTURE.md](../docs/ARCHITECTURE.md#resources-and-bottlenecks). Editions are described in
[docs/EDITIONS.md](../docs/EDITIONS.md). Every package of the offline bundle is installed on every profile;
the profile only limits the app's features and tunes it. Planned platforms (Intel N100/N150, Pi 3) and the work
for any screen: [docs/PLATFORMS.md](../docs/PLATFORMS.md).
