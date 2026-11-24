"""scripts/common.sh settings: NAVPI_CONFIG picks the file, any non-empty KEY=value on the command line wins."""
import os
import pathlib
import re
import subprocess
import tempfile
import unittest

ROOT = pathlib.Path(__file__).resolve().parent.parent


def settings(env, *names):
    script = ". scripts/common.sh; " + "; ".join('printf "%%s\\n" "$%s"' % n for n in names)
    base = {k: v for k, v in os.environ.items() if k not in ("REGION", "EDITION", "SSH_PUBKEY_FILE", "PI_HOSTNAME")}
    r = subprocess.run(["bash", "-c", script], cwd=ROOT, env=dict(base, **env), capture_output=True, text=True)
    if r.returncode:
        raise AssertionError(r.stdout + r.stderr)
    return r.stdout.split("\n")[:len(names)]


class Config(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.cfg = pathlib.Path(self.tmp.name) / "my.env"
        text = re.sub(r"(?m)^REGION=.*$", "REGION=testland", (ROOT / "config.env.example").read_text(), count=1)
        self.cfg.write_text(re.sub(r"(?m)^SSH_PUBKEY_FILE=.*$", "SSH_PUBKEY_FILE=/from/file", text, count=1))

    def tearDown(self):
        self.tmp.cleanup()

    def test_file_is_read(self):
        self.assertEqual(settings({"NAVPI_CONFIG": str(self.cfg)}, "REGION", "SSH_PUBKEY_FILE"), ["testland", "/from/file"])

    def test_command_line_wins(self):
        got = settings({"NAVPI_CONFIG": str(self.cfg), "REGION": "other", "SSH_PUBKEY_FILE": "none", "EDITION": "basic"},
                       "REGION", "SSH_PUBKEY_FILE", "EDITION", "PI_HOSTNAME")
        self.assertEqual(got, ["other", "none", "basic", "nav-pi"])

    def test_empty_value_does_not_win(self):
        self.assertEqual(settings({"NAVPI_CONFIG": str(self.cfg), "REGION": ""}, "REGION"), ["testland"])

    def test_missing_config_file_stops(self):
        r = subprocess.run(["bash", "-c", ". scripts/common.sh"], cwd=ROOT, capture_output=True, text=True,
                           env=dict(os.environ, NAVPI_CONFIG="/nonexistent.env"))
        self.assertNotEqual(r.returncode, 0)
        self.assertIn("not found", r.stdout)


if __name__ == "__main__":
    unittest.main()
