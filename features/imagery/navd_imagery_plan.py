"""imagery feature, pure part: tile math, the provider catalogue, coverage, size estimates (stdlib only, no I/O).

Sources: Bavaria DOP20 and IGN BD ORTHO aerial photography over WMS, EOX Sentinel-2 cloudless over WMTS (see PROVIDERS).
Design for the Pi: stdlib urllib only (navd_imagery.py), no rasterio/numpy/GDAL; Sentinel-2 comes as ready-made EOX
s2cloudless tiles; a provider is picked by a coarse outline of its coverage area (the Pi has no online place search);
every zoom of the pack is downloaded directly from the provider (no image pyramid is computed on the device).
"""
import math

HALF = 20037508.342789244
LEVELS = ("overview", "standard", "high")
ZOOMS = {"aerial": {"overview": 15, "standard": 17, "high": 18}, "satellite": {"overview": 10, "standard": 12, "high": 14}}
SPAN = 5                     # levels below the detail zoom that are downloaded too (below that the normal map shows)
TILE_BYTES = 30000           # measured average: ~30 kB per stored tile
RESERVE = 2 * 1024 ** 3      # disk reserve: keep 2 GiB free
MAX_TILES = 250000           # one pack (kept small for the Pi)

# coarse outlines (lon, lat), a few km generous; the WMS itself returns nothing (transparent) outside its land
BAVARIA = [(8.95, 50.0), (9.35, 50.27), (9.75, 50.45), (10.05, 50.57), (10.6, 50.36), (10.9, 50.42), (11.25, 50.52),
           (11.9, 50.45), (12.15, 50.34), (12.3, 50.12), (12.55, 49.95), (12.5, 49.75), (12.7, 49.53), (13.05, 49.3),
           (13.45, 49.07), (13.88, 48.78), (13.8, 48.5), (13.45, 48.52), (13.0, 48.27), (12.78, 48.1), (12.99, 47.82), (13.03, 47.72),
           (13.12, 47.55), (12.8, 47.55), (12.25, 47.66), (11.6, 47.5), (11.2, 47.37), (10.95, 47.37), (10.45, 47.5),
           (10.2, 47.25), (9.95, 47.52), (9.78, 47.58), (9.72, 47.53), (9.6, 47.52), (9.7, 47.7), (10.02, 47.85), (10.0, 48.45), (10.28, 48.9),
           (10.12, 49.2), (9.98, 49.5), (9.6, 49.62), (9.3, 49.68), (9.05, 49.6), (9.0, 49.85)]
FRANCE = [(2.5, 51.15), (3.0, 50.82), (4.15, 50.3), (4.85, 50.2), (5.8, 49.58), (6.45, 49.5), (6.6, 49.35), (6.8, 49.18), (7.05, 49.13),
          (7.35, 49.17), (7.65, 49.07), (8.25, 49.0), (8.12, 48.85), (7.97, 48.7), (7.84, 48.55),
          (7.72, 48.3), (7.62, 48.05), (7.58, 47.75), (7.6, 47.58), (7.0, 47.47), (6.05, 46.22), (7.1, 45.9), (7.0, 44.2), (7.6, 43.8), (6.0, 42.95), (4.5, 43.35),
          (3.1, 42.85), (3.2, 42.38), (1.7, 42.45), (-1.85, 43.3), (-1.55, 44.5), (-1.3, 46.0), (-2.4, 47.1),
          (-4.9, 47.85), (-4.85, 48.65), (-3.0, 48.9), (-1.6, 48.7), (-1.95, 49.75), (0.2, 49.55), (1.55, 50.2),
          (1.55, 50.95)]
CORSICA = [(8.5, 43.0), (9.6, 43.1), (9.6, 41.3), (9.05, 41.3), (8.5, 41.8)]

# 2026-11-22 (sharp aerial views for more cities). Every source below was checked by hand: GetCapabilities read
# once (layer, EPSG:3857, licence text) and ONE real tile fetched with tools/imagery_probe.py. Outlines are coarse
# hand-drawn polygons (lon, lat), a few km generous like Bavaria/France; neighbouring outlines overlap at the borders.
BW = [(7.62, 47.6), (8.2, 47.53), (8.85, 47.7), (9.2, 47.63), (9.55, 47.52), (9.63, 47.6), (9.82, 47.64), (10.08, 47.7), (10.12, 48.0),
      (10.07, 48.45), (10.22, 48.57), (10.5, 48.75), (10.37, 48.97), (10.27, 49.15), (10.17, 49.45), (9.95, 49.62),
      (9.65, 49.84), (9.35, 49.67), (9.1, 49.6), (8.85, 49.5), (8.7, 49.63), (8.42, 49.6), (8.48, 49.3), (8.38, 49.12),
      (8.23, 48.97), (8.1, 48.85), (7.93, 48.7), (7.77, 48.55), (7.66, 48.3), (7.55, 48.05), (7.5, 47.75)]
