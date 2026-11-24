"""Backend tests for features/display (brightness) and features/system with fake sysfs dirs. Run: python3 -m unittest discover tests"""
import importlib.util, json, os, shutil, tempfile, time, unittest

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))


def load(feat, **env):
    os.environ.update(env)
    spec = importlib.util.spec_from_file_location("navd_" + feat, os.path.join(ROOT, "features", feat, "navd_%s.py" % feat))
    m = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(m)
    return m


class Display(unittest.TestCase):
    def setUp(self):
        self.t = tempfile.mkdtemp()
        self.bl = os.path.join(self.t, "bl", "panel")
        os.makedirs(self.bl)
        self.put("max_brightness", 31)
        self.put("brightness", 15)
        self.d = load("display", NAV_DATA=self.t, BACKLIGHT_DIR=os.path.join(self.t, "bl"))

    def tearDown(self):
        shutil.rmtree(self.t)

    def put(self, n, v):
        open(os.path.join(self.bl, n), "w").write(str(v) + "\n")

    def raw(self):
        return int(open(os.path.join(self.bl, "brightness")).read())

    def test_state_and_clamp(self):
        s = self.d.brightness_state()
        self.assertTrue(s["available"]); self.assertEqual(s["level"], 48)
        self.assertTrue(self.d.brightness_set({"level": 0}))       # never black
        self.assertEqual(self.raw(), 2)
        self.d.brightness_set({"level": 500}); self.assertEqual(self.raw(), 31)
        self.d.brightness_set({"level": -5}); self.assertGreaterEqual(self.raw(), 1)

    def test_night_dim(self):
        self.d.brightness_set({"level": 100})
        self.d.brightness_set({"dim": True})
        self.assertEqual(self.raw(), 31)                            # day: unchanged
        self.d.brightness_set({"night": True})
        self.assertEqual(self.raw(), 9)                             # 30 % of 31
        self.d.brightness_set({"level": 50})                        # slider edits the night slot
        self.assertEqual(self.raw(), 16)
        self.d.brightness_set({"night": False}); self.assertEqual(self.raw(), 31)
        self.d.brightness_set({"night": True, "dim": False}); self.assertEqual(self.raw(), 31)
        st = json.load(open(os.path.join(self.t, "brightness.json")))
        self.assertEqual((st["day"], st["night"]), (100, 50))

    def test_boot_apply(self):
        self.d.brightness_set({"level": 40}); self.put("brightness", 31)
        self.d.BOOT_DELAY = 0
        self.d._boot_apply(); self.assertEqual(self.raw(), 12)

    def test_no_backlight(self):
        d = load("display", NAV_DATA=self.t, BACKLIGHT_DIR=os.path.join(self.t, "none"))
        self.assertEqual(d.brightness_state(), {"available": False})
        self.assertFalse(d.brightness_set({"level": 50}))
        self.assertEqual(d.post_display(None, {}, {"level": 50})[1], 409)
        self.assertEqual(d.display_state()["brightness"], {"available": False})

    def test_bad_input(self):
        self.assertEqual(self.d.post_display(None, {}, {"level": "abc"})[1], 400)
        self.assertEqual(self.d.post_display(None, {}, {"rotation": "7"})[1], 400)


