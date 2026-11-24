"""pi/migrate-legacy-name.sh on a fake root: an installation under the earlier name pi-nav moves to nav-pi."""
import os
import pathlib
import subprocess
import tempfile
import unittest

ROOT = pathlib.Path(__file__).resolve().parent.parent
SCRIPT = ROOT / "pi" / "migrate-legacy-name.sh"


class Migrate(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.r = pathlib.Path(self.tmp.name) / "root"
        self.bin = pathlib.Path(self.tmp.name) / "bin"
        self.bin.mkdir()
        self.calls = pathlib.Path(self.tmp.name) / "calls"
        for tool in ("systemctl", "docker", "udevadm"):   # record the calls, change nothing
            p = self.bin / tool
            p.write_text('#!/bin/sh\necho "%s $*" >> "%s"\n' % (tool, self.calls))
            p.chmod(0o755)

    def tearDown(self):
        self.tmp.cleanup()

    def put(self, rel, text="x"):
        p = self.r / rel
        p.parent.mkdir(parents=True, exist_ok=True)
        p.write_text(text)
        return p

    def run_it(self):
        env = dict(os.environ, MIGRATE_ROOT=str(self.r), MIGRATE_HOME="/home/nav",
                   PATH="%s:%s" % (self.bin, os.environ["PATH"]))
        return subprocess.run(["bash", str(SCRIPT), "nav"], env=env, capture_output=True, text=True, check=True)

    def test_nothing_to_do(self):
        self.r.mkdir()
        out = self.run_it()
        self.assertEqual(out.stdout, "")
        self.assertFalse(self.calls.exists())

    def test_moves_everything(self):
        self.put("opt/pi-nav/edition.json", '{"edition":"advanced"}')
        self.put("etc/pi-nav/session.env", "BROWSER=chromium")
        self.put("var/lib/pi-nav/apt/sources.list")
        self.put("boot/firmware/pi-nav/config.env")
        self.put("home/nav/.config/pi-nav-chromium/Default/Preferences", "{}")
        self.put("var/log/pi-nav-firstboot.log", "log")
        self.put("usr/local/lib/pi-nav/set-clock.sh")
        for u in ("pi-nav.service", "pi-nav-tiles.service", "pi-nav-valhalla.service"):
            self.put("etc/systemd/system/" + u)
        self.put("etc/systemd/system/pi-nav-valhalla.service.d/x.conf")
        wants = self.r / "etc/systemd/system/multi-user.target.wants"
        wants.mkdir(parents=True)
        (wants / "pi-nav.service").symlink_to("/etc/systemd/system/pi-nav.service")
        self.put("etc/polkit-1/rules.d/49-pi-nav-wifi.rules")
        self.put("etc/polkit-1/rules.d/10-other.rules")
        self.put("etc/udev/rules.d/90-pi-nav-backlight.rules")
        self.put("etc/sudoers.d/pi-nav-clock")
        self.put("etc/chromium/policies/managed/pi-nav.json")
        self.run_it()
        r = self.r
        self.assertEqual((r / "opt/nav-pi/edition.json").read_text(), '{"edition":"advanced"}')
        self.assertEqual((r / "etc/nav-pi/session.env").read_text(), "BROWSER=chromium")
        self.assertTrue((r / "var/lib/nav-pi/apt/sources.list").exists())
        self.assertTrue((r / "boot/firmware/nav-pi/config.env").exists())
        self.assertTrue((r / "home/nav/.config/nav-pi-chromium/Default/Preferences").exists())
        self.assertEqual((r / "var/log/nav-pi-firstboot.log").read_text(), "log")
        self.assertTrue((r / "etc/polkit-1/rules.d/10-other.rules").exists())   # not ours: untouched
        left = [str(p.relative_to(r)) for p in r.rglob("*") if "pi-nav" in p.name]
        self.assertEqual(left, [])
        calls = self.calls.read_text()
        for u in ("pi-nav.service", "pi-nav-tiles.service", "pi-nav-valhalla.service"):
            self.assertIn("systemctl disable --now " + u, calls)
        self.assertIn("docker rm -f pi-nav-valhalla", calls)
        self.assertIn("systemctl daemon-reload", calls)

    def test_never_overwrites(self):
        self.put("opt/pi-nav/edition.json", "old")
        self.put("opt/nav-pi/edition.json", "new")
        out = self.run_it()
        self.assertEqual((self.r / "opt/nav-pi/edition.json").read_text(), "new")
        self.assertEqual((self.r / "opt/pi-nav/edition.json").read_text(), "old")
        self.assertIn("keep", out.stdout)

    def test_idempotent(self):
        self.put("opt/pi-nav/edition.json")
        self.run_it()
        self.calls.unlink()
        self.assertEqual(self.run_it().stdout, "")


if __name__ == "__main__":
    unittest.main()