NRW = [(5.83, 51.0), (5.95, 51.2), (6.15, 51.35), (6.2, 51.5), (5.93, 51.78), (6.4, 51.87), (6.75, 51.92), (7.08, 52.25),
       (7.55, 52.5), (7.8, 52.42), (8.05, 52.15), (8.4, 52.35), (8.7, 52.55), (9.15, 52.4), (9.45, 51.9), (9.5, 51.6),
       (9.2, 51.45), (8.9, 51.35), (8.75, 51.15), (8.5, 51.0), (8.25, 50.85), (8.15, 50.68), (7.75, 50.7), (7.35, 50.6),
       (7.15, 50.55), (6.85, 50.3), (6.4, 50.3), (6.25, 50.45), (6.0, 50.6)]
HESSE = [(8.85, 49.37), (9.12, 49.52), (9.15, 49.75), (9.05, 49.92), (9.25, 50.12), (9.6, 50.25), (9.95, 50.38), (10.1, 50.55),
         (10.0, 50.75), (10.25, 50.98), (10.25, 51.2), (9.95, 51.38), (9.7, 51.62), (9.5, 51.69), (9.15, 51.5), (8.85, 51.45),
         (8.6, 51.25), (8.45, 51.05), (8.12, 50.8), (7.95, 50.55), (7.9, 50.3), (7.74, 50.08), (7.92, 49.96), (8.12, 50.0),
         (8.22, 50.03), (8.32, 49.99), (8.4, 49.85), (8.4, 49.58), (8.55, 49.5)]
LOWER_SAXONY = [(6.6, 53.65), (7.9, 53.82), (8.6, 53.92), (9.3, 53.75), (9.75, 53.53), (10.0, 53.43), (10.6, 53.38),
                (11.0, 53.25), (11.62, 53.07), (11.3, 52.85), (11.0, 52.6), (11.1, 52.3), (10.95, 52.05), (10.65, 51.85),
                (10.7, 51.62), (10.35, 51.45), (9.95, 51.3), (9.6, 51.33), (9.5, 51.6), (9.45, 51.9), (9.15, 52.4),
                (8.7, 52.55), (8.4, 52.35), (8.05, 52.15), (7.8, 52.42), (7.55, 52.5), (7.08, 52.25), (6.68, 52.4),
                (6.65, 52.55), (7.08, 52.65), (7.05, 52.85), (7.2, 53.25), (6.9, 53.35)]
BREMEN = [(8.46, 53.0), (9.0, 53.0), (9.0, 53.24), (8.46, 53.24)]
BREMERHAVEN = [(8.46, 53.47), (8.67, 53.47), (8.67, 53.62), (8.46, 53.62)]
SCHLESWIG_HOLSTEIN = [(8.6, 53.88), (9.15, 53.9), (9.7, 53.56), (10.0, 53.76), (10.22, 53.72), (10.32, 53.45), (10.6, 53.35),
                      (10.95, 53.55), (10.95, 53.95), (11.4, 54.4), (11.1, 54.62), (10.6, 54.5), (10.0, 54.85), (9.45, 54.85),
                      (8.65, 54.93), (8.35, 55.1), (8.2, 54.85), (8.2, 54.45), (8.55, 54.3), (8.75, 54.05)]
HELGOLAND = [(7.85, 54.16), (7.93, 54.16), (7.93, 54.2), (7.85, 54.2)]
MECKLENBURG = [(10.55, 53.37), (10.95, 53.55), (10.95, 53.95), (11.45, 54.05), (12.1, 54.22), (12.4, 54.5), (13.05, 54.72),
               (13.5, 54.72), (13.8, 54.6), (13.75, 54.3), (14.3, 54.18), (14.45, 53.88), (14.45, 53.25), (14.2, 53.22),
               (13.9, 53.45), (13.6, 53.4), (13.25, 53.15), (12.95, 53.15), (12.45, 53.22), (12.0, 53.2), (11.6, 53.1),
               (11.22, 53.1), (10.9, 53.3)]
BERLIN = [(13.08, 52.42), (13.12, 52.6), (13.3, 52.68), (13.5, 52.68), (13.66, 52.6), (13.78, 52.45), (13.65, 52.33),
          (13.42, 52.35), (13.25, 52.38)]
BRANDENBURG = [(11.25, 53.05), (11.6, 53.2), (12.0, 53.25), (12.45, 53.25), (12.95, 53.2), (13.25, 53.2), (13.6, 53.43),
               (13.9, 53.5), (14.3, 53.6), (14.45, 53.25), (14.2, 52.85), (14.7, 52.6), (14.6, 52.3), (14.8, 51.95),
               (14.8, 51.55), (14.6, 51.42), (14.0, 51.36), (13.2, 51.38), (12.9, 51.65), (12.6, 51.85), (12.25, 52.15),
               (12.15, 52.4), (12.3, 52.6), (12.05, 52.85), (11.65, 52.92)]
