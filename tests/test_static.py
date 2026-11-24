"""Static checks that catch broken merges before a build reaches the Pi (2026-11-12: a lost '}' in nav.css
silently disabled every rule after it; the along/QR panels lost their layout)."""
import glob, os, re, subprocess, shutil, unittest

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
MARK = re.compile(r"^(<{7}|={7}|>{7})( |$)", re.M)


class Static(unittest.TestCase):
    def test_css_braces_balance(self):
        for f in glob.glob(os.path.join(ROOT, "features", "*", "*.css")):
            s = re.sub(r"/\*.*?\*/", "", open(f, encoding="utf-8").read(), flags=re.S)
            depth = 0
            for ch in s:
                depth += ch == "{"
                depth -= ch == "}"
                self.assertGreaterEqual(depth, 0, f + ": a '}' too many")
            self.assertEqual(depth, 0, f + ": a '{' is not closed")

    def test_no_merge_markers(self):
        for pat in ("features/*/*", "pi/*", "scripts/*", "tools/*.py", "tools/*.mjs", "docs/*.md", "editions/*", "hardware/*"):
            for f in glob.glob(os.path.join(ROOT, pat)):
                if os.path.isfile(f):
                    with open(f, encoding="utf-8", errors="replace") as fh:
                        self.assertIsNone(MARK.search(fh.read()), f + ": merge conflict marker")

    @unittest.skipUnless(shutil.which("node"), "node not installed")
    def test_js_parses(self):
        for f in glob.glob(os.path.join(ROOT, "features", "*", "*.js")):
            r = subprocess.run(["node", "--check", f], capture_output=True, text=True)
            self.assertEqual(r.returncode, 0, f + ": " + r.stderr[-400:])


if __name__ == "__main__":
    unittest.main()
