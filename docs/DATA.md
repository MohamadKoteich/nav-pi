# Data: sources, sizes, licences

All nav-pi data is built on the build PC from **public sources**. Each part goes to
`work/data/<region>/<part>/` with a `BUILD-INFO` file: what it was built from, when, with which tool version,
and the sha256 of the result. `21-push-data.sh` and `40-make-disk.sh` refuse a file whose sha256 doesn't match.

If you keep finished region data with the offline bundle in `offline/data/<region>/`, the scripts use that copy
instead of `work/data/<region>/` (see [offline/README.md](../offline/README.md)).

| Part | Script | Source | Licence of the data |
|---|---|---|---|
| Map (`<region>.pmtiles`) | `11-build-map.sh` | [Protomaps](https://protomaps.com) daily planet build (basemap v4), cut to your region | © OpenStreetMap contributors, ODbL |
| Search (`places.sqlite`) | `12-build-search.sh` | the map you just cut (places, streets, POIs) | ODbL |
| Routing (`valhalla_tiles.tar`) | `10-build-routing.sh` | [Geofabrik](https://download.geofabrik.de) OpenStreetMap extract, built with Valhalla 3.5.1 | ODbL |
| Places along the route (`along.sqlite`, optional) | `13-build-along.sh` | the cut map's POI layer | ODbL |
| Driver alerts (`safety.json`, optional) | `13-build-safety.sh` | an OpenStreetMap `.pbf` | ODbL |
| Fonts (map labels) | `00-get-bundle.sh fonts` | [protomaps/basemaps-assets](https://github.com/protomaps/basemaps-assets) | Noto: SIL Open Font License |
| Satellite / aerial photos (optional) | on the Pi or `tools/build_imagery.py` | see below | per provider |
| Voice clips (optional) | `tools/build_voicepack.py` | a text-to-speech HTTP service that you run (see [Voice](#voice)) | per voice model |

**Attribution:** the map shows "© OpenStreetMap contributors" and, for photo layers, the provider's credit.
If you publish screenshots or redistribute built data, keep these credits. The ODbL also applies to data you
distribute: see [opendatacommons.org/licenses/odbl](https://opendatacommons.org/licenses/odbl/).

## Region presets

Set in `config.env` (all three are written out in `config.env.example`; `oberbayern` is the default):

| Preset | Bounding box | OSM extract | Notes |
|---|---|---|---|
| `oberbayern` (default) | 10.7,47.3,13.1,49.1 | Geofabrik `germany/bayern/oberbayern` | Upper Bavaria incl. Munich, small: map 518 MB, search 31 MB, routing 302 MB (2026-11-23). The quickest way to try nav-pi |
| `germany` | 5.5,47.0,15.5,55.2 | Geofabrik `germany` | map 7.6 GiB, search 454 MB, routing 4.9 GiB, along 19 MB, driver alerts 1.6 MB (2026-11-23) |
| `europe` | -32,32,47,79 + `regions/europe.geojson` | Geofabrik `europe` | map ~48 GB, routing ~34 GB. The route graph cannot be built from scratch on a normal PC (see [Routing](#routing)) |

`REGION_BBOX` is the bounding box west,south,east,north in degrees. `REGION_POLYGON` (optional) is a GeoJSON file
with the exact map area; if it is set, the map is cut to it instead of the box.

### Your own region

Any Geofabrik extract should work; only the presets above have been built. A region is four settings:

1. **`REGION`**: a short name of your choice: lower-case letters, digits, `-` and `_`, at most 48 characters, and
   not one of `current`, `updates`, `fonts`, `media`, `voice`, `trips`, `imagery`, `car` (it is used in file and
   folder names, and on the Pi next to those folders).
2. **`OSM_PBF`**: the extract's URL or a local `.osm.pbf` file. Pick it on
   [download.geofabrik.de](https://download.geofabrik.de): continent → country → state, and copy the link of the
   `.osm.pbf` file.
3. **`REGION_BBOX`**: the box west,south,east,north in degrees (decimal, west and south first). Geofabrik's page of
   each extract shows its outline; draw a box around it on [bboxfinder.com](http://bboxfinder.com) and copy the
   numbers it shows. The box should cover the extract: the map and the search index are cut to the box, the route
   graph to the extract, so a smaller box leaves roads without a map around them.
4. **`REGION_POLYGON`**: leave it empty. It is only needed when the map must follow an exact outline, as for
   Europe: `regions/europe.geojson` was written by `tools/valhalla_coverage.py` from an existing Europe route
   graph, so that the map shows exactly the area where routes can be computed
   ([DEVELOPING.md](DEVELOPING.md#tools)).

Then run step 3 of [INSTALL.md](INSTALL.md#3-build-the-region-data) as usual. A second settings file per region
(`NAVPI_CONFIG=~/myregion.env`) keeps the presets apart.

**The app opens on Munich** (`START` in `features/nav/maps.js`) until it has a GPS fix; then it follows the car.
With another region, the first screen is therefore an empty area outside your map: search for a place, or wait
for the GPS fix.

**The UI tests** use places in Munich, so they need the `oberbayern` (or `germany` / `europe`) data; see
[TESTING.md](TESTING.md#browser-ui-tests-playwright).

### Newer OpenStreetMap data

The map always comes from the newest Protomaps build. `10-build-routing.sh` reuses the `.osm.pbf` it downloaded
before; `bash scripts/10-build-routing.sh --refresh` downloads the current one. The full procedure:
[INSTALL.md](INSTALL.md#refreshing-a-region-with-newer-openstreetmap-data).

## Map

`11-build-map.sh` uses the official `pmtiles` tool (pinned version and sha256) to cut your region out of a
Protomaps planet build. It reads only the parts it needs over HTTP. `PMTILES_SRC=latest`, the default, picks the
newest daily build. Protomaps keeps only recent builds online, so a fixed date stops working after a while.
`PMTILES_SRC` can also be a local `.pmtiles` file.

`MAP_MAXZOOM` (default 15) sets the most detailed zoom level that is cut. `MAP_DOWNLOAD_THREADS` (default 1)
sets the parallel downloads: more threads are faster for a country but need more RAM, so keep 1 for Europe.
The map style (`features/nav/styles/`) is written for the Protomaps **basemap v4** schema, which the builds use
as of 2026-11 (v4.15).

## Search

`12-build-search.sh` serves the cut map locally and indexes every named place, street and point of interest (POI)
into SQLite with a prefix index. It has no house numbers: they aren't in the map tiles. Adding them would need an
address extract from OpenStreetMap, which is not built.

## Places along the route

`13-build-along.sh` (optional) indexes fuel stations, parking, toilets and rest areas from the cut map into
`along.sqlite`. Without it, the Pi decodes the map tiles ahead of the car instead, which covers only the next
60 km.

## Routing

`10-build-routing.sh` downloads the OpenStreetMap extract and builds the Valhalla route graph in Docker. It uses
the **same pinned image** that runs on the Pi (`VALHALLA_IMAGE`, multi-arch, Valhalla 3.5.1), so the graph always
matches the engine on the device. `BUILD_THREADS` (default 4) sets the CPU threads. Germany: 3 h 37 min on a 6-core PC with
30 GB RAM, including the 4.9 GB download; the build process used about 5 GB of RAM when checked (the peak was not
recorded). 16 GB RAM is recommended, not measured as a minimum.

Two other ways, for when you already have a bigger graph built with the same Valhalla version:
`ROUTING_FROM_TILES=<its valhalla_tiles dir>` cuts your region out of it in about 30 s, and adding
`ROUTING_WHOLE_GRAPH=1` copies the whole graph (for Europe, a ~34 GB file). This is the only way to get a
Europe graph: building it from scratch needs far more RAM than a normal PC has.

**Germany from scratch:** during development, a from-scratch Germany build with Valhalla 3.5.1 once crashed
(`double free` after `Invalid level: roof` in the OSM data). The build of 2026-11-23 from the current Geofabrik
extract completed without a crash: 1 151 tiles. Its log contains warnings and `Invalid level` errors for single
ways, which Valhalla skips. If a build crashes for you, these are the options:

- build a smaller region, for example one or more German states from Geofabrik
- build with a newer Valhalla image. You must then run the **same** image on the Pi. Change these together:
  `VALHALLA_IMAGE` (the multi-arch image, pinned by digest) and `VALHALLA_IMAGE_ID_ARM64` (the arm64 image's own
  ID, its config digest; the default is in `scripts/common.sh`, the commented line in `config.env.example` shows
  it). Then run `bash scripts/00-get-bundle.sh pi-docker`, which fetches the Pi's copy again when the ID no longer
  matches, rebuild the route graph, and install it with `20-setup-pi.sh` or a new self-contained disk. This is
  untested.

## Driver alerts

`13-build-safety.sh` (optional, for the advanced and full editions) reads speed cameras, level crossings, rest
areas and low-emission zones from a local OpenStreetMap `.pbf` file (`SAFETY_PBF=<file>`; the default is `OSM_PBF`
when that is a local file, otherwise the extract `10-build-routing.sh` downloaded). The coverage is the area of that file, not the region: with the Germany extract,
only Germany has alert data. Sharp-curve warnings need no data; the app computes them from the route's shape.
`21-push-data.sh` copies `safety.json` and raises a Valhalla limit on the Pi so that "Avoid low-emission zones"
works. `SAFETY_COVERAGE=<name>` sets the area name the Settings page shows (default: from the file name).
Details: [FEATURES.md](FEATURES.md#safety-driver-alerts).

## Satellite and aerial photos

The satellite layer shows MBTiles packs from `/srv/navdata/imagery/` on the Pi. There are three ways to get one:

1. **On the Pi:** *Settings > Satellite*: frame an area on the map and download it over Wi-Fi. The Pi picks the
   sharpest source that covers it. There are 23 sources: 22 national or regional aerial photography services
   (most of Germany, Austria, the Netherlands, Belgium, Luxembourg, Czechia, Spain and France) and Sentinel-2
   cloudless elsewhere. At most 2 requests run at once. Downloads are refused while the car moves (faster than
   3 m/s) or while guiding, and resume after an interruption.
2. **On the build PC**, with the same downloader. For example, the Munich pack (Bavarian DOP20 aerial
   photography, CC BY 4.0):
   ```bash
   python3 tools/build_imagery.py --bounds 11.35,48.03,11.74,48.26 --name Munich --level high --id munich
   python3 tools/imagery_buildinfo.py offline/data/imagery
   ```
   That is ~96 000 tiles. At the ~6 tiles/s measured on 2026-11-23 it takes about 4–5 hours. `--list` shows the
   sources and their licences for an area. Packs are written to `offline/data/imagery/` (`--out` to change it).
   `imagery_buildinfo.py` records their sha256; `21-push-data.sh` and `40-make-disk.sh` then copy the packs.
   (`21-push-data.sh` also looks in `work/data/imagery/`; `40-make-disk.sh` only in `offline/data/imagery/`.)
3. **From a USB stick:** any MBTiles file (TMS scheme) can be imported in *Settings > Satellite*.

Each provider's licence applies to its photos. Most are open data with attribution (for example CC BY 4.0).
**Sentinel-2 cloudless (EOX) is CC BY-NC-SA 4.0: non-commercial use only.** The app and `--list` show this.

## Voice

Spoken prompts use **espeak-ng** on the Pi (English or German, following the app language). It works, but it
sounds robotic. For more natural prompts, navd plays **recorded clips** when a voice pack is installed; any phrase
without a clip falls back to espeak-ng.

There are two ways to get better voices. Neither is set up by the scripts.

**1. A recorded voice pack** (rendered once on the build PC). `tools/build_voicepack.py` sends every phrase to a
text-to-speech HTTP service and saves the answers as WAV clips:

```bash
python3 tools/build_voicepack.py offline/data/voice --url http://localhost:5000   # or set NAVPI_VOICE_URL
```

**No such service ships with nav-pi**; you run or write one yourself (for example a small wrapper around
[Piper](https://github.com/rhasspy/piper)). It must answer one request per phrase:

```
POST <url>/api/tts
Content-Type: application/json
{"text": "In 300 meters,", "lang": "en", "voice": "piper:en_US-lessac-medium", "format": "wav"}
-> 200, body = the WAV file (any sample rate, mono or stereo)
```

The `voice` names are set in `VOICES` at the top of the script (English and German); change them to what your
service calls its voices. The result is `offline/data/voice/<lang>/<key>.wav` plus `manifest.json`. The licence of
the clips is that of the voice model you used. `21-push-data.sh` copies the pack to `/srv/navdata/voice/` (from
`offline/data/voice/`, else `work/data/voice/`); `40-make-disk.sh` takes it from `offline/data/voice/` only. No
voice pack is included in this repository.

**2. Piper on the Pi** (untested). navd uses Piper instead of espeak-ng when a `piper` program is on its `PATH` and
`PIPER_MODEL` points to a voice model (`features/voice/navd_voice.py`). Neither is in the offline bundle: install
them yourself, then give navd the setting with a systemd drop-in:

```bash
sudo systemctl edit nav-pi          # add:  [Service]  Environment=PIPER_MODEL=/srv/navdata/piper/<voice>.onnx
sudo systemctl restart nav-pi
```

The audio is played as 22 050 Hz mono, which fits Piper's medium-quality voices. One model is used for every
prompt, whatever the app language. Recorded clips, where they exist, still come first.

## Disk use on the Pi

All data lives in `/srv/navdata/<region>/`. `/srv/navdata/current` is a link to the active region. Several
regions can sit side by side; a map bundle adds one as `<region>-<OSM date>`. `21-push-data.sh` checks the free
space before copying and tells you if a region has to be deleted first. Deleting a region:
[OPERATING.md](OPERATING.md#map-data-on-the-device).