SAXONY = [(12.05, 50.62), (11.85, 50.42), (12.2, 50.15), (12.55, 50.38), (12.95, 50.42), (13.4, 50.58), (13.9, 50.73),
          (14.35, 50.88), (14.6, 50.82), (14.85, 50.86), (15.05, 50.95), (15.05, 51.25), (14.8, 51.6), (14.55, 51.6),
          (14.0, 51.42), (13.2, 51.4), (13.05, 51.68), (12.55, 51.68), (12.15, 51.45), (12.12, 51.25), (12.35, 51.05),
          (12.6, 50.95), (12.3, 50.75)]
THURINGIA = [(9.88, 50.65), (10.05, 50.85), (10.22, 51.0), (10.2, 51.2), (9.95, 51.38), (10.35, 51.6), (10.65, 51.67),
             (11.0, 51.52), (11.4, 51.42), (11.55, 51.25), (11.9, 51.12), (12.2, 51.02), (12.3, 51.12), (12.62, 51.02),
             (12.3, 50.75), (12.05, 50.62), (11.9, 50.38), (11.55, 50.38), (11.25, 50.25), (10.85, 50.22), (10.6, 50.3),
             (10.4, 50.38), (10.05, 50.5)]
RHINELAND_PALATINATE = [(6.1, 50.15), (6.4, 50.33), (6.85, 50.3), (7.15, 50.55), (7.35, 50.6), (7.75, 50.72), (8.15, 50.7),
                        (7.95, 50.5), (7.9, 50.3), (7.74, 50.08), (8.15, 50.04), (8.25, 50.06), (8.35, 49.98), (8.42, 49.82), (8.48, 49.45), (8.42, 49.2),
                        (8.25, 48.95), (7.6, 49.03), (7.3, 49.1), (7.35, 49.35), (7.1, 49.62), (6.65, 49.55), (6.36, 49.5),
                        (6.48, 49.8)]
SAARLAND = [(6.35, 49.48), (6.6, 49.66), (7.0, 49.65), (7.3, 49.58), (7.42, 49.4), (7.4, 49.15), (7.05, 49.08), (6.75, 49.15),
            (6.55, 49.3), (6.4, 49.4)]
AUSTRIA = [(9.5, 47.28), (9.55, 47.58), (9.95, 47.56), (10.2, 47.3), (10.45, 47.57), (10.95, 47.41), (11.2, 47.41), (11.6, 47.6),
           (12.25, 47.72), (12.8, 47.6), (13.0, 47.5), (12.95, 47.75), (12.98, 47.95), (12.75, 48.12), (13.0, 48.3),
           (13.42, 48.58), (13.8, 48.8), (14.05, 48.78), (14.7, 48.6), (15.0, 49.03), (15.6, 48.9), (16.1, 48.78),
           (16.95, 48.65), (17.2, 48.0), (17.15, 47.7), (16.7, 47.55), (16.5, 47.0), (16.1, 46.82), (15.95, 46.65),
           (15.0, 46.58), (14.55, 46.36), (13.7, 46.5), (12.4, 46.68), (12.15, 47.0), (11.6, 46.95), (11.1, 46.92),
           (10.45, 46.83), (10.45, 46.5), (10.1, 46.82), (9.85, 47.0), (9.6, 47.03)]
NETHERLANDS = [(3.35, 51.38), (3.4, 51.6), (4.0, 51.98), (4.5, 52.45), (4.75, 52.98), (4.7, 53.1), (5.0, 53.4), (6.0, 53.55),
               (6.9, 53.52), (7.23, 53.25), (7.2, 52.95), (7.05, 52.6), (6.7, 52.45), (6.95, 52.15), (6.7, 52.0), (6.0, 51.85),
               (5.95, 51.75), (6.2, 51.5), (6.2, 51.35), (6.08, 51.15), (5.85, 51.0), (6.1, 50.85), (5.95, 50.75),
               (5.63, 50.75), (5.72, 51.0), (5.5, 51.25), (5.05, 51.45), (4.75, 51.48), (4.4, 51.35), (3.85, 51.2),
               (3.35, 51.25)]
FLANDERS = [(2.53, 51.1), (3.35, 51.4), (3.85, 51.22), (4.4, 51.38), (4.8, 51.52), (5.1, 51.5), (5.5, 51.3), (5.8, 51.15),
            (5.65, 50.9), (5.7, 50.8), (5.92, 50.75), (5.65, 50.7), (5.2, 50.7), (4.95, 50.75), (4.6, 50.7), (4.2, 50.7), (3.65, 50.72),
            (3.3, 50.75), (3.1, 50.78), (2.85, 50.7), (2.6, 50.82)]
