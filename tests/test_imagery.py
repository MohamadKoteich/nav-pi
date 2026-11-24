"""Tests for features/imagery (navd_imagery.py + navd_imagery_plan.py). Run: python3 -m unittest tests/test_imagery.py -v
No network: downloads use a fake fetcher; tiles are served by the real navd core (features/core/navd.py) on a free port."""
import importlib.util, json, math, os, shutil, sqlite3, sys, tempfile, threading, time, unittest, urllib.error, urllib.request  # noqa: E401
from http.server import ThreadingHTTPServer
from urllib.parse import parse_qs, urlparse

HERE = os.path.dirname(os.path.abspath(__file__))
FEAT = os.path.join(HERE, "..", "features")
TMP = tempfile.mkdtemp(prefix="imagerytest-")
sys.path.insert(0, os.path.join(FEAT, "imagery"))   # no os.environ changes: other test modules read NAV_DATA at import


def load(name, path):
    spec = importlib.util.spec_from_file_location(name, path)
    m = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(m)
    return m


P = load("navd_imagery_plan", os.path.join(FEAT, "imagery", "navd_imagery_plan.py"))
sys.modules["navd_imagery_plan"] = P
I = load("navd_imagery", os.path.join(FEAT, "imagery", "navd_imagery.py"))
CORE = load("navd_core_for_imagery", os.path.join(FEAT, "core", "navd.py"))
I.SLEEP = lambda s: None
WEBP = b"RIFF\x10\x00\x00\x00WEBPVP8 fake-tile-"
JPEG = b"\xff\xd8\xff\xe0 fake jpeg "
MUNICH = [11.50, 48.10, 11.65, 48.20]


def wr(path, text):
    with open(path, "w") as f:
        f.write(text)


def make_pack(path, tiles, meta=None):
    db = sqlite3.connect(path)
    db.executescript("CREATE TABLE metadata (name TEXT PRIMARY KEY, value TEXT);"
                     "CREATE TABLE tiles (zoom_level INTEGER, tile_column INTEGER, tile_row INTEGER, tile_data BLOB, PRIMARY KEY (zoom_level, tile_column, tile_row));")
    m = {"name": "Test town", "format": "webp", "bounds": "11.35,48.03,11.74,48.26", "minzoom": "3", "maxzoom": "18",
         "scheme": "tms", "attribution": "<a href=\"x\">Bayerische Vermessungsverwaltung</a> · CC BY 4.0"}
    m.update(meta or {})
    db.executemany("INSERT INTO metadata VALUES (?, ?)", m.items())
    db.executemany("INSERT INTO tiles VALUES (?, ?, ?, ?)", tiles)
    db.commit()
    db.close()


class FakeApp:
    def __init__(self):
        self.routes, self.prefixes, self.statuses = {}, [], {}

    def get(self, p, fn): self.routes[("GET", p)] = fn
    def post(self, p, fn): self.routes[("POST", p)] = fn
    def get_prefix(self, p, fn): self.prefixes.append((p, fn))
    def thread(self, fn): pass
    def status(self, k, fn): self.statuses[k] = fn


def fresh_dir():
    d = tempfile.mkdtemp(prefix="img-", dir=TMP)
    I.DIR = d
    I.job.clear()
    I.job["state"] = "idle"
    I.ctl["pause"].clear()
    I.ctl["cancel"].clear()
    return d


def wait_job(timeout=20):
    t0 = time.time()
    while I.job.get("state") in ("running", "paused") and time.time() - t0 < timeout:
        time.sleep(0.02)
    return I.job.get("state")


