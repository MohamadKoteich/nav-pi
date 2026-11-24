"""Backend tests for Settings > Pi health (features/system/navd_system.py health): fake /proc, cpufreq, thermal,
vcgencmd and systemctl. Nothing real is read. Run: python3 -m unittest discover tests"""
import importlib.util, os, shutil, stat, tempfile, unittest

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))


def script(path, body):
    open(path, "w").write("#!/bin/bash\n" + body + "\n")
    os.chmod(path, os.stat(path).st_mode | stat.S_IEXEC)


class Health(unittest.TestCase):
    def setUp(self):
        t = self.t = tempfile.mkdtemp()
        os.makedirs(os.path.join(t, "proc"))
        self.stat(1000, 800)
        open(os.path.join(t, "proc", "meminfo"), "w").write(
            "MemTotal:        8000000 kB\nMemFree:  1000 kB\nMemAvailable:    6000000 kB\nSwapTotal: 1000 kB\nSwapFree: 400 kB\n")
        open(os.path.join(t, "proc", "loadavg"), "w").write("0.50 0.40 0.30 1/200 999\n")
        open(os.path.join(t, "temp"), "w").write("56123\n")
        open(os.path.join(t, "freq"), "w").write("1800000\n")
        open(os.path.join(t, "uptime"), "w").write("3700.5 100\n")
        script(os.path.join(t, "vcgencmd"), 'echo "throttled=0x50005"')          # under-voltage now + since boot, throttled now + since boot
        script(os.path.join(t, "systemctl"), 'shift; for s in "$@"; do [ "$s" = gpsd ] && echo inactive || echo active; done')
        env = dict(NAV_DATA=t, PROC_DIR=os.path.join(t, "proc"), THERMAL_FILE=os.path.join(t, "temp"), CPUFREQ_FILE=os.path.join(t, "freq"),
                   UPTIME_FILE=os.path.join(t, "uptime"), NAV_VCGENCMD=os.path.join(t, "vcgencmd"), NAV_SYSTEMCTL=os.path.join(t, "systemctl"),
                   NAV_NO_SAMPLER="1")
        os.environ.update(env)
        spec = importlib.util.spec_from_file_location("navd_system_h", os.path.join(ROOT, "features", "system", "navd_system.py"))
        self.m = importlib.util.module_from_spec(spec); spec.loader.exec_module(self.m)

    def tearDown(self):
        shutil.rmtree(self.t)

    def stat(self, total_busy, idle):
        # cpu user nice system idle iowait ... ; total = busy + idle
        open(os.path.join(self.t, "proc", "stat"), "w").write("cpu  %d 0 0 %d 0 0 0 0 0 0\ncpu0 1 1 1 1\n" % (total_busy, idle))

    def test_values(self):
        d = self.m.health(None, {}, {})
        self.assertEqual(d["tempC"], 56.1)
        self.assertEqual(d["load"], [0.5, 0.4, 0.3])
        self.assertEqual(d["freqMHz"], 1800)
        self.assertEqual(d["mem"]["total"], 8000000 * 1024); self.assertEqual(d["mem"]["swapUsed"], 600 * 1024)
        self.assertEqual(d["uptime"], 3700)
        th = d["throttled"]
        self.assertTrue(th["undervolt"] and th["throttled"] and th["undervolt_was"] and th["throttled_was"])
        self.assertFalse(th["capped"] or th["templimit"])
        self.assertEqual(d["services"], {"nav-pi": "active", "nav-pi-tiles": "active", "nav-pi-valhalla": "active", "gpsd": "inactive"})

    def test_cpu_and_history(self):
        self.m.cpu_pct()                    # reference
        self.stat(1300, 900)                # +300 busy, +100 idle -> 75 % busy
        s = self.m._sample()
        self.assertEqual(s["cpu"], 75.0); self.assertEqual(s["temp"], 56.1); self.assertEqual(s["mem"], 25.0)
        with self.m._hlock:
            self.m._hist.extend([s] * (self.m.KEEP + 5)); del self.m._hist[:-self.m.KEEP]
        d = self.m.health(None, {}, {})
        self.assertEqual(len(d["history"]), self.m.KEEP); self.assertEqual(d["cpu"], 75.0)

    def test_not_a_pi(self):
        os.remove(os.path.join(self.t, "vcgencmd"))
        self.assertIsNone(self.m.throttled())
        open(os.path.join(self.t, "freq"), "w").write("")
        self.assertIsNone(self.m.health(None, {}, {})["freqMHz"])


if __name__ == "__main__":
    unittest.main()