WALLONIA = [(2.85, 50.68), (3.1, 50.8), (3.3, 50.77), (3.65, 50.75), (4.2, 50.72), (4.6, 50.74), (4.95, 50.77), (5.2, 50.73),
            (5.65, 50.73), (5.92, 50.77), (6.12, 50.73), (6.42, 50.33), (6.15, 50.15), (5.95, 50.18), (5.75, 49.88),
            (5.9, 49.53), (5.45, 49.48), (4.85, 49.78), (4.88, 50.15), (4.65, 49.95), (4.15, 49.95), (4.15, 50.3),
            (3.65, 50.45), (3.25, 50.5)]
LUXEMBOURG = [(5.72, 49.55), (5.8, 49.9), (5.95, 50.15), (6.15, 50.19), (6.5, 49.8), (6.38, 49.45), (5.95, 49.43)]
CZECHIA = [(12.1, 50.3), (12.5, 50.4), (12.95, 50.45), (13.4, 50.62), (13.9, 50.77), (14.3, 50.9), (14.35, 51.05), (14.9, 50.88),
           (15.0, 51.02), (15.4, 50.8), (16.0, 50.6), (16.35, 50.6), (16.2, 50.42), (16.55, 50.15), (16.95, 50.25),
           (17.0, 50.43), (17.7, 50.3), (18.05, 50.05), (18.6, 49.95), (18.86, 49.5), (18.4, 49.3), (18.1, 49.05),
           (17.65, 48.85), (17.15, 48.85), (16.95, 48.6), (16.1, 48.75), (15.6, 48.9), (15.0, 49.03), (14.7, 48.58),
           (14.05, 48.6), (13.8, 48.78), (13.4, 49.05), (12.9, 49.35), (12.45, 49.75), (12.1, 50.05)]
SPAIN = [(-9.35, 43.2), (-8.0, 43.8), (-4.5, 43.6), (-1.8, 43.4), (-1.4, 43.05), (-0.5, 42.8), (0.7, 42.85), (1.45, 42.6),
         (3.2, 42.45), (3.35, 41.9), (2.2, 41.25), (0.95, 41.0), (0.2, 40.1), (0.1, 39.3), (0.25, 38.75), (-0.5, 38.2),
         (-0.7, 37.6), (-1.6, 37.2), (-2.0, 36.7), (-4.5, 36.6), (-5.6, 36.0), (-6.4, 36.7), (-7.45, 37.15), (-7.5, 37.6),
         (-7.0, 38.0), (-7.35, 38.45), (-6.95, 39.0), (-7.55, 39.65), (-6.85, 40.25), (-6.8, 41.0), (-6.2, 41.6),
         (-6.6, 41.95), (-7.2, 41.85), (-8.2, 41.8), (-8.9, 41.85)]
BALEARICS = [(1.15, 38.6), (4.4, 38.6), (4.4, 40.15), (1.15, 40.15)]
CANARIES = [(-18.3, 27.6), (-13.3, 27.6), (-13.3, 29.5), (-18.3, 29.5)]


def _box(*outlines):
    """[W, S, E, N] around the outlines (a provider's bounds), so the bounds and the outline cannot disagree"""
    pts = [p for o in outlines for p in o]
    return [min(p[0] for p in pts), min(p[1] for p in pts), max(p[0] for p in pts), max(p[1] for p in pts)]


def _wms(pid, name, region, res, licence, attribution, url, layer, outlines, version="1.3.0", style="", maxzoom=19, src=""):
    """one national/state aerial WMS that answers GetMap in EPSG:3857 (WMS 1.3.0: EPSG:3857 axis order is
    easting,northing, so the BBOX is the same as for 1.1.1 - no swap as with EPSG:4326)"""
    return {"id": pid, "name": name, "kind": "aerial", "resolution": res, "region": region, "license": licence, "nc": False,
            "bounds": _box(*outlines), "outlines": outlines, "maxzoom": maxzoom, "attribution": attribution, "source": src,
            "wms": {"url": url, "version": version, "layer": layer, "style": style}}


def _tiles(pid, name, region, res, licence, attribution, template, outlines, maxzoom=19, src=""):
    """one aerial WMTS in the EPSG:3857 / GoogleMapsCompatible tile matrix (REST or KVP GetTile as a template:
    {z} {x} {y}, {z:02d} where the TileMatrix identifiers are zero-padded "00".."21"; TILEROW = y from the north)"""
    return {"id": pid, "name": name, "kind": "aerial", "resolution": res, "region": region, "license": licence, "nc": False,
            "bounds": _box(*outlines), "outlines": outlines, "maxzoom": maxzoom, "attribution": attribution, "source": src,
            "wmts": template}


