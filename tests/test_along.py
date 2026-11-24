"""PN-38 places along the route: tile decoding, corridor + projection, the along.sqlite index path, detours
(Valhalla mocked), and tools/build_along.py's PMTiles tile-id decoding."""
import math, os, sqlite3, sys, tempfile, unittest
from unittest import mock
HERE = os.path.dirname(__file__)
sys.path.insert(0, os.path.join(HERE, "..", "features", "nav"))
sys.path.insert(0, os.path.join(HERE, "..", "tools"))
import navd_nav as n
import build_along as ba


# ---- a tiny MVT writer (protobuf), for tile_pois ----
def _vint(v):
    out = bytearray()
    while True:
        b = v & 0x7F; v >>= 7
        out.append(b | (0x80 if v else 0))
        if not v:
            return bytes(out)


def _field(f, payload):
    return _vint(f << 3 | 2) + _vint(len(payload)) + payload


def _packed(vals):
    return b"".join(_vint(v) for v in vals)


def mvt(layer, feats, extent=4096):
    """feats: [(props dict, (x, y))] as points"""
    keys, vals, fbytes = [], [], b""
    for props, (x, y) in feats:
        tags = []
        for k, v in props.items():
            if k not in keys:
                keys.append(k)
            if v not in vals:
                vals.append(v)
            tags += [keys.index(k), vals.index(v)]
        geom = [9, (x << 1) ^ (x >> 31), (y << 1) ^ (y >> 31)]
        fbytes += _field(2, _field(2, _packed(tags)) + _vint(3 << 3) + _vint(1) + _field(4, _packed(geom)))
    body = _field(1, layer.encode()) + fbytes
    body += b"".join(_field(3, k.encode()) for k in keys)
    body += b"".join(_field(4, _field(1, v.encode())) for v in vals)
    body += _vint(5 << 3) + _vint(extent)
    return _field(3, body)


def route(lat0=48.0, lon0=7.8, km=30, step_m=200):
    """a straight route north, [(lat, lon)] and its encoded polyline"""
    pts = [(lat0 + i * step_m / 111195, lon0) for i in range(int(km * 1000 / step_m) + 1)]
    return pts, n._encode6([(round(a * 1e6), round(b * 1e6)) for a, b in pts])


def east(lat, lon, m):
    return lon + m / (111320 * math.cos(math.radians(lat)))


class TilePois(unittest.TestCase):
    def test_only_wanted_kinds_with_names_and_position(self):
        t = mvt("pois", [({"kind": "fuel", "name": "Aral"}, (2048, 2048)), ({"kind": "tree"}, (10, 10)),
                         ({"kind": "toilets"}, (0, 4096)), ({"kind": "parking", "name": "P1"}, (4096, 0))])
        t = mvt("roads", [({"kind": "fuel"}, (1, 1))]) + t   # a "fuel" value in another layer is ignored
        got = n.tile_pois(t, 1, 0, 0)
        self.assertEqual(sorted(g[0] for g in got), ["fuel", "parking", "toilets"])
        fuel = [g for g in got if g[0] == "fuel"][0]
        self.assertEqual(fuel[1], "Aral")
        self.assertAlmostEqual(fuel[3], -90.0, places=6)        # tile x=0 of 2 at z1, mid = lon -90
        self.assertAlmostEqual(fuel[2], 66.513, places=2)
        self.assertEqual([g for g in got if g[0] == "toilets"][0][1], "")   # unnamed kept
        self.assertEqual(n.tile_pois(t, 1, 0, 0, {"toilets"})[0][0], "toilets")


class Corridor(unittest.TestCase):
    def test_projection_ahead_and_off(self):
        pts, _ = route()
        cum = [0.0]
        for a, b in zip(pts, pts[1:]):
            cum.append(cum[-1] + math.hypot(b[0] - a[0], (b[1] - a[1]) * math.cos(math.radians(a[0]))) * 111195)
        lat = 48.0 + 10000 / 111195
        cands = [("fuel", "A", lat, east(lat, 7.8, 300)), ("fuel", "far", lat, east(lat, 7.8, 3000))]
        got = n.project_route(pts, cum, cands, 1500)
        self.assertEqual(len(got), 1)
        self.assertAlmostEqual(got[0][1], 10000, delta=30)
        self.assertAlmostEqual(got[0][2], 300, delta=10)

    def test_corridor_tiles_cover_the_width(self):
        pts, _ = route(km=3)
        tiles = n.corridor_tiles(pts, 1000)
        xs = {x for x, _ in tiles}
        self.assertGreaterEqual(len(xs), 3)   # z15 tile ~ 0.8 km here: +-1 km spans 3+ columns


