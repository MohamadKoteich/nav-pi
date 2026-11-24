"""GPS -> system clock (features/gps/navd_gps.py sync_clock) + the root helper pi/set-clock.sh. No root, no Pi:
helper and timedatectl are faked. Run: python3 -m unittest tests/test_gpsclock.py -v"""
import importlib.util, os, subprocess, sys, tempfile, threading, time, unittest  # noqa: E401

HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, HERE)
from fake_gpsd import FakeGpsd  # noqa: E402

spec = importlib.util.spec_from_file_location("navd_gps_c", os.path.join(HERE, "..", "features", "gps", "navd_gps.py"))
G = importlib.util.module_from_spec(spec)
spec.loader.exec_module(G)
NOW = 1795000000.0   # 2026-11-17
ISO = lambda t: time.strftime("%Y-%m-%dT%H:%M:%S", time.gmtime(t)) + ".000Z"  # noqa: E731


def tpv(t, mode=3):
    return {"class": "TPV", "mode": mode, "time": ISO(t)}


class Rule(unittest.TestCase):
    def setUp(self):
        G.clock_state.update(last=0.0, set=None, last_rc=None)
        self.calls = []
        self.h = lambda *a: (self.calls.append(a), 0)[1]

    def go(self, msg, now=NOW, synced=False):
        return G.sync_clock(msg, now=now, synced=lambda: synced, helper=self.h)

    def test_stale_clock_is_stepped(self):
        self.assertEqual(self.go(tpv(NOW + 5 * 86400)), "set")
        self.assertEqual(self.calls, [("set", str(int(NOW + 5 * 86400)))])

    def test_within_tolerance_only_saves(self):
        self.assertEqual(self.go(tpv(NOW + 1)), "saved"); self.assertEqual(self.calls, [("save",)])

    def test_ntp_synced_never_touches(self):
        self.assertIsNone(self.go(tpv(NOW + 99999), synced=True)); self.assertEqual(self.calls, [])

    def test_no_fix_no_time_or_junk_time(self):
        self.assertIsNone(self.go(tpv(NOW + 99999, mode=1)))
        self.assertIsNone(self.go({"class": "TPV", "mode": 3}))
        self.assertIsNone(self.go({"class": "TPV", "mode": 3, "time": "garbage"}))
        self.assertIsNone(self.go(tpv(G.CLOCK_FLOOR - 86400 * 400)))   # 2025: week-rollover junk
        self.assertEqual(self.calls, [])

    def test_backwards_needs_3d(self):
        self.assertIsNone(self.go(tpv(NOW - 3600, mode=2))); self.assertEqual(self.calls, [])
        self.assertEqual(self.go(tpv(NOW - 3600, mode=3)), "set")

    def test_rate_limit_10_min(self):
        self.assertEqual(self.go(tpv(NOW + 100)), "set")
        self.assertIsNone(self.go(tpv(NOW + 700), now=NOW + 300))
        self.assertEqual(self.go(tpv(NOW + 700), now=NOW + 601), "set")
        self.assertEqual(len(self.calls), 2)

    def test_helper_failure_reported_not_raised(self):
        self.h = lambda *a: 1
        self.assertIsNone(self.go(tpv(NOW + 100))); self.assertEqual(G.clock_state["last_rc"], 1)

    def test_ntp_probe_uses_timedatectl(self):
        with tempfile.TemporaryDirectory() as d:
            p = os.path.join(d, "timedatectl")
            open(p, "w").write("#!/bin/sh\necho yes\n"); os.chmod(p, 0o755)
            old = os.environ["PATH"]; os.environ["PATH"] = d + os.pathsep + old
            try:
                self.assertTrue(G.ntp_synced())
                open(p, "w").write("#!/bin/sh\necho no\n")
                self.assertFalse(G.ntp_synced())
            finally:
                os.environ["PATH"] = old


class WithFakeGpsd(unittest.TestCase):
    def test_loop_sets_clock_from_fake_gpsd(self):
        got = []
        G.clock_state.update(last=0.0, set=None, last_rc=None)
        g = FakeGpsd(interval=0.1); g.start()
        old = (G.GPSD, G.ntp_synced, G.run_helper, G.CLOCK_FLOOR)
        G.GPSD = ("127.0.0.1", g.port); G.ntp_synced = lambda: False
        G.run_helper = lambda *a: (got.append(a), 0)[0]
        G.CLOCK_FLOOR = 0   # the fake drive uses the real current time
        # the fake's TPV time = now, the clock "is" now: make the helper see a step by shifting time.time for sync_clock
        real = time.time
        G.time = type("T", (), {"time": staticmethod(lambda: real() - 86400), "strptime": time.strptime, "sleep": time.sleep})
        t = threading.Thread(target=G.gps_loop, daemon=True); t.start()
        try:
            end = real() + 5
            while not got and real() < end:
                time.sleep(0.1)
        finally:
            G.time = time; G.GPSD, G.ntp_synced, G.run_helper, G.CLOCK_FLOOR = old; g.stop()
        self.assertTrue(got and got[0][0] == "set", got)


class QuietNavd(unittest.TestCase):
    def test_dropped_client_is_silent(self):
        import io, contextlib
        sp = importlib.util.spec_from_file_location("navd_q", os.path.join(HERE, "..", "features", "core", "navd.py"))
        N = importlib.util.module_from_spec(sp); sp.loader.exec_module(N)
        srv = N.QuietServer.__new__(N.QuietServer)
        err = io.StringIO()
        with contextlib.redirect_stderr(err):
            for exc in (BrokenPipeError, ConnectionResetError):
                try:
                    raise exc()
                except exc:
                    srv.handle_error(None, ("127.0.0.1", 1))
        self.assertEqual(err.getvalue(), "")


class Helper(unittest.TestCase):
    SH = os.path.join(HERE, "..", "pi", "set-clock.sh")

    def run_sh(self, *a):
        return subprocess.run(["bash", self.SH, *a], capture_output=True, text=True).returncode

    def test_refuses_bad_input_without_touching_the_clock(self):
        self.assertEqual(self.run_sh("set", "abc"), 2)
        self.assertEqual(self.run_sh("set", "1700000000"), 2)       # before the floor
        self.assertEqual(self.run_sh("set", "9999999999"), 2)       # absurdly far ahead
        self.assertEqual(self.run_sh("nonsense"), 2)
        self.assertEqual(self.run_sh(), 2)


if __name__ == "__main__":
    unittest.main()