PROVIDERS = [
    {"id": "bavaria", "name": "Bavarian DOP20", "kind": "aerial", "resolution": 0.2, "region": "Bavaria",
     "license": "CC BY 4.0", "nc": False, "bounds": _box(BAVARIA), "outlines": [BAVARIA], "maxzoom": 19,
     "attribution": "Bayerische Vermessungsverwaltung (geodaten.bayern.de) - CC BY 4.0",
     "wms": {"url": "https://geoservices.bayern.de/od/wms/dop/v1/dop20", "version": "1.1.1", "layer": "by_dop20c"}},
    {"id": "france", "name": "IGN BD ORTHO", "kind": "aerial", "resolution": 0.2, "region": "Metropolitan France",
     "license": "Licence Ouverte 2.0", "nc": False, "bounds": [-5.2, 41.3, 9.7, 51.2], "outlines": [FRANCE, CORSICA],
     "maxzoom": 19, "attribution": "IGN BD ORTHO - Licence Ouverte 2.0",
     "wms": {"url": "https://data.geopf.fr/wms-r", "version": "1.3.0", "layer": "HR.ORTHOIMAGERY.ORTHOPHOTOS", "style": "normal"}},
    # --- German states (each GetCapabilities states the licence in AccessConstraints/Fees, read 2026-11-22) ---
    _wms("bw", "Baden-Württemberg DOP20", "Baden-Württemberg", 0.2, "dl-de/by-2-0",
         "LGL-BW (2026) Datenlizenz Deutschland - Namensnennung - Version 2.0, www.lgl-bw.de",
         "https://owsproxy.lgl-bw.de/owsproxy/ows/WMS_LGL-BW_ATKIS_DOP_20_C", "IMAGES_DOP_20_RGB", [BW],
         src="GetCapabilities AccessConstraints (dl-de/by-2-0, 'Unentgeltliche Nutzung nach Open Data Lizenz')"),
    _wms("nrw", "NRW DOP10", "North Rhine-Westphalia", 0.1, "dl-de/zero-2-0",
         "Geobasis NRW - dl-de/zero-2-0", "https://www.wms.nrw.de/geobasis/wms_nw_dop", "nw_dop_rgb", [NRW],
         src="GetCapabilities Fees ('Datenlizenz Deutschland - Zero', 10 cm/pixel)"),
    _wms("hesse", "Hessen DOP20", "Hesse", 0.2, "Open data, no conditions (HVGG § 24)",
         "Hessische Verwaltung für Bodenmanagement und Geoinformation (HVBG)",
         "https://www.gds-srv.hessen.de/cgi-bin/lika-services/ogc-free-images.ows", "he_dop20_rgb", [HESSE],
         src="GetCapabilities AccessConstraints ('Jede Nutzung ... ohne Einschränkung oder Bedingung erlaubt')"),
    _wms("bremen", "Bremen DOP20 2023", "Bremen and Bremerhaven", 0.2, "CC BY 4.0",
         "Landesamt GeoInformation Bremen (CC BY 4.0)", "https://geodienste.bremen.de/wms_dop20_2023",
         "DOP20 2023 Land Bremen", [BREMEN, BREMERHAVEN],
         src="GetCapabilities Fees ('Creative Commons Namensnennung (CC-BY)'); version 4.0 per schwarzplan.eu overview"),
    _wms("lower-saxony", "Niedersachsen DOP20", "Lower Saxony", 0.2, "CC BY 4.0",
         "LGLN (2026) Creative Commons Namensnennung - 4.0 International (CC BY 4.0)",
         "https://opendata.lgln.niedersachsen.de/doorman/noauth/dop_wms", "ni_dop20", [LOWER_SAXONY],
         src="GetCapabilities AccessConstraints (CC BY 4.0)"),
    _wms("schleswig-holstein", "Schleswig-Holstein DOP20", "Schleswig-Holstein", 0.2, "CC BY 4.0",
         "© GeoBasis-DE/LVermGeo SH/CC BY 4.0", "https://dienste.gdi-sh.de/WMS_SH_DOP20col_OpenGBD", "sh_dop20_rgb",
         [SCHLESWIG_HOLSTEIN, HELGOLAND], src="GetCapabilities Fees (CC BY 4.0)"),
    _wms("mecklenburg", "Mecklenburg-Vorpommern DOP", "Mecklenburg-Western Pomerania", 0.2, "CC BY 4.0",
         "© GeoBasis-DE/M-V 2026, CC BY 4.0", "https://www.geodaten-mv.de/dienste/adv_dop", "mv_dop", [MECKLENBURG],
         style="palette_rgb", src="geoportal-mv.de: Geobasisdaten open data under CC BY 4.0 since 2024-06-09"),
    _wms("berlin", "Berlin TrueDOP 2024", "Berlin", 0.2, "dl-de/zero-2-0", "Geoportal Berlin / TrueDOP 2024 (dl-de/zero-2-0)",
         "https://gdi.berlin.de/services/wms/truedop_2024", "truedop_2024", [BERLIN],
         src="GetCapabilities Fees ('Datenlizenz Deutschland - Zero - Version 2.0')"),
    _wms("brandenburg", "Brandenburg DOP20", "Brandenburg and Berlin", 0.2, "dl-de/by-2-0", "© GeoBasis-DE/LGB, dl-de/by-2-0",
         "https://isk.geobasis-bb.de/mapproxy/dop20c/service/wms", "bebb_dop20c", [BRANDENBURG],
         src="GetCapabilities AccessConstraints (dl-de/by-2-0, Namensnennung 'GeoBasis-DE/LGB')"),
    _wms("saxony", "Sachsen DOP20", "Saxony", 0.2, "dl-de/by-2-0", "© Geodaten Sachsen (GeoSN), dl-de/by-2-0",
         "https://geodienste.sachsen.de/wms_geosn_dop-rgb/guest", "sn_dop_020", [SAXONY],
         src="GetCapabilities Fees 'kostenfrei' + geoportal.sachsen.de/nutzungsbedingungen.html (dl-de/by-2-0)"),
    _wms("thuringia", "Thüringen DOP20", "Thuringia", 0.2, "CC BY 4.0", "© GDI-Th, CC BY 4.0",
         "https://www.geoproxy.geoportal-th.de/geoproxy/services/DOP", "th_dop", [THURINGIA],
         src="GetCapabilities Fees ('Creative Commons BY 4.0, Namensnennung: © GDI-Th')"),
    _wms("rhineland-palatinate", "Rheinland-Pfalz DOP20", "Rhineland-Palatinate", 0.2, "dl-de/by-2-0",
         "©GeoBasis-DE / LVermGeoRP (2026), dl-de/by-2-0", "https://geo4.service24.rlp.de/wms/rp_dop20.fcgi", "rp_dop20",
         [RHINELAND_PALATINATE], src="GetCapabilities Fees (dl-de/by-2-0, Namensnennung LVermGeoRP)"),
    _wms("saarland", "Saarland DOP20", "Saarland", 0.2, "dl-de/by-2-0", "© LVGL 2026, dl-de/by-2-0, www.lvgl.saarland.de",
         "https://geoportal.saarland.de/freewms/dop2023", "sl_dop20_rgb", [SAARLAND],
         src="GetCapabilities 'noLimitations'; licence dl-de/by-2-0 per schwarzplan.eu overview of the state licences"),
    # --- neighbouring countries ---
    _tiles("austria", "basemap.at Orthofoto", "Austria", 0.3, "CC BY 4.0", "Datenquelle: basemap.at (CC BY 4.0)",
           "https://mapsneu.wien.gv.at/basemap/bmaporthofoto30cm/normal/google3857/{z}/{y}/{x}.jpeg", [AUSTRIA],
           src="basemap.at: Open Government Data, CC BY 4.0; official offline downloader exists; WMTS google3857 0-19"),
    _tiles("netherlands", "PDOK Luchtfoto 8 cm", "Netherlands", 0.08, "CC BY 4.0",
           "Beeldmateriaal Nederland / PDOK (CC BY 4.0)",
           "https://service.pdok.nl/hwh/luchtfotorgb/wmts/v1_0/Actueel_orthoHR/EPSG:3857/{z:02d}/{x}/{y}.jpeg",
           [NETHERLANDS], src="pdok.nl 'PDOK Luchtfoto RGB (Open)': CC BY 4.0; WMTS EPSG:3857 matrices 00-21"),
    _wms("flanders", "Vlaanderen orthofoto (winter)", "Flanders", 0.15, "Modellicentie Gratis Hergebruik v1.0",
         "Bron: Digitaal Vlaanderen", "https://geo.api.vlaanderen.be/OMWRGBMRVL/wms", "Ortho", [FLANDERS],
         src="metadata.vlaanderen.be OMW records: Modellicentie voor gratis hergebruik (open data, any use, attribution)"),
    _wms("wallonia", "Wallonie orthophotos", "Wallonia", 0.25, "CC BY 4.0", "Service public de Wallonie (SPW) - Orthophotos",
         "https://geoservices.wallonie.be/arcgis/services/IMAGERIE/ORTHO_LAST/MapServer/WMSServer", "0", [WALLONIA],
         src="geoportail.wallonie.be catalogue (Orthophotos datasets: CC BY 4.0)"),
    _tiles("luxembourg", "Luxembourg orthophoto", "Luxembourg", 0.1, "CC0 1.0", "Administration du cadastre et de la topographie (CC0)",
           "https://wmts1.geoportail.lu/opendata/service?SERVICE=WMTS&REQUEST=GetTile&VERSION=1.0.0&LAYER=ortho_latest"
           "&STYLE=default&TILEMATRIXSET=GLOBAL_WEBMERCATOR_4_V3&TILEMATRIX={z:02d}&TILEROW={y}&TILECOL={x}&FORMAT=image/jpeg",
           [LUXEMBOURG], src="data.public.lu BD-L-ORTHO webservices: CC0; WMTS KVP only, matrix set in EPSG:3857"),
    _wms("czechia", "ČÚZK Ortofoto ČR", "Czechia", 0.25, "CC BY 4.0", "© ČÚZK (CC BY 4.0)",
         "https://ags.cuzk.cz/arcgis1/services/ORTOFOTO/MapServer/WMSServer", "0", [CZECHIA],
         src="cuzk.gov.cz: open data under CC BY 4.0 since 2023-07-01 (geoportal.gov.cz news id=160056)"),
    _tiles("spain", "IGN PNOA", "Spain", 0.25, "CC BY 4.0", "PNOA cedido por © Instituto Geográfico Nacional (scne.es), CC BY 4.0",
           "https://www.ign.es/wmts/pnoa-ma?SERVICE=WMTS&REQUEST=GetTile&VERSION=1.0.0&LAYER=OI.OrthoimageCoverage"
           "&STYLE=default&TILEMATRIXSET=GoogleMapsCompatible&TILEMATRIX={z}&TILEROW={y}&TILECOL={x}&FORMAT=image/jpeg",
           [SPAIN, BALEARICS, CANARIES], src="GetCapabilities AccessConstraints 'CC BY 4.0 scne.es', Fees 'No se aplican condiciones'"),
    {"id": "s2cloudless", "name": "Sentinel-2 cloudless 2024 (EOX)", "kind": "satellite", "resolution": 10,
     "region": "Worldwide", "license": "CC BY-NC-SA 4.0", "nc": True,
     "bounds": [-180, -85, 180, 85], "outlines": None, "maxzoom": 14,
     "attribution": "Sentinel-2 cloudless - s2maps.eu by EOX IT Services GmbH (contains modified Copernicus Sentinel data 2024) - CC BY-NC-SA 4.0",
     "wmts": "https://tiles.maps.eox.at/wmts/1.0.0/s2cloudless-2024_3857/default/g/{z}/{y}/{x}.jpg"},
]
BY_ID = {p["id"]: p for p in PROVIDERS}