class System(unittest.TestCase):
    def setUp(self):
        self.t = tempfile.mkdtemp()
        for part, txt in (("map", "region=germany bbox=1 maxzoom=15\nbuilt=2026-11-11T13:49:46+01:00\n  planetiler:osm:osmosisreplicationtime 2026-09-10T04:00:00Z\n"),
                          ("search", "region=germany built=2026-11-11T15:14:17+01:00\ncounts={\"a\": 1}\n"),
                          ("valhalla", "region=germany\nbuilt=2026-11-11T15:45:35+01:00\n")):
            os.makedirs(os.path.join(self.t, "germany", part)); open(os.path.join(self.t, "germany", part, "BUILD-INFO"), "w").write(txt)
        os.symlink("germany", os.path.join(self.t, "current"))   # 21-push-data.sh: the region the Pi serves
        open(os.path.join(self.t, "temp"), "w").write("47250\n"); open(os.path.join(self.t, "up"), "w").write("3700.5 100\n")
        open(os.path.join(self.t, "ed.json"), "w").write(json.dumps({"name": "Basic", "source": "abc1234", "built": "2026-11-11T18:02:23", "hardware": "x"}))
        self.log = os.path.join(self.t, "ctl.log")
        with open(os.path.join(self.t, "fakectl"), "w") as f:   # closed before exec (else ETXTBSY)
            f.write("#!/bin/sh\necho \"$@\" >> %s\n" % self.log)
        os.chmod(os.path.join(self.t, "fakectl"), 0o755)
        self.s = load("system", NAV_DATA=self.t, THERMAL_FILE=os.path.join(self.t, "temp"), UPTIME_FILE=os.path.join(self.t, "up"),
                      EDITION_FILE=os.path.join(self.t, "ed.json"), NAV_SYSTEMCTL=os.path.join(self.t, "fakectl"))

    def tearDown(self):
        shutil.rmtree(self.t)

    def test_info(self):
        i = self.s.info(None, {}, {})
        self.assertEqual(i["tempC"], 47.2); self.assertEqual(i["uptime"], 3700)
        self.assertEqual(i["data"]["map"], {"built": "2026-11-11", "osm": "2026-09-10"})
        self.assertEqual(i["data"]["routes"]["built"], "2026-11-11"); self.assertEqual(i["data"]["search"]["built"], "2026-11-11")
        self.assertEqual(i["app"]["source"], "abc1234"); self.assertEqual(i["app"]["built"], "2026-11-11 18:02")
        self.assertGreater(i["disk"]["total"], 0)

    def test_info_degrades(self):
        s = load("system", NAV_DATA=os.path.join(self.t, "nope"), THERMAL_FILE="/nonexistent", UPTIME_FILE="/nonexistent", EDITION_FILE="/nonexistent")
        i = s.info(None, {}, {})
        self.assertIsNone(i["tempC"]); self.assertIsNone(i["uptime"]); self.assertEqual(i["data"], {}); self.assertEqual(i["app"]["source"], "")

    def test_power(self):
        self.assertEqual(self.s.power(None, {}, {"action": "rm -rf"})[1], 400)
        self.s.REPLY_DELAY = 0
        self.assertTrue(self.s.power(None, {}, {"action": "reboot"})["ok"])
        for _ in range(50):
            if os.path.exists(self.log):
                break
            time.sleep(0.1)
        self.assertEqual(open(self.log).read().strip(), "reboot")


class Region(unittest.TestCase):
    """navd core: region from NAV_REGION / the /srv/navdata/current link / europe; view from map/BUILD-INFO"""
    def setUp(self):
        self.t = tempfile.mkdtemp()
        self.env = {k: os.environ.get(k) for k in ("NAV_DATA", "NAV_REGION")}
        os.environ.pop("NAV_REGION", None)
        for r, bbox in (("europe", "-32,32,47,79"), ("germany", "5.5,47.0,15.5,55.2")):
            os.makedirs(os.path.join(self.t, r, "map"))
            open(os.path.join(self.t, r, "map", "BUILD-INFO"), "w").write("region=%s bbox=%s maxzoom=15\n" % (r, bbox))
        spec = importlib.util.spec_from_file_location("navd_core", os.path.join(ROOT, "features", "core", "navd.py"))
        os.environ["NAV_DATA"] = self.t
        self.core = importlib.util.module_from_spec(spec); spec.loader.exec_module(self.core)

    def tearDown(self):
        shutil.rmtree(self.t)
        for k, v in self.env.items():
            os.environ.pop(k, None) if v is None else os.environ.__setitem__(k, v)

    def test_region(self):
        self.assertEqual(self.core.region(), "europe")                     # no link: the default
        os.symlink("germany", os.path.join(self.t, "current"))
        self.assertEqual(self.core.region(), "germany")                    # the link wins over the default
        os.environ["NAV_REGION"] = "europe"
        self.assertEqual(self.core.region(), "europe")                     # an explicit setting wins

    def test_view(self):
        v = self.core.region_view("europe")
        self.assertEqual(v["center"], [7.5, 55.5]); self.assertAlmostEqual(v["zoom"], 3.0, places=1)
        g = self.core.region_view("germany")
        self.assertEqual(g["center"], [10.5, 51.1]); self.assertTrue(5.5 < g["zoom"] < 6.5)
        self.assertIsNone(self.core.region_view("nowhere"))

    def test_edition_js(self):
        os.environ["NAV_REGION"] = "germany"
        got = {}
        class H:
            def send_bytes(self, b, ctype): got["b"], got["t"] = b, ctype
        self.core.edition_js(H(), {}, {})
        ed = json.loads(got["b"].decode().split("=", 1)[1].strip().rstrip(";"))
        self.assertEqual(ed["region"], "germany"); self.assertEqual(ed["regionView"]["bbox"], [5.5, 47.0, 15.5, 55.2])
        self.assertEqual(got["t"], "application/javascript")


if __name__ == "__main__":
    unittest.main()