class AlongIndex(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        d = os.path.join(self.tmp.name, "test", "along")
        os.makedirs(d)
        con = sqlite3.connect(os.path.join(d, "along.sqlite"))
        con.executescript("CREATE TABLE poi(id INTEGER PRIMARY KEY, kind TEXT, name TEXT, lat REAL, lon REAL);"
                          "CREATE VIRTUAL TABLE poi_rt USING rtree(id, minlat, maxlat, minlon, maxlon);")
        rows = []
        for km in (2, 5, 12, 20, 27):
            lat = 48.0 + km * 1000 / 111195
            rows.append(("fuel", "F%d" % km, lat, east(lat, 7.8, 200)))
        lat = 48.0 + 8000 / 111195
        rows += [("rest_area", "R8", lat, east(lat, 7.8, 50)), ("services", "S16", lat + 0.072, east(lat, 7.8, -60)),
                 ("toilets", "", lat, east(lat, 7.8, 5000))]
        con.executemany("INSERT INTO poi(kind, name, lat, lon) VALUES (?,?,?,?)", rows)
        con.execute("INSERT INTO poi_rt SELECT id, lat, lat, lon, lon FROM poi")
        con.commit(); con.close()
        self.p = [mock.patch.object(n, "DATA", self.tmp.name), mock.patch.object(n, "REGION", "test")]
        for p in self.p:
            p.start()

    def tearDown(self):
        for p in self.p:
            p.stop()
        self.tmp.cleanup()

    def test_sorted_ahead_from_position_without_detours(self):
        _, shape = route()
        r = n.along(None, {}, {"shape": shape, "cat": "fuel", "from_m": 4000, "detours": False})
        self.assertEqual(r["source"], "index")
        self.assertEqual([i["name"] for i in r["items"]], ["F5", "F12", "F20", "F27"])   # F2 is behind the car
        self.assertAlmostEqual(r["items"][0]["ahead_m"], 1000, delta=40)
        self.assertTrue(all(i["detour_m"] is None for i in r["items"]))

    def test_rest_is_rest_area_and_services_and_legs_join(self):
        pts, _ = route()
        half = len(pts) // 2
        enc = lambda p: n._encode6([(round(a * 1e6), round(b * 1e6)) for a, b in p])   # noqa: E731
        r = n.along(None, {}, {"legs": [enc(pts[:half + 1]), enc(pts[half:])], "cat": "rest", "detours": False})
        self.assertEqual([i["kind"] for i in r["items"]], ["rest_area", "services"])
        self.assertAlmostEqual(r["items"][1]["ahead_m"], 8000 + 0.072 * 111195, delta=60)

    def test_far_carriageway_dropped_by_detour(self):
        _, shape = route()
        def fake_matrix(src, tgt, timeout=10):   # place -> back onto the route is long for R8 only
            if len(src) == 1:
                return [[1000.0] * len(tgt)]
            return [[21000.0 if abs(p[0] - (48.0 + 8000 / 111195)) < 1e-6 else 3500.0] for p in src]
        with mock.patch.object(n, "_matrix", fake_matrix):
            r = n.along(None, {}, {"shape": shape, "cat": "rest"})
        self.assertEqual([i["name"] for i in r["items"]], ["S16"])
        self.assertGreaterEqual(r["items"][0]["detour_m"], 0)

    def test_bad_input(self):
        self.assertEqual(n.along(None, {}, {"shape": "", "cat": "fuel"})[1], 400)
        _, shape = route()
        self.assertEqual(n.along(None, {}, {"shape": shape, "cat": "pizza"})[1], 400)


class PmtilesIds(unittest.TestCase):
    def test_hilbert_tile_ids(self):
        self.assertEqual([ba.tid_xy(t, 1) for t in range(4)], [(0, 0), (0, 1), (1, 1), (1, 0)])
        seen = {ba.tid_xy(t, 3) for t in range(64)}
        self.assertEqual(len(seen), 64)
        # neighbours on the curve are neighbours on the grid
        for t in range(63):
            a, b = ba.tid_xy(t, 3), ba.tid_xy(t + 1, 3)
            self.assertEqual(abs(a[0] - b[0]) + abs(a[1] - b[1]), 1)


if __name__ == "__main__":
    unittest.main()