def bounds(value):
    """bounds(): a valid [W, S, E, N] rectangle, rounded to 7 digits (ValueError otherwise)"""
    if not isinstance(value, (list, tuple)) or len(value) != 4 or any(
            isinstance(v, bool) or not isinstance(v, (int, float)) or not math.isfinite(v) for v in value):
        raise ValueError("bad area")
    w, s, e, n = value
    if not (-180 <= w < e <= 180 and -85 <= s < n <= 85):
        raise ValueError("bad area")
    if e - w > 180:
        raise ValueError("bad area")
    return [round(float(v), 7) for v in value]


def contains(outer, inner):
    return outer[0] <= inner[0] and outer[1] <= inner[1] and outer[2] >= inner[2] and outer[3] >= inner[3]


def intersects(a, b):
    return a[0] < b[2] and b[0] < a[2] and a[1] < b[3] and b[1] < a[3]


def tile(lon, lat, z):
    """XYZ tile (column, row from the north) holding lon/lat at zoom z, clamped to the world"""
    n = 2 ** z
    lat = max(-85.0511, min(85.0511, lat))
    x = int((lon + 180) / 360 * n)
    y = int((1 - math.asinh(math.tan(math.radians(lat))) / math.pi) / 2 * n)
    return min(max(x, 0), n - 1), min(max(y, 0), n - 1)


