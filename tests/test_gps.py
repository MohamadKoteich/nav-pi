"""Tests for features/gps (navd_gps.py + dead reckoning). Run: python3 -m unittest tests/test_gps.py -v
No receiver and no gpsd needed: tests/fake_gpsd.py speaks gpsd 3.25 JSON (VERSION, DEVICES, WATCH, TPV, SKY)."""
import importlib.util, os, shutil, subprocess, sys, threading, time, unittest  # noqa: E401

HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, HERE)
from fake_gpsd import FakeGpsd  # noqa: E402

spec = importlib.util.spec_from_file_location("navd_gps", os.path.join(HERE, "..", "features", "gps", "navd_gps.py"))
G = importlib.util.module_from_spec(spec)
spec.loader.exec_module(G)

# recorded-style gpsd 3.25 objects (u-blox 8, USB)
DEVICES = {"class": "DEVICES", "devices": [{"class": "DEVICE", "path": "/dev/ttyACM0", "driver": "u-blox", "subtype": "SW EXT CORE 3.01 (111141),HW 00080000",
                                            "activated": "2026-11-12T10:00:00.000Z", "bps": 9600, "parity": "N", "stopbits": 1, "cycle": 1.0}]}
TPV3 = {"class": "TPV", "device": "/dev/ttyACM0", "mode": 3, "time": "2026-11-12T10:00:01.000Z", "ept": 0.005, "lat": 48.14, "lon": 11.58, "altHAE": 290.1,
        "altMSL": 243.9, "epx": 3.0, "epy": 4.0, "epv": 8.0, "track": 91.5, "speed": 13.2, "climb": 0.0, "eph": 4.2}
TPV1 = {"class": "TPV", "device": "/dev/ttyACM0", "mode": 1, "time": "2026-11-12T10:05:00.000Z"}
SKY_DOP = {"class": "SKY", "device": "/dev/ttyACM0", "xdop": 0.8, "ydop": 1.1, "vdop": 1.4, "tdop": 0.9, "hdop": 1.3, "gdop": 2.4, "pdop": 1.9}
SKY_SATS = {"class": "SKY", "device": "/dev/ttyACM0", "nSat": 3, "uSat": 2, "satellites": [
    {"PRN": 5, "el": 62, "az": 200, "ss": 44, "used": True, "gnssid": 0}, {"PRN": 7, "el": 30, "az": 310, "ss": 38.5, "used": True, "gnssid": 0},
    {"PRN": 13, "el": 15, "az": 20, "ss": 21, "used": False, "gnssid": 0}]}


class Fold(unittest.TestCase):
    def setUp(self):
        G.reset()

    def test_no_message_no_receiver(self):
        i = G.info()
        self.assertFalse(i["receiver"]); self.assertEqual(i["mode"], 0); self.assertEqual(i["sats"], [])

    def test_devices_tpv_sky(self):
        for m in (DEVICES, TPV3, SKY_DOP, SKY_SATS):
            G.apply_msg(m, now=time.time())
        i = G.info()
        self.assertTrue(i["receiver"]); self.assertEqual(i["mode"], 3)
        self.assertEqual(i["devices"][0]["driver"], "u-blox"); self.assertEqual(i["devices"][0]["path"], "/dev/ttyACM0")
        self.assertEqual((i["nSat"], i["uSat"]), (3, 2)); self.assertEqual(len(i["sats"]), 3)
        self.assertEqual(i["sats"][1], {"prn": 7, "gnss": 0, "el": 30, "az": 310, "ss": 38.5, "used": True})
        self.assertEqual(i["dop"]["hdop"], 1.3)
        self.assertEqual(i["fix"]["track"], 91.5); self.assertEqual(i["fix"]["eph"], 4.2); self.assertEqual(i["fix"]["alt"], 243.9)
        self.assertEqual(G.current()["lat"], 48.14)

    def test_eph_from_epx_epy(self):
        t = {k: v for k, v in TPV3.items() if k != "eph"}
        G.apply_msg(t)
        self.assertEqual(G.current()["eph"], 5.0)

    def test_sky_dop_only_keeps_satellites(self):
        G.apply_msg(SKY_SATS); G.apply_msg(SKY_DOP)
        self.assertEqual(len(G.info()["sats"]), 3)

    def test_fix_loss_drops_position(self):
        G.apply_msg(DEVICES); G.apply_msg(TPV3); G.apply_msg(TPV1)
        c = G.current()
        self.assertEqual(c["mode"], 1); self.assertNotIn("lat", c); self.assertNotIn("speed", c)
        self.assertTrue(c["receiver"])

    def test_stale_fix_counts_as_lost(self):
        G.apply_msg(DEVICES); G.apply_msg(TPV3, now=1000.0)
        self.assertEqual(G.current(now=1002.0)["mode"], 3)
        c = G.current(now=1000.0 + G.STALE_S + 1)
        self.assertEqual(c["mode"], 1); self.assertTrue(c["stale"]); self.assertNotIn("lat", c)

    def test_unplug(self):
        for m in (DEVICES, TPV3, SKY_SATS):
            G.apply_msg(m)
        G.apply_msg({"class": "DEVICES", "devices": []})
        i = G.info()
        self.assertFalse(i["receiver"]); self.assertEqual(i["mode"], 0); self.assertEqual(i["sats"], [])

    def test_old_sky_expires(self):
        G.apply_msg(SKY_SATS, now=time.time() - 60)
        self.assertEqual(G.info()["sats"], [])