class Serving(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.dir = fresh_dir()
        # tile z3 x4 y2 (XYZ, from the north) is row 8-1-2 = 5 in the TMS file
        make_pack(os.path.join(cls.dir, "munich.mbtiles"), [(3, 4, 5, WEBP), (3, 4, 2, JPEG)])
        wr(os.path.join(cls.dir, "notes.txt"), "not a pack")
        wr(os.path.join(cls.dir, "broken.mbtiles"), "not sqlite")
        wr(os.path.join(cls.dir, ".x.mbtiles.part"), "half")
        CORE.APP.routes.clear()
        CORE.APP.prefixes.clear()
        I.register(CORE.APP)
        cls.srv = ThreadingHTTPServer(("127.0.0.1", 0), CORE.Handler)
        threading.Thread(target=cls.srv.serve_forever, daemon=True).start()
        cls.base = "http://127.0.0.1:%d" % cls.srv.server_address[1]

    @classmethod
    def tearDownClass(cls):
        cls.srv.shutdown()
        cls.srv.server_close()

    def get(self, path):
        try:
            with urllib.request.urlopen(self.base + path, timeout=5) as r:
                return r.status, r.headers, r.read()
        except urllib.error.HTTPError as e:
            return e.code, e.headers, e.read()

    def test_tile_y_flip_and_headers(self):
        code, h, body = self.get("/sat/munich/3/4/2")
        self.assertEqual(code, 200)
        self.assertEqual(body, WEBP)                     # XYZ y=2 -> TMS row 5
        self.assertEqual(h["Content-Type"], "image/webp")
        self.assertIn("max-age=604800", h["Cache-Control"])
        self.assertNotIn("no-cache", h.get_all("Cache-Control"))
        code, h, body = self.get("/sat/munich/3/4/5?v=123")
        self.assertEqual((code, h["Content-Type"], body), (200, "image/jpeg", JPEG))

    def test_missing_tile_is_transparent_png(self):
        code, h, body = self.get("/sat/munich/3/1/1")
        self.assertEqual((code, h["Content-Type"]), (200, "image/png"))
        self.assertTrue(body.startswith(b"\x89PNG"))

    def test_bad_requests(self):
        for path in ("/sat/nope/3/4/2", "/sat/../munich/3/4/2", "/sat/munich/3/99/2", "/sat/munich/x/1/1",
                     "/sat/munich/3/4"):
            self.assertEqual(self.get(path)[0], 404, path)

    def test_listing(self):
        code, _, body = self.get("/api/imagery")
        d = json.loads(body)
        self.assertEqual([p["id"] for p in d["packs"]], ["munich"])   # junk, broken and .part files are not packs
        p = d["packs"][0]
        self.assertEqual(p["bounds"], [11.35, 48.03, 11.74, 48.26])
        self.assertEqual((p["minzoom"], p["maxzoom"], p["format"]), (3, 18, "webp"))
        self.assertIn("Bayerische Vermessungsverwaltung", p["attribution"])
        self.assertEqual(p["size"], os.path.getsize(os.path.join(self.dir, "munich.mbtiles")))
        self.assertEqual({x["id"] for x in d["providers"]}, {p["id"] for p in P.PROVIDERS})
        self.assertTrue({"bavaria", "france", "bw", "nrw", "austria", "netherlands", "spain", "s2cloudless"} <= {x["id"] for x in d["providers"]})


class Planner(unittest.TestCase):
    def test_provider_by_area(self):
        ids = lambda b: [o["id"] for o in P.plan(b, "standard")[1]]  # noqa: E731
        self.assertEqual(ids(MUNICH), ["bavaria", "s2cloudless"])          # national aerial photography first
        self.assertEqual(ids([2.30, 48.82, 2.40, 48.90]), ["france", "s2cloudless"])   # Paris
        self.assertEqual(ids([8.70, 42.0, 8.80, 42.1]), ["france", "s2cloudless"])     # Corsica
        self.assertEqual(ids([9.13, 48.74, 9.23, 48.81]), ["bw", "s2cloudless"])      # Stuttgart: in Bavaria's box, not in Bavaria
        self.assertEqual(ids([35.4, 33.8, 35.6, 34.0]), ["s2cloudless"])              # Beirut

    def test_more_cities(self):
        """sharp aerial photos beyond Bavaria/France; the sharpest provider covering the area first"""
        first = lambda lon, lat: P.plan([lon - 0.03, lat - 0.02, lon + 0.03, lat + 0.02], "standard")[1][0]["id"]  # noqa: E731
        cities = {"bw": [(9.06, 48.52), (9.18, 48.78), (8.40, 49.01)],            # Tuebingen, Stuttgart, Karlsruhe
                  "nrw": [(6.96, 50.94), (7.47, 51.51), (6.78, 51.23)],          # Cologne, Dortmund, Duesseldorf
                  "hesse": [(8.68, 50.11), (9.48, 51.31)], "lower-saxony": [(9.74, 52.37), (10.52, 52.27)],
                  "bremen": [(8.81, 53.08), (8.58, 53.55)], "schleswig-holstein": [(10.14, 54.32), (10.69, 53.87)],
                  "mecklenburg": [(12.14, 54.09), (11.41, 53.63)], "berlin": [(13.40, 52.52)],
                  "brandenburg": [(13.06, 52.40), (14.33, 51.76)], "saxony": [(13.74, 51.05), (12.37, 51.34)],
                  "thuringia": [(11.03, 50.98), (11.59, 50.93)], "rhineland-palatinate": [(8.27, 50.0), (6.64, 49.75)],
                  "saarland": [(7.0, 49.23)], "austria": [(16.37, 48.21), (13.04, 47.80), (11.39, 47.27), (15.44, 47.07)],
                  "netherlands": [(4.90, 52.37), (4.48, 51.92), (5.12, 52.09)], "flanders": [(4.40, 51.22), (3.72, 51.05)],
                  "wallonia": [(5.57, 50.63), (4.44, 50.41)], "luxembourg": [(6.13, 49.61)], "czechia": [(14.42, 50.09), (16.61, 49.20)],
                  "spain": [(-3.70, 40.42), (2.17, 41.39), (-5.98, 37.39), (2.65, 39.57), (-15.43, 28.12)],
                  "france": [(7.75, 48.58), (2.35, 48.86)],                        # Strasbourg is not Baden-Wuerttemberg
                  "bavaria": [(11.58, 48.14), (10.90, 48.37), (9.68, 47.55)],     # Lindau: not BW, not Austria
                  # borders: Kehl is BW (France's generous outline reaches it, the smaller region wins the tie),
                  # Maastricht is NL (not Flanders), Salzburg is Austria (not Bavaria), Mainz is RP (not Hesse)
                  "bw ": [(7.81, 48.57)], "netherlands ": [(5.69, 50.85)], "austria ": [(13.04, 47.80)],
                  "rhineland-palatinate ": [(8.27, 50.0)],
                  "s2cloudless": [(35.50, 33.89), (8.54, 47.37), (7.59, 47.56), (12.57, 55.68), (21.01, 52.23), (10.0, 53.55)]}
        for want, pts in cities.items():          # Beirut, Zurich, Basel, Copenhagen, Warsaw, Hamburg -> Sentinel-2
            for lon, lat in pts:
                self.assertEqual(first(lon, lat), want.strip(), (lon, lat))
        # several cover: sorted by resolution, Sentinel-2 always last
        o = P.plan([4.88, 52.36, 4.92, 52.38])[1]
        self.assertEqual([x["resolution"] for x in o], sorted(x["resolution"] for x in o))
        self.assertEqual(o[-1]["id"], "s2cloudless")

    def test_catalogue_is_complete(self):
        for p in P.PROVIDERS:
            for k in ("id", "name", "kind", "resolution", "region", "license", "attribution", "bounds", "maxzoom"):
                self.assertTrue(p.get(k), (p["id"], k))
            self.assertTrue(("wms" in p) != ("wmts" in p), p["id"])
            self.assertNotRegex(p.get("wmts", "") + p.get("wms", {}).get("url", ""), r"(?i)google\.|googleapis|arcgisonline|virtualearth|bing\.|mapbox|apikey|key=|token")
            if p["outlines"]:
                self.assertTrue(all(len(o) >= 4 for o in p["outlines"]), p["id"])
                self.assertTrue(all(P.contains(p["bounds"], [x, y, x, y]) for o in p["outlines"] for x, y in o), p["id"])
        self.assertEqual(len({p["id"] for p in P.PROVIDERS}), len(P.PROVIDERS))

    def test_maxzoom_is_native_resolution(self):
        for p in P.PROVIDERS:
            for level in P.LEVELS:
                self.assertLessEqual(P.zoom_range(p, level)[1], p["maxzoom"])
        coarse = dict(P.BY_ID["austria"], maxzoom=16)
        self.assertEqual(P.zoom_range(coarse, "high"), (11, 16))
        self.assertEqual(P.zoom_range(coarse, "overview"), (10, 15))
        self.assertEqual(P.zoom_range(P.BY_ID["s2cloudless"], "high"), (9, 14))

    def test_levels_and_zooms(self):
        _, o = P.plan(MUNICH, "high")
        self.assertEqual((o[0]["minzoom"], o[0]["maxzoom"]), (13, 18))
        self.assertEqual((o[1]["minzoom"], o[1]["maxzoom"]), (9, 14))
        self.assertEqual(P.plan(MUNICH, "overview")[1][0]["maxzoom"], 15)
        with self.assertRaises(ValueError):
            P.plan(MUNICH, "ultra")
        for bad in ([1, 2, 3], [10, 48, 9, 49], [0, -89, 1, 1], ["a", 1, 2, 3], [True, 1, 2, 3], [-170, 0, 170, 1]):
            with self.assertRaises(ValueError):
                P.bounds(bad)

    def test_tile_math(self):
        self.assertEqual(P.tile(0, 0, 1), (1, 1))
        self.assertEqual(P.tile(-180, 85.05, 4), (0, 0))
        self.assertEqual(P.tile(11.575, 48.137, 14), (8718, 5685))
        x0, y0, x1, y1 = P.extent(MUNICH, 16)
        self.assertEqual(P.count_tiles(MUNICH, 16, 16), (x1 - x0 + 1) * (y1 - y0 + 1))
        self.assertEqual(P.count_tiles(MUNICH, 12, 16), len(list(P.tiles(MUNICH, 12, 16))))
        # with an outline, only the tiles touching it: an area across the Bavarian border keeps fewer tiles
        b = [9.85, 47.90, 10.25, 48.10]   # Iller valley: Baden-Wuerttemberg west, Bavaria east
        full, kept = P.count_tiles(b, 14, 14), P.count_tiles(b, 14, 14, P.BY_ID["bavaria"]["outlines"])
        self.assertLess(kept, full)
        self.assertGreater(kept, full * 0.3)

    def test_size_estimate_is_maps_plus_metrics(self):
        m = P.metrics(MUNICH, 17)
        x0, y0, x1, y1 = P.extent(MUNICH, 17)
        base = (x1 - x0 + 1) * (y1 - y0 + 1)
        self.assertEqual(m["base_tiles"], base)
        self.assertEqual(m["estimated_bytes"], int(base * 30000 * 4 / 3))   # estimate formula
        area = 6371 ** 2 * math.radians(0.15) * abs(math.sin(math.radians(48.2)) - math.sin(math.radians(48.1)))
        self.assertAlmostEqual(m["area_km2"], area, places=1)
        self.assertAlmostEqual(m["stored_resolution"], 0.8, delta=0.05)
        _, o = P.plan(MUNICH, "standard", free=10 ** 12)
        self.assertEqual(o[0]["tiles"], P.count_tiles(MUNICH, 12, 17, P.BY_ID["bavaria"]["outlines"]))
        self.assertEqual(o[0]["estimated_bytes"], o[0]["tiles"] * 30000)
        self.assertTrue(o[0]["fits"])
        self.assertFalse(P.plan(MUNICH, "standard", free=o[0]["estimated_bytes"])[1][0]["fits"])   # 2 GiB reserve
        self.assertTrue(P.plan([5, 45, 15, 54], "high", free=10 ** 12)[1][-1]["too_big"])

    def test_urls(self):
        u = urlparse(P.tile_url(P.BY_ID["bavaria"], 16, 34880, 22730))
        q = {k: v[0] for k, v in parse_qs(u.query, keep_blank_values=True).items()}
        self.assertEqual(u.netloc, "geoservices.bayern.de")
        self.assertEqual((q["VERSION"], q["SRS"], q["LAYERS"], q["WIDTH"], q["FORMAT"]), ("1.1.1", "EPSG:3857", "by_dop20c", "256", "image/jpeg"))
        left, bottom, right, top = [float(v) for v in q["BBOX"].split(",")]
        self.assertAlmostEqual(right - left, 2 * P.HALF / 2 ** 16, places=2)
        self.assertAlmostEqual(top - bottom, right - left, places=2)
        self.assertAlmostEqual(left, -P.HALF + 34880 * 2 * P.HALF / 2 ** 16, places=2)
        q = parse_qs(urlparse(P.tile_url(P.BY_ID["france"], 16, 1, 2)).query)
        self.assertIn("CRS", q)
        self.assertEqual(q["STYLES"], ["normal"])
        self.assertEqual(P.tile_url(P.BY_ID["s2cloudless"], 10, 545, 355),
                         "https://tiles.maps.eox.at/wmts/1.0.0/s2cloudless-2024_3857/default/g/10/355/545.jpg")
        self.assertTrue(P.BY_ID["s2cloudless"]["nc"])
        # WMTS REST with zero-padded TileMatrix ids (PDOK "00".."21"), REST z/y/x (basemap.at), KVP GetTile (IGN, geoportail.lu)
        self.assertEqual(P.tile_url(P.BY_ID["netherlands"], 9, 263, 168),
                         "https://service.pdok.nl/hwh/luchtfotorgb/wmts/v1_0/Actueel_orthoHR/EPSG:3857/09/263/168.jpeg")
        self.assertEqual(P.tile_url(P.BY_ID["austria"], 16, 35709, 22722),
                         "https://mapsneu.wien.gv.at/basemap/bmaporthofoto30cm/normal/google3857/16/22722/35709.jpeg")
        q = {k: v[0] for k, v in parse_qs(urlparse(P.tile_url(P.BY_ID["spain"], 16, 32094, 24735)).query).items()}
        self.assertEqual((q["REQUEST"], q["TILEMATRIXSET"], q["TILEMATRIX"], q["TILEROW"], q["TILECOL"]),
                         ("GetTile", "GoogleMapsCompatible", "16", "24735", "32094"))
        q = {k: v[0] for k, v in parse_qs(urlparse(P.tile_url(P.BY_ID["luxembourg"], 8, 132, 87)).query).items()}
        self.assertEqual((q["LAYER"], q["TILEMATRIXSET"], q["TILEMATRIX"], q["TILEROW"], q["TILECOL"]),
                         ("ortho_latest", "GLOBAL_WEBMERCATOR_4_V3", "08", "87", "132"))
        # WMS 1.3.0 in EPSG:3857: CRS (not SRS), easting,northing order, a layer name with spaces is encoded
        u = urlparse(P.tile_url(P.BY_ID["bremen"], 16, 34371, 21181))
        q = {k: v[0] for k, v in parse_qs(u.query, keep_blank_values=True).items()}
        self.assertEqual((u.netloc, q["VERSION"], q["CRS"], q["LAYERS"]), ("geodienste.bremen.de", "1.3.0", "EPSG:3857", "DOP20 2023 Land Bremen"))
        left, bottom, right, top = [float(v) for v in q["BBOX"].split(",")]
        self.assertGreater(left, 900000)          # Bremen ~ 8.8 E -> ~980 km east: easting first
        self.assertGreater(bottom, 6900000)
        self.assertEqual(parse_qs(urlparse(P.tile_url(P.BY_ID["mecklenburg"], 16, 1, 2)).query)["STYLES"], ["palette_rgb"])
        self.assertIn("nav-pi", I.UA)


class Fetcher:
    """fake provider: counts calls + concurrency; fail_at = set of call numbers that always fail"""
    def __init__(self, fail=None, delay=0.0):
        self.calls, self.urls, self.active, self.peak, self.fail, self.delay = 0, [], 0, 0, fail, delay
        self.lock = threading.Lock()

    def __call__(self, url):
        with self.lock:
            self.calls += 1
            self.urls.append(url)
            self.active += 1
            self.peak = max(self.peak, self.active)
        try:
            time.sleep(self.delay)
            if self.fail and self.fail(url):
                raise OSError("urlopen error [Errno -3] Temporary failure in name resolution")
            return JPEG + url.encode(), "image/jpeg"
        finally:
            with self.lock:
                self.active -= 1


AREA = [11.55, 48.12, 11.60, 48.15]


class Download(unittest.TestCase):
    def setUp(self):
        self.dir = fresh_dir()
        I.APP = FakeApp()
        I.FETCH = Fetcher(delay=0.002)

    def start(self, **kw):
        body = dict(bounds=AREA, level="overview", provider="s2cloudless", name="Test area")
        body.update(kw)
        return I.api_download(None, {}, body)

    def test_download_writes_pack_atomically(self):
        n = P.plan(AREA, "overview")[1][-1]["tiles"]
        seen_part = []
        orig = I.finish

        def spy(db, path, final, req, p):   # before the rename: only the .part exists, no half pack
            seen_part.append((os.path.exists(path), os.path.exists(final), [x["id"] for x in I.packs()]))
            return orig(db, path, final, req, p)
        I.finish = spy
        try:
            r = self.start()
            self.assertTrue(r["ok"])
            self.assertEqual(wait_job(), "done")
        finally:
            I.finish = orig
        self.assertEqual(seen_part, [(True, False, [])])
        files = os.listdir(self.dir)
        self.assertEqual(files, [r["id"] + ".mbtiles"])                    # no .part left
        self.assertEqual(I.FETCH.calls, n)
        self.assertLessEqual(I.FETCH.peak, 2)                              # polite: at most 2 at once
        db = sqlite3.connect(os.path.join(self.dir, files[0]))
        meta = dict(db.execute("SELECT name, value FROM metadata"))
        self.assertEqual((meta["minzoom"], meta["maxzoom"], meta["scheme"], meta["format"]), ("5", "10", "tms", "jpg"))
        self.assertIn("EOX", meta["attribution"])
        self.assertNotIn("navpi_request", meta)
        self.assertEqual(db.execute("SELECT COUNT(*) FROM tiles").fetchone()[0], n)
        x, y = P.tile(11.575, 48.135, 10)
        data = db.execute("SELECT tile_data FROM tiles WHERE zoom_level=10 AND tile_column=? AND tile_row=?", (x, 1023 - y)).fetchone()[0]
        self.assertTrue(data.endswith(("/10/%d/%d.jpg" % (y, x)).encode()))   # stored as fetched, TMS row
        self.assertEqual(db.execute("PRAGMA journal_mode").fetchone()[0], "delete")
        db.close()
        self.assertEqual([p["id"] for p in I.packs()], [r["id"]])

    def test_failure_keeps_part_and_resume_finishes(self):
        I.FETCH = Fetcher(fail=lambda u: "/10/" in u)                      # the detail level fails (no internet)
        r = self.start()
        self.assertEqual(wait_job(), "failed")
        self.assertEqual(I.job["error"], "offline")
        self.assertFalse(os.path.exists(os.path.join(self.dir, r["id"] + ".mbtiles")))
        u = I.unfinished()
        self.assertEqual([x["id"] for x in u], [r["id"]])
        self.assertGreater(u[0]["done"], 0)
        good = Fetcher()
        I.FETCH = good
        self.assertTrue(I.api_download(None, {}, {"resume": r["id"]})["ok"])
        self.assertEqual(wait_job(), "done")
        self.assertTrue(all("/10/" in x for x in good.urls))               # only the missing tiles were fetched
        self.assertEqual(I.unfinished(), [])
        self.assertTrue(os.path.exists(os.path.join(self.dir, r["id"] + ".mbtiles")))

    def test_refused_tile_is_skipped_not_fatal(self):
        # IGN answered one HTTP 400 inside a 1912-tile Paris job on the Pi (2026-11-22) and the whole job failed
        target = []

        def one_bad(url):
            if not target:
                target.append(url)
            if url == target[0]:
                raise urllib.error.HTTPError(url, 400, "Bad Request", {}, None)
            return JPEG + url.encode(), "image/jpeg"
        I.FETCH = one_bad
        self.start()
        self.assertEqual(wait_job(), "done")
        self.assertEqual(I.job["skipped"], 1)
        # access refused (403) still stops the job, and too many refused tiles too
        I.FETCH = lambda u: (_ for _ in ()).throw(urllib.error.HTTPError(u, 403, "Forbidden", {}, None))
        self.start()
        self.assertEqual(wait_job(), "failed")
        self.assertEqual(I.job["error"], "HTTP 403")

    def test_retry_with_backoff(self):
        tries = {}
        sleeps = []
        I.SLEEP = sleeps.append

        def flaky(url):
            tries[url] = tries.get(url, 0) + 1
            if tries[url] < 3:
                raise OSError("timed out")
            return JPEG, "image/jpeg"
        I.FETCH = flaky
        try:
            self.assertEqual(I.get_tile(P.BY_ID["s2cloudless"], 5, 1, 1), JPEG)
        finally:
            I.SLEEP = lambda s: None
        self.assertEqual(sleeps, [2, 4])

        def html(url):
            return b"<html>error</html>", "text/html"
        I.FETCH = html
        with self.assertRaises(OSError):
            I.get_tile(P.BY_ID["s2cloudless"], 5, 1, 1)

    def test_pause_resume_cancel(self):
        I.FETCH = Fetcher(delay=0.02)
        r = self.start(level="standard", provider="bavaria")
        time.sleep(0.15)
        I.api_pause(None, {}, {})
        time.sleep(0.2)
        self.assertEqual(I.job["state"], "paused")
        done = I.job["done"]
        time.sleep(0.2)
        self.assertEqual(I.job["done"], done)                              # nothing fetched while paused
        I.api_resume(None, {}, {})
        time.sleep(0.15)
        self.assertGreater(I.job["done"], done)
        I.api_cancel(None, {}, {})
        self.assertEqual(wait_job(), "cancelled")
        self.assertEqual(os.listdir(self.dir), [])                         # .part removed, nothing installed
        self.assertFalse(os.path.exists(I.part_path(r["id"])))

    def test_refusals(self):
        I.APP.statuses["gps"] = lambda: {"mode": 3, "speed": 12.0}
        self.assertEqual(self.start(), ({"error": "driving"}, 409))
        I.APP.statuses["gps"] = lambda: {"mode": 3, "speed": 0.3}
        orig = I.free_bytes
        I.free_bytes = lambda: 10 ** 9                                     # 1 GB free < estimate + 2 GiB reserve
        try:
            res = self.start()
            self.assertEqual((res[1], res[0]["error"]), (400, "space"))
        finally:
            I.free_bytes = orig
        self.assertEqual(self.start(bounds=[5, 45, 15, 54], level="high")[0]["error"], "too_big")
        self.assertEqual(self.start(provider="bavaria", bounds=[2.3, 48.82, 2.4, 48.9])[0]["error"], "provider")
        self.assertEqual(self.start(bounds=[1, 2])[1], 400)
        I.FETCH = Fetcher(delay=0.05)
        self.assertTrue(self.start()["ok"])
        self.assertEqual(self.start(), ({"error": "busy"}, 409))
        I.api_cancel(None, {}, {})
        wait_job()
        self.assertEqual(os.listdir(self.dir), [])

    def test_delete(self):
        make_pack(os.path.join(self.dir, "old.mbtiles"), [(3, 1, 1, WEBP)])
        self.assertEqual(I.api_delete(None, {}, {"id": "../x"})[1], 400)
        self.assertEqual(I.api_delete(None, {}, {"id": "nope"})[1], 404)
        self.assertEqual(I.api_delete(None, {}, {"id": "old"}), {"ok": True})
        self.assertEqual(os.listdir(self.dir), [])


class UsbImport(unittest.TestCase):
    def setUp(self):
        self.dir = fresh_dir()
        self.stick = tempfile.mkdtemp(prefix="stick-", dir=TMP)
        os.makedirs(os.path.join(self.stick, "maps", "sat"))
        make_pack(os.path.join(self.stick, "maps", "sat", "Paris Center.mbtiles"), [(3, 1, 1, WEBP)] * 1, {"name": "Paris"})
        wr(os.path.join(self.stick, "maps", "fake.mbtiles"), "no")
        os.makedirs(os.path.join(self.stick, ".hidden"))
        make_pack(os.path.join(self.stick, ".hidden", "h.mbtiles"), [(3, 1, 1, WEBP)])
        app = FakeApp()
        app.get("/api/usb", lambda h, q, j: [{"id": "s1", "label": "STICK", "path": self.stick, "free": 1, "total": 2}])
        I.APP = app

    def test_scan_and_import(self):
        files = I.usb_files()
        self.assertEqual([(f["name"], f["stick"]) for f in files], [("Paris", "STICK")])
        self.assertEqual(I.api_import(None, {}, {"path": "/etc/passwd"})[1], 404)      # only files the scan found
        r = I.api_import(None, {}, {"path": files[0]["path"]})
        self.assertTrue(r["ok"])
        self.assertEqual(wait_job(), "done")
        self.assertEqual(r["id"], "paris-center")
        self.assertEqual([p["name"] for p in I.packs()], ["Paris"])
        self.assertTrue(os.path.exists(files[0]["path"]))                               # the stick is never changed
        r2 = I.api_import(None, {}, {"path": files[0]["path"]})                         # a second copy gets its own id
        self.assertEqual(wait_job(), "done")
        self.assertEqual(r2["id"], "paris-center-2")

    def test_refused_while_moving(self):
        I.APP.statuses["gps"] = lambda: {"mode": 2, "speed": 20}
        self.assertEqual(I.api_import(None, {}, {"path": "x"}), ({"error": "driving"}, 409))


def tearDownModule():
    shutil.rmtree(TMP, ignore_errors=True)


if __name__ == "__main__":
    unittest.main()