def extent(b, z):
    x0, y0 = tile(b[0], b[3], z)
    x1, y1 = tile(b[2], b[1], z)
    return x0, y0, x1, y1


def mercator(x, y, z):
    """top-left corner of tile x/y/z in EPSG:3857 metres"""
    size = HALF * 2 / 2 ** z
    return -HALF + x * size, HALF - y * size


def tile_bbox(x, y, z):
    left, top = mercator(x, y, z)
    right, bottom = mercator(x + 1, y + 1, z)
    return left, bottom, right, top


def metrics(b, z):
    """metrics() for the detail zoom z (base tiles, estimate incl. the lower levels, stored m/pixel)"""
    x0, y0, x1, y1 = extent(b, z)
    count = (x1 - x0 + 1) * (y1 - y0 + 1)
    area = 6371 ** 2 * math.radians(b[2] - b[0]) * abs(math.sin(math.radians(b[3])) - math.sin(math.radians(b[1])))
    return {"area_km2": round(area, 2), "base_tiles": count, "estimated_bytes": int(count * TILE_BYTES * 4 / 3),
            "stored_resolution": round(156543.03392 * math.cos(math.radians((b[1] + b[3]) / 2)) / 2 ** z, 2)}


def lonlat(x, y, z):
    """lon/lat of the top-left corner of tile x/y/z"""
    n = 2 ** z
    return x / n * 360 - 180, math.degrees(math.atan(math.sinh(math.pi * (1 - 2 * y / n))))


