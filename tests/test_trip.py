"""Backend tests for features/trip: trip math, jitter, Trip A auto-reset, recording, prune, GPX. Run: python3 -m unittest tests/test_trip.py"""
import importlib.util, os, shutil, tempfile, unittest
import xml.etree.ElementTree as ET

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))


def load(**env):
    os.environ.update(env)
    spec = importlib.util.spec_from_file_location("navd_trip", os.path.join(ROOT, "features", "trip", "navd_trip.py"))
    m = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(m)
    return m


def drive(tr, t0, n, v=15.0, lat0=48.0, lon0=8.0, dt=1.0):
    """n fixes going north at v m/s; returns the next t"""
    t = t0
    for i in range(n):
        tr.feed(t, lat0 + (i + 1) * v * dt / 111195.0, lon0, v)
        t += dt
    return t


class Trip(unittest.TestCase):
    def setUp(self):
        self.t = tempfile.mkdtemp()
        self.m = load(NAV_DATA=self.t, NAV_TRIP_SIM="0")

    def tearDown(self):
        shutil.rmtree(self.t)

    def test_haversine(self):
        self.assertAlmostEqual(self.m.hav((48, 8), (49, 8)), 111195, delta=200)

    def test_counter_math(self):
        c = self.m.Counter()
        c.feed(0, 48.0, 8.0, 0)
        for i in range(1, 101):
            c.feed(i, 48.0 + i * 20 / 111195.0, 8.0, 20.0)    # 100 s at 72 km/h
        v = c.view()
        self.assertAlmostEqual(v["dist"], 2000, delta=5)
        self.assertEqual(v["drive"], 100)
        self.assertAlmostEqual(v["avg"], 72, delta=0.5)
        self.assertEqual(v["vmax"], 72.0)

    def test_jitter_ignored_when_stopped(self):
        c = self.m.Counter()
        c.feed(0, 48.0, 8.0, 0.2)
        for i in range(1, 60):                                  # 1 m wobble, speed noise 0.9 m/s
            c.feed(i, 48.0 + (i % 3) * 1e-5, 8.0 + (i % 2) * 1e-5, 0.9)
        self.assertEqual((c.dist, c.drive, c.vmax), (0.0, 0.0, 0.0))

    def test_bad_fix_and_gap(self):
        c = self.m.Counter()
        c.feed(0, 48.0, 8.0, 10)
        c.feed(1, 49.0, 8.0, 10)                                 # 111 km in 1 s: ignored
        self.assertEqual(c.dist, 0)
        c.feed(100, 48.5, 8.0, 10)                               # 99 s gap: re-anchors, adds nothing
        self.assertEqual(c.dist, 0)

    def test_trip_a_auto_reset_b_manual(self):
        tr = self.m.trips()
        t = drive(tr, 1000.0, 30)
        self.assertGreater(tr.a.dist, 300)
        self.assertGreater(tr.b.dist, 300)
        drive(tr, t + 4 * 3600 + 60, 3, lat0=48.5)               # parked > 4 h, then drive again
        self.assertLess(tr.a.dist, 100)                          # A started again
        self.assertGreater(tr.b.dist, 300)                       # B kept
        tr.reset("b")
        self.assertEqual(tr.b.dist, 0)
        self.assertFalse(tr.reset("c"))

    def test_sim_ignored_unless_flag(self):
        tr = self.m.trips()
        tr.feed(1.0, 48.0, 8.0, 10, "sim"); tr.feed(2.0, 48.0001, 8.0, 10, "sim")
        self.assertEqual(tr.a.dist, 0)
        d2 = tempfile.mkdtemp()
        m2 = load(NAV_DATA=d2, NAV_TRIP_SIM="1")
        t2 = m2.trips()
        t2.feed(1.0, 48.0, 8.0, 10, "sim"); t2.feed(2.0, 48.0001, 8.0, 10, "sim")
        self.assertGreater(t2.a.dist, 5)
        shutil.rmtree(d2)

    def test_record_listing_gpx_prune(self):
        tr = self.m.trips()
        tr.dest("Home", "Work")
        t = drive(tr, 1700000000.0, 130)                         # 130 s, 15 m/s -> ~1.9 km
        self.assertTrue(tr.rec)
        tr.tick(t + 700)                                         # parked 10+ min: the drive ends
        self.assertIsNone(tr.rec)
        ls = tr.listing()
        self.assertEqual(len(ls), 1)
        s = ls[0]
        self.assertGreater(s["dist"], 1500)
        self.assertEqual((s["from"], s["to"]), ("Home", "Work"))
        self.assertFalse(s["sim"])
        self.assertAlmostEqual(s["n"], 65, delta=2)              # 1 point / 2 s
        h, pts, end = tr.read(tr.path(s["id"]))
        root = ET.fromstring(self.m.gpx(pts, "a & b"))
        ns = {"g": "http://www.topografix.com/GPX/1/1"}
        self.assertEqual(len(root.findall(".//g:trkpt", ns)), len(pts))
        self.assertEqual(root.find(".//g:name", ns).text, "a & b")
        self.assertRegex(root.find(".//g:time", ns).text, r"^2023-11-14T22:1\d:\d\dZ$")
        self.assertIsNone(tr.path("../etc/passwd"))
        self.m.KEEP = 1                                          # prune keeps the newest
        d = drive(tr, 1700100000.0, 130, lat0=48.2)
        tr.tick(d + 700)
        self.assertEqual(len(tr.listing()), 1)
        self.assertTrue(tr.listing()[0]["id"].startswith("2023111"))

    def test_short_drive_dropped_and_crash_recovery(self):
        tr = self.m.trips()
        t = drive(tr, 1700000000.0, 20, v=5)                     # 100 m only
        tr.tick(t + 700)
        self.assertEqual(tr.listing(), [])
        drive(tr, 1700200000.0, 130)                             # cut by power loss: no summary line yet
        self.assertEqual(tr.listing(), [])
        self.m._T = None
        self.assertEqual(len(self.m.trips().listing()), 1)       # a restart closes it

    def test_export_only_to_mounted_dir(self):
        media = os.path.join(self.t, "media")
        os.makedirs(os.path.join(media, "STICK"))
        m = load(NAV_DATA=self.t, TRIP_MEDIA=media)
        tr = m.trips()
        t = drive(tr, 1700000000.0, 130)
        tr.tick(t + 700)
        tid = tr.listing()[0]["id"]
        r = m.export(None, {}, {"id": tid, "dir": os.path.join(media, "STICK")})
        self.assertTrue(r["ok"])
        self.assertTrue(os.path.exists(os.path.join(media, "STICK", tid + ".gpx")))
        r, code = m.export(None, {}, {"id": tid, "dir": "/etc"})
        self.assertEqual(code, 400)


if __name__ == "__main__":
    unittest.main()
