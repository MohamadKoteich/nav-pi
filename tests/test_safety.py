"""PN-44/45/46 safety feature: the stdlib PBF reader (tools/build_safety.py) on a tiny synthetic .pbf, and navd_safety
(points along a route, nearest rest area, routing round low-emission zones with a fake Valhalla)."""
import json, os, struct, subprocess, sys, tempfile, unittest, zlib
from unittest import mock
HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, os.path.join(HERE, "..", "features", "safety"))
sys.path.insert(0, os.path.join(HERE, "..", "tools"))
import navd_safety as ns  # noqa: E402
import build_safety as bs  # noqa: E402


# ---------- a minimal PBF writer (only what the reader needs) ----------
def vi(n):
    out = b""
    while True:
        b = n & 0x7f; n >>= 7
        if n:
            out += bytes([b | 0x80])
        else:
            return out + bytes([b])


def zz(n):
    return (n << 1) ^ (n >> 63)


def fld(f, v):
    if isinstance(v, int):
        return vi(f << 3) + vi(v)
    return vi(f << 3 | 2) + vi(len(v)) + v


def packed(vals, signed=False, delta=False):
    out, prev = b"", 0
    for v in vals:
        d = v - prev if delta else v
        prev = v
        out += vi(zz(d) if signed else d)
    return out


def blob(kind, data):
    b = fld(2, len(data)) + fld(3, zlib.compress(data))
    h = fld(1, kind.encode()) + fld(3, len(b))
    return struct.pack(">I", len(h)) + h + b


def block(strings, group):
    st = b"".join(fld(1, s.encode()) for s in [""] + strings)
    return fld(1, st) + fld(2, group)


def make_pbf(path):
    S = ["highway", "speed_camera", "railway", "level_crossing", "rest_area", "name", "Rastplatz Test",
         "boundary", "low_emission_zone", "Umweltzone Test", "access", "green_sticker_germany", "outer", "maxspeed", "80"]
    ix = {s: i + 1 for i, s in enumerate(S)}
    # nodes 1..3 tagged, 10..13 the zone corners, 20 the rest area's first node
    nodes = [(1, 48.0, 11.50, [("highway", "speed_camera"), ("maxspeed", "80")]), (2, 48.01, 11.51, [("railway", "level_crossing")]),
             (3, 48.02, 11.52, []), (10, 48.1, 11.6, []), (11, 48.1, 11.7, []), (12, 48.2, 11.7, []), (13, 48.2, 11.6, []), (20, 48.3, 11.4, [])]
    kv = []
    for _, _, _, tags in nodes:
        for k, v in tags:
            kv += [ix[k], ix[v]]
        kv.append(0)
    dense = (fld(1, packed([n[0] for n in nodes], True, True)) + fld(8, packed([round(n[1] * 1e7) for n in nodes], True, True)) +
             fld(9, packed([round(n[2] * 1e7) for n in nodes], True, True)) + fld(10, packed(kv)))
    ways = (fld(3, fld(1, 100) + fld(8, packed([10, 11, 12], True, True))) +
            fld(3, fld(1, 101) + fld(8, packed([12, 13, 10], True, True))) +
            fld(3, fld(1, 102) + fld(2, packed([ix["highway"], ix["name"]])) + fld(3, packed([ix["rest_area"], ix["Rastplatz Test"]])) + fld(8, packed([20, 3], True, True))))
    rel = fld(4, fld(1, 500) + fld(2, packed([ix["boundary"], ix["name"], ix["access"]])) +
              fld(3, packed([ix["low_emission_zone"], ix["Umweltzone Test"], ix["green_sticker_germany"]])) +
              fld(8, packed([ix["outer"], ix["outer"]])) + fld(9, packed([100, 101], True, True)) + fld(10, packed([1, 1])))
    with open(path, "wb") as f:
        f.write(blob("OSMHeader", fld(32, 1785000000)))
        f.write(blob("OSMData", block(S, fld(2, dense))))
        f.write(blob("OSMData", block(S, ways)))
        f.write(blob("OSMData", block(S, rel)))