def tile_in(outlines, x, y, z):
    """does the tile touch the outline (a corner or its centre inside, or the outline's first point in the tile)"""
    if not outlines:
        return True
    w, n = lonlat(x, y, z)
    e, s = lonlat(x + 1, y + 1, z)
    pts = [(w, n), (e, n), (w, s), (e, s), ((w + e) / 2, (n + s) / 2)]
    return any(inside(p, o) for o in outlines for p in pts) or any(w <= o[0][0] <= e and s <= o[0][1] <= n for o in outlines)


def tiles(b, zmin, zmax, outlines=None):
    """every (z, x, y) of the area, coarse levels first; with outlines only the tiles that touch them (the tiles are
    stored as the provider's JPEG, which has no transparency: a tile outside the provider's land would be a white square)"""
    for z in range(zmin, zmax + 1):
        x0, y0, x1, y1 = extent(b, z)
        for y in range(y0, y1 + 1):
            for x in range(x0, x1 + 1):
                if outlines is None or tile_in(outlines, x, y, z):
                    yield z, x, y


def count_tiles(b, zmin, zmax, outlines=None):
    if not outlines:
        total = 0
        for z in range(zmin, zmax + 1):
            x0, y0, x1, y1 = extent(b, z)
            total += (x1 - x0 + 1) * (y1 - y0 + 1)
        return total
    if count_tiles(b, zmin, zmax) > MAX_TILES * 2:   # too big anyway: do not walk millions of tiles
        return count_tiles(b, zmin, zmax)
    return sum(1 for _ in tiles(b, zmin, zmax, outlines))


def inside(pt, poly):
    """ray casting: is (lon, lat) inside the polygon"""
    x, y, hit = pt[0], pt[1], False
    j = len(poly) - 1
    for i in range(len(poly)):
        xi, yi = poly[i]
        xj, yj = poly[j]
        if (yi > y) != (yj > y) and x < (xj - xi) * (y - yi) / (yj - yi) + xi:
            hit = not hit
        j = i
    return hit


def covers(p, b):
    """the provider has imagery for this area: inside its bounds and the area's centre inside its outline"""
    if not contains(p["bounds"], b):
        return False
    if not p["outlines"]:
        return True
    c = ((b[0] + b[2]) / 2, (b[1] + b[3]) / 2)
    return any(inside(c, o) for o in p["outlines"])


def zoom_range(p, level):
    """the detail zoom of the level, never above the provider's native resolution (its maxzoom)"""
    z = min(ZOOMS[p["kind"]][level], p.get("maxzoom", 99))
    return max(1, z - SPAN), z


def _rank(p):
    """sharpest first; at the same resolution the smaller (more local) region first: a city state before the state
    around it, a state before the neighbouring country whose generous outline reaches across the border"""
    w, s, e, n = p["bounds"]
    return p["resolution"], (e - w) * (n - s)


def plan(b, level="standard", free=None):
    """the download choices for an area: [{provider fields, minzoom, maxzoom, tiles, estimated_bytes, ...}],
    the recommended (national aerial photography first, else Sentinel-2) first; each says whether it fits on the disk"""
    b = bounds(b)
    if level not in LEVELS:
        raise ValueError("bad level")
    out = []
    for p in sorted(PROVIDERS, key=_rank):
        if not covers(p, b):
            continue
        zmin, zmax = zoom_range(p, level)
        m = metrics(b, zmax)
        n = count_tiles(b, zmin, zmax, p["outlines"])
        est = int(n * TILE_BYTES)       # every level counted exactly (rather than approximating the lower ones as base x 1/3)
        need = est + RESERVE
        o = {k: p[k] for k in ("id", "name", "kind", "resolution", "region", "license", "nc", "attribution")}
        o.update(minzoom=zmin, maxzoom=zmax, tiles=n, estimated_bytes=est,
                 area_km2=m["area_km2"], stored_resolution=m["stored_resolution"], too_big=n > MAX_TILES,
                 fits=None if free is None else free >= need, need_bytes=need)
        out.append(o)
    return b, out


def tile_url(p, z, x, y, fmt="image/jpeg"):
    """the provider URL of one 256 px tile (WMS GetMap in EPSG:3857, or the WMTS template)"""
    if "wmts" in p:
        return p["wmts"].format(z=z, x=x, y=y)
    w = p["wms"]
    left, bottom, right, top = tile_bbox(x, y, z)
    q = [("SERVICE", "WMS"), ("VERSION", w["version"]), ("REQUEST", "GetMap"), ("LAYERS", w["layer"]),
         ("STYLES", w.get("style", "")), ("CRS" if w["version"] == "1.3.0" else "SRS", "EPSG:3857"),
         ("BBOX", "%.3f,%.3f,%.3f,%.3f" % (left, bottom, right, top)), ("WIDTH", "256"), ("HEIGHT", "256"),
         ("FORMAT", fmt)]
    if fmt == "image/png":
        q.append(("TRANSPARENT", "TRUE"))
    from urllib.parse import urlencode
    return w["url"] + "?" + urlencode(q)
