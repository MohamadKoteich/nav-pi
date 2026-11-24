"""Tests for features/wifi/navd_wifi.py. Run: python3 -m unittest tests/test_wifi.py -v  (no Pi, no NetworkManager needed)"""
import importlib.util, os, tempfile, time, unittest  # noqa: E401

HERE = os.path.dirname(os.path.abspath(__file__))
os.environ["NMCLI"] = os.path.join(HERE, "fake-nmcli")
spec = importlib.util.spec_from_file_location("navd_wifi", os.path.join(HERE, "..", "features", "wifi", "navd_wifi.py"))
W = importlib.util.module_from_spec(spec)
spec.loader.exec_module(W)

# recorded `nmcli -t -f IN-USE,SSID,SIGNAL,SECURITY dev wifi list` (nmcli 1.52), SSIDs with escaped colons/backslash
RECORDED = r""" :Caf\:e\: Free:55:--
*:Home 5G:82:WPA2
 :Home 5G:40:WPA2
 :Back\\slash:30:WPA1 WPA2
 ::30:WPA2
 :Corp:38:WPA2 802.1X
 :Pixel hotspot:64:WPA2 WPA3
"""


class Parse(unittest.TestCase):
    def test_split_terse(self):
        self.assertEqual(W.split_terse(r"a\:b:c\\d:e"), ["a:b", "c\\d", "e"])
        self.assertEqual(W.split_terse("::"), ["", "", ""])
        self.assertEqual(W.split_terse(r"x\\:y"), ["x\\", "y"])   # escaped backslash, then a real separator

    def test_wifi_list(self):
        n = W.parse_wifi_list(RECORDED)
        self.assertEqual([x["ssid"] for x in n], ["Home 5G", "Pixel hotspot", "Caf:e: Free", "Corp", "Back\\slash"])
        self.assertTrue(n[0]["inuse"] and n[0]["signal"] == 82)          # duplicates: in-use / strongest kept, hidden dropped
        self.assertFalse(n[2]["secure"])
        self.assertTrue(n[3]["enterprise"] and n[3]["secure"])
        self.assertEqual(n[4]["security"], "WPA1 WPA2")

    def test_saved(self):
        out = "Home\\:5G:11111111-1111-1111-1111-111111111111:802-11-wireless\neth:22222222-2222-2222-2222-222222222222:802-3-ethernet\n"
        self.assertEqual(W.parse_saved(out), [{"name": "Home:5G", "uuid": "11111111-1111-1111-1111-111111111111"}])


class Flow(unittest.TestCase):
    def setUp(self):
        self.sp = tempfile.mktemp(suffix=".json")
        os.environ["FAKE_NM_STATE"] = self.sp
        W.job = {"state": "idle", "ssid": "", "error": ""}

    def tearDown(self):
        for f in (self.sp, self.sp + ".calls"):
            if os.path.exists(f):
                os.unlink(f)

    def wait(self):
        for _ in range(100):
            if W.job["state"] != "connecting":
                return
            time.sleep(0.05)
        self.fail("job stuck")

    def calls(self):
        return open(self.sp + ".calls").read()

    def test_state(self):
        st = W.state()
        self.assertTrue(st["present"] and st["enabled"])
        self.assertEqual((st["ssid"], st["ip"]), ("Home 5G", "192.168.1.23"))
        self.assertEqual(st["networks"][0]["uuid"], "11111111-1111-1111-1111-111111111111")
        self.assertEqual([s["name"] for s in st["saved"]], ["Old Cafe"])   # remembered but out of range; the Wired profile is not Wi-Fi

    def test_absent(self):
        os.environ["NMCLI"] = "/nonexistent/nmcli"
        W.NMCLI = "/nonexistent/nmcli"
        try:
            self.assertEqual(W.state(), {"present": False})
        finally:
            W.NMCLI = os.path.join(HERE, "fake-nmcli")

    def test_power_off(self):
        W.action("power", {"on": False})
        st = W.state()
        self.assertFalse(st["enabled"])
        self.assertEqual(st["networks"], [])

    def test_connect_secret_not_in_argv_and_wrong_password_cleans_profile(self):
        self.assertEqual(W.action("connect", {"ssid": "Pixel hotspot", "password": "wrongwrong"})[1], 200)
        self.wait()
        self.assertEqual((W.job["state"], W.job["error"]), ("failed", "secrets"))
        self.assertNotIn("Pixel hotspot", [p["name"] for p in __import__("json").load(open(self.sp))["profiles"]])   # half-made profile dropped
        self.assertEqual(W.action("connect", {"ssid": "Pixel hotspot", "password": "correctpw1"})[1], 200)
        self.wait()
        self.assertEqual(W.job["state"], "done")
        self.assertEqual(W.state()["ssid"], "Pixel hotspot")
        self.assertNotIn("correctpw1", self.calls())      # password never on the command line
        self.assertNotIn("wrongwrong", self.calls())

    def test_connect_saved_by_uuid_and_forget(self):
        W.action("connect", {"ssid": "Old Cafe", "uuid": "22222222-2222-2222-2222-222222222222"})
        self.wait()
        self.assertEqual(W.job["state"], "done")
        self.assertEqual(W.action("forget", {"uuid": "33333333-3333-3333-3333-333333333333"})[1], 400)   # ethernet profile: refused
        self.assertEqual(W.action("forget", {"uuid": "22222222-2222-2222-2222-222222222222"})[1], 200)
        self.assertEqual(W.state()["saved"], [])

    def test_validation(self):
        bad = [{"ssid": ""}, {"ssid": "x" * 33}, {"ssid": "a\nb"}, {"ssid": "-evil"}, {"ssid": "ok", "password": "short"},
               {"ssid": "ok", "password": "line\nbreak1"}, {"ssid": "ok", "uuid": "not-a-uuid"}, {"ssid": 5}]
        for j in bad:
            self.assertEqual(W.action("connect", j)[1], 400, j)
        self.assertEqual(W.action("forget", {"uuid": "../../etc"})[1], 400)
        self.assertEqual(W.action("forget", {})[1], 400)

    def test_ssid_is_one_argument(self):   # shell metacharacters stay data
        W.action("connect", {"ssid": "x; rm -rf / $(id) `id`"})
        self.wait()
        self.assertIn("connect x; rm -rf / $(id) `id`", self.calls())
        self.assertEqual(W.job["state"], "failed")


if __name__ == "__main__":
    unittest.main()