class Reader(unittest.TestCase):
    def test_synthetic_pbf(self):
        with tempfile.TemporaryDirectory() as d:
            pbf, out = os.path.join(d, "t.osm.pbf"), os.path.join(d, "s.json")
            make_pbf(pbf)
            subprocess.run([sys.executable, os.path.join(HERE, "..", "tools", "build_safety.py"), pbf, out, "--threads", "1",
                            "--coverage", "Testland"], check=True, capture_output=True)
            s = json.load(open(out))
        self.assertEqual(s["cameras"], [[48.0, 11.5, 80]])
        self.assertEqual(s["crossings"], [[48.01, 11.51]])
        self.assertEqual(s["rest"], [[48.3, 11.4, 0, "Rastplatz Test"]])
        self.assertEqual(len(s["lez"]), 1)
        z = s["lez"][0]
        self.assertEqual((z["name"], z["sticker"], z["bbox"]), ("Umweltzone Test", "green", [11.6, 48.1, 11.7, 48.2]))
        self.assertEqual(len(z["rings"][0]), 5)
        self.assertEqual((s["coverage"], s["osm_date"]), ("Testland", "2026-07-25"))

    def test_rings_join_reversed_pieces(self):
        self.assertEqual(bs.rings_from_ways([[1, 2, 3], [1, 4, 3]]), [[1, 4, 3, 2, 1]])
        self.assertEqual(bs.rings_from_ways([[1, 2]]), [])   # open leftovers are dropped


class Navd(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        os.makedirs(os.path.join(self.tmp.name, "test", "safety"))
        sq = [[11.6, 48.1], [11.7, 48.1], [11.7, 48.2], [11.6, 48.2], [11.6, 48.1]]
        data = {"cameras": [[48.05, 11.5002, 50]], "crossings": [[48.02, 11.5], [48.03, 11.502]],
                "rest": [[48.07, 11.5030, 1, "Raststätte"], [48.08, 11.4970, 0, "Gegenseite"]], "counts": {"cameras": 1},
                "lez": [{"name": "Z", "sticker": "green", "bbox": [11.6, 48.1, 11.7, 48.2], "rings": [sq], "holes": [], "avoid": [sq], "tags": {}}]}
        json.dump(data, open(os.path.join(self.tmp.name, "test", "safety", "safety.json"), "w"))
        self.env = mock.patch.dict(os.environ, {"NAV_REGION": "test"})
        self.env.start()
        ns.DATA = self.tmp.name
        ns._cache["path"] = None

    def tearDown(self):
        self.env.stop()
        self.tmp.cleanup()

    def test_along_route(self):
        shape = [(48.0 + i * 0.01, 11.5) for i in range(11)]   # north along 11.5 E
        r = ns.along(shape, ["cameras", "crossings", "rest"])
        self.assertEqual([x[0] + x[1] for x in r["crossings"]], [2.0])   # the one 150 m off the road is not on the route
        self.assertEqual(r["cameras"][0][0] + r["cameras"][0][1], 5.0)
        self.assertEqual(r["cameras"][0][3], 50)
        self.assertEqual([x[4] for x in r["rest"]], ["Raststätte"])   # the one left of the road (other carriageway) is not offered
        self.assertNotIn("cameras", ns.along(shape, ["crossings"]))

    def test_nearest_rest(self):
        self.assertEqual(ns.nearest_rest(48.0, 11.5)["name"], "Raststätte")
        self.assertEqual(ns.nearest_rest(52.0, 13.0), {})

    def test_route_round_a_zone(self):
        through = {"trip": {"legs": [{"shape": enc([(48.15, 11.55), (48.15, 11.65), (48.15, 11.75)])}]}}
        around = {"trip": {"legs": [{"shape": enc([(48.15, 11.55), (48.25, 11.65), (48.15, 11.75)])}]}}
        calls = []
        def fake(body):
            calls.append(body)
            return 200, (around if body.get("exclude_polygons") else through)
        with mock.patch.object(ns, "_valhalla", fake):
            r = ns.route_avoid(None, None, {"locations": [{"lat": 48.15, "lon": 11.55}, {"lat": 48.15, "lon": 11.75}], "costing": "auto"})
            self.assertEqual(len(calls), 2)
            self.assertEqual(r["safety"], {"avoided": ["Z"], "unavoidable": []})
            calls.clear()   # destination inside the zone: it cannot be avoided, one plain request
            r = ns.route_avoid(None, None, {"locations": [{"lat": 48.15, "lon": 11.55}, {"lat": 48.15, "lon": 11.65}], "costing": "auto"})
            self.assertEqual(len(calls), 1)
            self.assertEqual(r["safety"]["unavoidable"], ["Z"])


def enc(pts):
    out, plat, plon = "", 0, 0
    for lat, lon in pts:
        la, lo = round(lat * 1e6), round(lon * 1e6)
        for v in (la - plat, lo - plon):
            v = ~(v << 1) if v < 0 else v << 1
            while v >= 0x20:
                out += chr((0x20 | (v & 0x1f)) + 63); v >>= 5
            out += chr(v + 63)
        plat, plon = la, lo
    return out


if __name__ == "__main__":
    unittest.main()
