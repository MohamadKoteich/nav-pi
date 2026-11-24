"""Backend tests for map / app / OS updates (features/system/navd_system_updates.py) in temp dirs with fake services.
Run: python3 -m unittest tests/test_updates.py"""
import importlib, json, os, shutil, subprocess, sys, tempfile, time, unittest

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
sys.path[:0] = [os.path.join(ROOT, "features", "system"), os.path.join(ROOT, "tools")]
import make_update_manifest as mk  # noqa: E402


def write(p, data=b"x"):
    os.makedirs(os.path.dirname(p), exist_ok=True)
    open(p, "wb").write(data if isinstance(data, bytes) else data.encode())


def make_region_src(d, region, osm, size=3000):
    write(d + "/map/%s.pmtiles" % region, os.urandom(size))
    write(d + "/map/BUILD-INFO", "region=%s bbox=5,47,15,55 maxzoom=15\nbuilt=%sT10:00:00+01:00\n  planetiler:osm:osmosisreplicationtime %sT04:00:00Z\n" % (region, osm, osm))
    write(d + "/search/places.sqlite", os.urandom(size // 2))
    write(d + "/search/BUILD-INFO", "region=%s\n" % region)
    write(d + "/valhalla/valhalla_tiles.tar", os.urandom(size * 2))
    write(d + "/valhalla/valhalla.json", "{}")
    write(d + "/valhalla/BUILD-INFO", "tar_sha256=0\n")
    write(d + "/valhalla/germany-latest.osm.pbf", b"not shipped")


def make_installed(data, name, osm, size=3000):
    """a region folder as the Pi has it: folder = pmtiles name"""
    base = name.split("-")[0]
    make_region_src(os.path.join(data, name), base, osm, size)
    os.rename(os.path.join(data, name, "map", base + ".pmtiles"), os.path.join(data, name, "map", name + ".pmtiles"))


class Base(unittest.TestCase):
    def setUp(self):
        self.t = tempfile.mkdtemp()
        self.data, self.stick = self.t + "/navdata", self.t + "/stick"
        os.makedirs(self.data)
        os.makedirs(self.stick)
        os.environ.update(NAV_DATA=self.data, NAV_UPDATE_DIRS=self.stick, NAV_STATE_DIR=self.t + "/state", NAV_SYSTEMCTL="/bin/false",
                          NAV_REBOOT_FILE=self.t + "/no-reboot", EDITION_FILE=self.t + "/edition.json", NAV_PORT="1")
        import navd_system_updates
        self.u = importlib.reload(navd_system_updates)
        self.calls, self.speed, self.svc_ok = [], None, True
        self.u.svc = lambda action, units, block=True: (self.calls.append((action, list(units))), self.svc_ok)[1]
        self.u.speed_mps = lambda: self.speed
        self.u.usb_mounts = lambda: []
        self.u.RESERVE = 1000

    def tearDown(self):
        shutil.rmtree(self.t)

    def map_bundle(self, region="germany", osm="2026-12-01", size=3000, sub="navpi-map"):
        src = self.t + "/src-" + region
        shutil.rmtree(src, ignore_errors=True)
        make_region_src(src, region, osm, size)
        files, meta = mk.plan_map(src, region)
        out = os.path.join(self.stick, sub)
        shutil.rmtree(out, ignore_errors=True)
        return mk.pack(src, files, meta, out), out

    def wait(self, states=("ready", "done", "failed", "cancelled"), t=10):
        end = time.time() + t
        while time.time() < end:
            if self.u.job.get("state") in states:
                return self.u.job["state"]
            time.sleep(0.02)
        self.fail("job stuck: %s" % self.u.job)

    def start(self, **kw):
        sc = self.u.scan()
        b = sc["bundles"][0]
        return self.u.start({"id": b["id"], **kw}), b


class Manifest(Base):
    def test_bundle_pack_scan_and_compare(self):
        make_installed(self.data, "germany-20260910", "2026-09-10")
        os.symlink("germany-20260910", self.data + "/current")
        m, out = self.map_bundle(osm="2026-12-01")
        self.assertEqual(len(m["files"]), 7)                       # the .osm.pbf is not shipped
        self.assertNotIn("germany-latest.osm.pbf", [f["path"] for f in m["files"]])
        sc = self.u.scan()
        self.assertEqual(len(sc["bundles"]), 1)
        b = sc["bundles"][0]
        self.assertEqual((b["region"], b["osm"], b["state"]), ("germany", "2026-12-01", "new"))
        self.assertEqual(b["current"]["osm"], "2026-09-10")
        self.assertEqual(b["plan"]["fits"], "side")
        self.assertNotIn("source", b)                              # internals never leave the process

    def test_same_and_older(self):
        make_installed(self.data, "germany-20260910", "2026-09-10")
        os.symlink("germany-20260910", self.data + "/current")
        self.map_bundle(osm="2026-09-10")
        self.assertEqual(self.u.scan()["bundles"][0]["state"], "same")
        self.map_bundle(osm="2026-01-01")
        self.assertEqual(self.u.scan()["bundles"][0]["state"], "older")

    def test_hostile_manifests_refused(self):
        m, out = self.map_bundle()
        good = json.load(open(out + "/manifest.json"))
        for mut in (lambda m: m["files"].append({"path": "../etc/passwd", "size": 1, "sha256": "0" * 64}),
                    lambda m: m["files"].append({"path": "/etc/passwd", "size": 1, "sha256": "0" * 64}),
                    lambda m: m["files"].append({"path": "map/../x", "size": 1, "sha256": "0" * 64}),
                    lambda m: m["files"].append({"path": "boot/kernel", "size": 1, "sha256": "0" * 64}),
                    lambda m: m.update(region="current"), lambda m: m.update(region="../x"),
                    lambda m: m["files"].__setitem__(0, {**m["files"][0], "sha256": "xyz"}),
                    lambda m: m.update(files=[f for f in m["files"] if f["path"] != "search/places.sqlite"]),
                    lambda m: m.update(navpi_update=2)):
            m = json.loads(json.dumps(good))
            mut(m)
            with self.assertRaises(self.u.UpdateError):
                self.u.parse_manifest(m)

    def test_bad_url(self):
        for bad in ("ftp://x/y", "file:///etc", "javascript:1", "x"):
            with self.assertRaises(self.u.UpdateError):
                self.u.scan(bad)


class MapFlow(Base):
    def setUp(self):
        super().setUp()
        make_installed(self.data, "germany-20260910", "2026-09-10", 6000)
        os.symlink("germany-20260910", self.data + "/current")

    def test_copy_verify_switch_rollback(self):
        m, out = self.map_bundle(osm="2026-12-01")
        self.start()[0]
        self.assertEqual(self.wait(), "ready")
        new = "germany-20261201"
        self.assertEqual(self.u.job["target"], new)
        # pmtiles renamed to the folder name (tiles are served as /tiles/<folder>/), all files verified, nothing left over
        self.assertTrue(os.path.isfile("%s/%s/map/%s.pmtiles" % (self.data, new, new)))
        self.assertTrue(os.path.isfile("%s/%s/valhalla/valhalla_tiles.tar" % (self.data, new)))
        self.assertFalse(any(n.startswith(".incoming") for n in os.listdir(self.data)))
        self.assertEqual(os.path.basename(os.path.realpath(self.data + "/current")), "germany-20260910")   # not switched yet
        self.assertEqual(self.calls, [])
        self.u.switch({})
        self.assertEqual(os.path.basename(os.path.realpath(self.data + "/current")), new)
        self.assertTrue(os.path.islink(self.data + "/current"))
        self.assertEqual(self.calls[0], ("restart", ["nav-pi-tiles", "nav-pi-valhalla"]))
        st = self.u.state()
        self.assertEqual((st["current"], st["previous"]), (new, "germany-20260910"))
        # roll back: old folder is still there; rolling back again goes forward
        self.u.rollback({})
        self.assertEqual(self.u.current_name(), "germany-20260910")
        self.assertEqual(self.u.state()["previous"], new)
        self.u.rollback({})
        self.assertEqual(self.u.current_name(), new)
        # delete: never the current one, never a reserved or unknown name
        for bad in (new, "current", "updates", "../x", "nope"):
            with self.assertRaises(self.u.UpdateError):
                self.u.delete_region({"name": bad})
        self.u.delete_region({"name": "germany-20260910"})
        self.assertFalse(os.path.exists(self.data + "/germany-20260910"))
        with self.assertRaises(self.u.UpdateError):
            self.u.rollback({})

    def test_bad_sha_refused_and_cleaned(self):
        m, out = self.map_bundle()
        with open(out + "/search/places.sqlite", "r+b") as f:   # a flipped byte on the stick
            f.write(b"\xff")
        self.start()
        self.assertEqual(self.wait(), "failed")
        self.assertEqual(self.u.job["error"], "sha256")
        self.assertEqual(sorted(os.listdir(self.data)), ["current", "germany-20260910"])   # nothing half-installed
        self.assertEqual(self.u.current_name(), "germany-20260910")

    def test_not_enough_space_refused_before_copying(self):
        m, out = self.map_bundle()
        self.u.free_bytes = lambda: 100            # card full
        sc = self.u.scan()["bundles"][0]
        self.assertEqual(sc["plan"]["fits"], "replace")                       # old region (~15 KB) would make room
        self.assertGreater(sc["plan"]["need"], sc["plan"]["free"])
        with self.assertRaises(self.u.UpdateError) as e:
            self.u.start({"id": sc["id"]})                                    # side-by-side refused
        self.assertEqual(e.exception.code, "space")
        with self.assertRaises(self.u.UpdateError) as e:
            self.u.start({"id": sc["id"], "mode": "replace"})                 # replace needs the explicit confirm
        self.assertEqual(e.exception.code, "confirm")
        self.assertEqual(self.u.job.get("state", "idle"), "idle")
        self.assertTrue(os.path.isdir(self.data + "/germany-20260910"))       # nothing touched
        self.u.free_bytes = lambda: 0
        self.u.region_dirs = lambda: []
        self.assertEqual(self.u.scan()["bundles"][0]["plan"]["fits"], "none")

    def test_replace_in_place_with_warning(self):
        m, out = self.map_bundle(osm="2026-12-01")
        free = {"v": 100}

        def fake_free():
            return free["v"] if os.path.isdir(self.data + "/germany-20260910") else 10 ** 9   # space appears once the old map is gone
        self.u.free_bytes = fake_free
        sc = self.u.scan()["bundles"][0]
        self.assertEqual(sc["plan"]["fits"], "replace")
        self.u.start({"id": sc["id"], "mode": "replace", "confirm": True})
        self.assertEqual(self.wait(), "done")
        self.assertEqual(self.calls[0], ("stop", ["nav-pi-tiles", "nav-pi-valhalla"]))      # files must not stay open
        self.assertFalse(os.path.exists(self.data + "/germany-20260910"))
        self.assertEqual(self.u.current_name(), "germany-20261201")
        self.assertEqual(self.u.state()["previous"], "")                                     # no roll-back possible
        self.assertIn(("restart", ["nav-pi-tiles", "nav-pi-valhalla"]), self.calls)

    def test_never_while_driving(self):
        self.map_bundle()
        sc = self.u.scan()["bundles"][0]
        self.speed = 13.0
        with self.assertRaises(self.u.UpdateError) as e:
            self.u.start({"id": sc["id"]})
        self.assertEqual(e.exception.code, "driving")
        self.speed = 0.2                                                                      # GPS jitter at a standstill is fine
        with self.assertRaises(self.u.UpdateError) as e:
            self.u.start({"id": sc["id"], "guiding": True})                                   # guidance active in the app
        self.assertEqual(e.exception.code, "driving")
        self.u.start({"id": sc["id"]})
        self.assertEqual(self.wait(), "ready")
        self.speed = 5.0
        for fn in (self.u.switch, self.u.rollback, self.u.os_start, self.u.apply_app):
            with self.assertRaises(self.u.UpdateError) as e:
                fn({})
            self.assertEqual(e.exception.code, "driving")
        self.assertEqual(self.u.current_name(), "germany-20260910")
        self.assertEqual(self.calls, [])

    def test_service_failure_reverts_the_link(self):
        self.map_bundle()
        self.start()
        self.wait()
        self.svc_ok = False
        with self.assertRaises(self.u.UpdateError) as e:
            self.u.switch({})
        self.assertEqual(e.exception.code, "service")
        self.assertEqual(self.u.current_name(), "germany-20260910")

    def test_cancel(self):
        self.map_bundle(size=3000)
        self.u.CHUNK = 100
        orig = self.u._set

        def slow(**kw):
            orig(**kw)
            time.sleep(0.002)
        self.u._set = slow
        self.start()
        self.u.cancel_job({})
        self.assertEqual(self.wait(), "cancelled")
        self.assertFalse(any(n.startswith(".incoming") for n in os.listdir(self.data)))

    def test_second_update_same_osm_date_gets_new_folder(self):
        self.map_bundle(osm="2026-12-01")
        self.start()
        self.wait()
        self.u.switch({})
        self.u.job.clear()
        self.start()
        self.assertEqual(self.wait(), "ready")
        self.assertEqual(self.u.job["target"], "germany-20261201-2")

    def test_http_url_source(self):
        import functools, http.server, threading
        m, out = self.map_bundle(osm="2026-12-01", sub="served")
        os.environ["NAV_UPDATE_DIRS"] = ""
        self.u = importlib.reload(sys.modules["navd_system_updates"])
        self.u.svc = lambda *a, **k: True
        self.u.speed_mps = lambda: None
        self.u.usb_mounts = lambda: []
        self.u.RESERVE = 1000
        h = functools.partial(http.server.SimpleHTTPRequestHandler, directory=out)
        h.log_message = lambda *a: None
        srv = http.server.ThreadingHTTPServer(("127.0.0.1", 0), h)
        threading.Thread(target=srv.serve_forever, daemon=True).start()
        try:
            url = "http://127.0.0.1:%d" % srv.server_address[1]
            sc = self.u.scan(url)
            self.assertEqual((len(sc["bundles"]), sc["bundles"][0]["via"]), (1, "url"))
            self.assertEqual(self.u.url_saved(), url)                      # typed once, kept
            self.u.start({"id": sc["bundles"][0]["id"]})
            self.assertEqual(self.wait(), "ready")
            self.assertTrue(os.path.isfile(self.data + "/germany-20261201/map/germany-20261201.pmtiles"))
            sc = self.u.scan()                                             # no URL given: the saved one is used
            self.assertEqual(len(sc["bundles"]), 1)
        finally:
            srv.shutdown()
        sc = self.u.scan("http://127.0.0.1:1")                              # unreachable PC: an error, not a crash
        self.assertEqual((sc["bundles"], sc["errors"][0]["error"]), ([], "unreachable"))


class AppAndOs(Base):
    def app_src(self):
        src = self.t + "/build"
        write(src + "/app/index.html", "<html>new</html>")
        write(src + "/app/system/system.js", "//new")
        write(src + "/navd/navd.py", "# new navd")
        write(src + "/edition.json", json.dumps({"name": "advanced", "hardware": "50-rpi5-8gb", "built": "2026-12-01T10:00:00", "source": "abc123", "features": ["core"]}))
        return src

    def test_app_bundle_staged_and_applied_by_the_root_script(self):
        json.dump({"name": "advanced", "hardware": "50-rpi5-8gb", "built": "2026-11-01T10:00:00"}, open(self.t + "/edition.json", "w"))
        src = self.app_src()
        files, meta = mk.plan_app(src)
        mk.pack(src, files, meta, self.stick + "/navpi-app")
        b = self.u.scan()["bundles"][0]
        self.assertEqual((b["kind"], b["state"], b["edition"]), ("app", "new", "advanced"))
        self.u.start({"id": b["id"]})
        self.assertEqual(self.wait(), "ready")
        staged = self.data + "/updates/app-staged"
        self.assertTrue(os.path.isfile(staged + "/SHA256SUMS") and os.path.isfile(staged + "/app/index.html"))
        self.u.apply_app({})
        self.assertEqual(self.calls[-1], ("start", ["nav-pi-app-update"]))
        # the real root script, against a fake /opt/nav-pi
        opt, state = self.t + "/opt", self.t + "/state"
        write(opt + "/app/index.html", "old")
        write(opt + "/app/stale.js", "gone")
        write(opt + "/navd/navd.py", "# old")
        write(opt + "/edition.json", "{}")
        env = dict(os.environ, OPT_DIR=opt, STAGED_DIR=staged, STATE_DIR=state, NO_RESTART="1")
        r = subprocess.run(["bash", ROOT + "/pi/apply-app-update.sh"], env=env, capture_output=True, text=True)
        self.assertEqual(r.returncode, 0, open(state + "/app-update.log").read())
        self.assertEqual(open(opt + "/app/index.html").read(), "<html>new</html>")
        self.assertFalse(os.path.exists(opt + "/app/stale.js"))
        self.assertEqual(open(state + "/app-prev/app/index.html").read(), "old")           # one generation kept
        self.assertTrue(open(state + "/app-update.state").read().startswith("done"))
        self.assertFalse(os.path.exists(staged))

    def test_apply_script_refuses_tampered_staging(self):
        src = self.app_src()
        files, meta = mk.plan_app(src)
        mk.pack(src, files, meta, self.stick + "/navpi-app")
        self.u.start({"id": self.u.scan()["bundles"][0]["id"]})
        self.wait()
        staged = self.data + "/updates/app-staged"
        open(staged + "/navd/navd.py", "a").write("# injected")
        opt = self.t + "/opt"
        write(opt + "/app/a", "old"); write(opt + "/navd/navd.py", "# old"); write(opt + "/edition.json", "{}")
        r = subprocess.run(["bash", ROOT + "/pi/apply-app-update.sh"], env=dict(os.environ, OPT_DIR=opt, STAGED_DIR=staged, STATE_DIR=self.t + "/state", NO_RESTART="1"))
        self.assertNotEqual(r.returncode, 0)
        self.assertEqual(open(opt + "/navd/navd.py").read(), "# old")

    def test_app_bundle_for_other_hardware_refused(self):
        json.dump({"name": "advanced", "hardware": "10-rpi4-2gb", "built": "2026-11-01T10:00:00"}, open(self.t + "/edition.json", "w"))
        src = self.app_src()
        files, meta = mk.plan_app(src)
        mk.pack(src, files, meta, self.stick + "/navpi-app")
        b = self.u.scan()["bundles"][0]
        self.assertEqual(b["state"], "hardware")
        with self.assertRaises(self.u.UpdateError):
            self.u.start({"id": b["id"]})

    def test_os_update_states_and_script(self):
        self.assertEqual(self.u.os_state()["state"], "idle")
        self.u.os_start({})
        self.assertEqual(self.calls[-1], ("start", ["nav-pi-os-update"]))
        fake = self.t + "/fake-apt"
        write(fake, "#!/bin/bash\necho \"apt-get $*\"\n[ \"$FAIL\" = 1 ] && [ \"$1\" = -y ] && exit 100\nexit 0\n")
        os.chmod(fake, 0o755)
        env = dict(os.environ, STATE_DIR=self.t + "/state", APT_GET=fake)
        subprocess.run(["bash", ROOT + "/pi/os-update.sh"], env=env, check=True, capture_output=True)
        self.assertTrue(open(self.t + "/state/os-update.state").read().startswith("done"))
        self.assertIn("apt-get -y", open(self.t + "/state/os-update.log").read())
        self.assertEqual(self.u.os_state()["state"], "done")
        self.assertIn("finished", self.u.os_state()["log"])
        subprocess.run(["bash", ROOT + "/pi/os-update.sh"], env=dict(env, FAIL="1"), capture_output=True)
        self.assertEqual(self.u.os_state()["state"], "failed")
        open(self.t + "/no-reboot", "w").write("*** System restart required ***")
        self.assertTrue(self.u.os_state()["reboot"])


class Polkit(unittest.TestCase):
    def test_rule_names_only_the_five_units(self):
        r = open(ROOT + "/pi/50-nav-pi-update.rules.in").read()
        units = sorted(set(__import__("re").findall(r'"(nav-pi[\w-]*\.service)"', r)))
        self.assertEqual(units, ["nav-pi-app-update.service", "nav-pi-os-update.service", "nav-pi-tiles.service", "nav-pi-valhalla.service", "nav-pi.service"])
        self.assertIn("manage-units", r)
        self.assertNotIn("manage-unit-files", r)


if __name__ == "__main__":
    unittest.main()