class FakeGpsdFlow(unittest.TestCase):
    """navd_gps.gps_loop against the fake gpsd: receiver, fix, satellites, tunnel (fix loss), unplug, replug."""
    @classmethod
    def setUpClass(cls):
        cls.fake = FakeGpsd(interval=0.1, speed=20.0).start()
        G.GPSD = ("127.0.0.1", cls.fake.port)
        G.reset()
        threading.Thread(target=G.gps_loop, daemon=True).start()

    @classmethod
    def tearDownClass(cls):
        cls.fake.stop()

    def wait(self, pred, what, timeout=8):
        end = time.time() + timeout
        while time.time() < end:
            i = G.info()
            if pred(i):
                return i
            time.sleep(0.05)
        self.fail("timeout waiting for " + what + ": " + str(G.info()))

    def test_sequence(self):
        self.fake.set("fix")
        i = self.wait(lambda i: i["mode"] == 3 and i["nSat"], "3D fix + satellites")
        self.assertEqual(i["devices"][0]["driver"], "u-blox")
        self.assertEqual((i["nSat"], i["uSat"]), (12, 8)); self.assertEqual(len(i["sats"]), 12)
        self.assertAlmostEqual(i["fix"]["speed"], 20.0); self.assertEqual(i["fix"]["eph"], 4.2)
        self.assertGreater(i["fix"]["lat"], 48.0 - 0.001)
        self.assertEqual(i["fix"]["track"], 0.0)
        self.assertEqual(i["dop"]["hdop"], 1.3)
        self.assertTrue(i["fix"]["time"].endswith("Z"))
        lat1 = i["fix"]["lat"]
        # tunnel: fix lost, receiver still there, the old position must not stay
        self.fake.set("loss")
        i = self.wait(lambda i: i["mode"] == 1 and i["uSat"] == 0, "fix loss")
        self.assertTrue(i["receiver"]); self.assertEqual(i["fix"], {}); self.assertNotIn("lat", G.current())
        # the car drove on: the fix comes back further along the road
        time.sleep(1.0)
        self.fake.set("fix")
        i = self.wait(lambda i: i["mode"] == 3, "fix back")
        self.assertGreater(i["fix"]["lat"], lat1 + 0.0001)
        # receiver pulled
        self.fake.set("unplugged")
        i = self.wait(lambda i: not i["receiver"], "receiver gone")
        self.assertEqual(i["mode"], 0); self.assertEqual(i["devices"], []); self.assertEqual(i["sats"], [])
        self.fake.set("fix")
        self.wait(lambda i: i["receiver"] and i["mode"] == 3, "receiver plugged in again")


@unittest.skipUnless(shutil.which("node"), "node not installed")
class DeadReckoning(unittest.TestCase):
    def test_node_unit(self):
        r = subprocess.run(["node", os.path.join(HERE, "test_deadreckon.js")], capture_output=True, text=True, timeout=60)
        self.assertEqual(r.returncode, 0, r.stdout + r.stderr)


if __name__ == "__main__":
    unittest.main()
