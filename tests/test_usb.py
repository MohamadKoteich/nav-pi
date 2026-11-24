"""Tests for features/usb/navd_usb.py. Run: python3 -m unittest tests/test_usb.py -v  (fake lsblk + udisksctl, no Pi, no root)"""
import importlib.util, json, os, shutil, tempfile, time, unittest  # noqa: E401

HERE = os.path.dirname(os.path.abspath(__file__))
TMP = tempfile.mkdtemp(prefix="usbtest-")
CFG = dict(LSBLK=os.path.join(HERE, "fake-lsblk"), UDISKSCTL=os.path.join(HERE, "fake-udisksctl"), FAKE_USB_STATE=os.path.join(TMP, "state.json"),
           NAV_DATA=os.path.join(TMP, "data"), EDITION_FILE=os.path.join(TMP, "edition.json"))
spec = importlib.util.spec_from_file_location("navd_usb", os.path.join(HERE, "..", "features", "usb", "navd_usb.py"))
U = importlib.util.module_from_spec(spec)
spec.loader.exec_module(U)
for _k in ('LSBLK', 'UDISKSCTL', 'EDITION_FILE'):
    setattr(U, _k, CFG[_k])
U.DATA = CFG['NAV_DATA']

RECORDED = {"blockdevices": [   # shape of a real `lsblk -J -b -p` (util-linux 2.41): internal SATA data disk, SD card, a stick, an unformatted USB disk
    {"name": "/dev/sda", "path": "/dev/sda", "type": "disk", "rm": False, "hotplug": False, "tran": "sata", "fstype": None, "size": 4000787030016,
     "children": [{"name": "/dev/sda1", "path": "/dev/sda1", "type": "part", "fstype": "ext4", "label": "backup-data", "uuid": "d8", "size": 4000785964544, "mountpoints": ["/srv/data"]}]},
    {"name": "/dev/mmcblk0", "path": "/dev/mmcblk0", "type": "disk", "rm": False, "hotplug": False, "tran": None, "size": 1,
     "children": [{"name": "/dev/mmcblk0p1", "path": "/dev/mmcblk0p1", "type": "part", "fstype": "vfat", "size": 1, "mountpoints": ["/boot/firmware"]}]},
    {"name": "/dev/sdb", "path": "/dev/sdb", "type": "disk", "rm": "1", "hotplug": "1", "tran": "usb", "fstype": None, "size": 32000000000,
     "children": [{"name": "/dev/sdb1", "path": "/dev/sdb1", "type": "part", "fstype": "exfat", "label": "TRIPS", "uuid": "AAAA-BBBB", "size": 31999000000, "mountpoints": [None]},
                  {"name": "/dev/sdb2", "path": "/dev/sdb2", "type": "part", "fstype": "swap", "size": 1000, "mountpoints": [None]}]},
    {"name": "/dev/sdc", "path": "/dev/sdc", "type": "disk", "rm": True, "hotplug": True, "tran": "usb", "fstype": "ntfs", "label": "WHOLE", "uuid": "N1", "size": 5, "mountpoints": ["/media/nav/WHOLE"]},
]}


def mkdirs(*paths):
    for p in paths:
        os.makedirs(p, exist_ok=True)


def touch(path, data=b"x", mtime=None):
    mkdirs(os.path.dirname(path))
    with open(path, "wb") as f:
        f.write(data)
    if mtime:
        os.utime(path, (mtime, mtime))


class Parse(unittest.TestCase):
    def test_only_usb_filesystems(self):
        r = U.parse_lsblk(json.dumps(RECORDED))
        self.assertEqual([(x["dev"], x["fs"], x["label"], x["mount"]) for x in r],
                         [("/dev/sdb1", "exfat", "TRIPS", ""), ("/dev/sdc", "ntfs", "WHOLE", "/media/nav/WHOLE")])   # no SATA, no SD, no swap
        self.assertEqual(r[0]["disk"], "/dev/sdb")

    def test_old_lsblk_single_mountpoint_and_junk(self):
        old = {"blockdevices": [{"name": "/dev/sdb", "path": "/dev/sdb", "type": "disk", "rm": "1", "hotplug": "1", "tran": "usb", "size": 1,
                                 "children": [{"name": "/dev/sdb1", "path": "/dev/sdb1", "type": "part", "fstype": "vfat", "size": 1, "mountpoint": "/m"}]}]}
        self.assertEqual(U.parse_lsblk(json.dumps(old))[0]["mount"], "/m")
        self.assertEqual(U.parse_lsblk("not json"), [])


class Fake(unittest.TestCase):
    def setUp(self):
        os.environ['FAKE_USB_STATE'] = CFG['FAKE_USB_STATE']
        self.stick = os.path.join(TMP, "stick")
        shutil.rmtree(self.stick, ignore_errors=True)
        shutil.rmtree(CFG["NAV_DATA"], ignore_errors=True)
        mkdirs(self.stick)
        json.dump({"sticks": [{"disk": "/dev/sdb", "tran": "usb", "parts": [
            {"dev": "/dev/sdb1", "fstype": "vfat", "label": "MUSIC", "uuid": "AAAA-BBBB", "size": 8000000000, "dir": self.stick}]}], "mounted": {}, "calls": []},
            open(CFG["FAKE_USB_STATE"], "w"))
        json.dump({"features": ["core", "usb", "media"]}, open(CFG["EDITION_FILE"], "w"))
        U.cache.update(at=0.0, list=[]); U.tried.clear(); U.failed.clear(); U.job.clear(); U.job["state"] = "idle"
        U.cancel.clear()

    def calls(self):
        return json.load(open(CFG["FAKE_USB_STATE"]))["calls"]

    def wait(self):
        for _ in range(200):
            if U.job["state"] != "running":
                return
            time.sleep(0.05)
        self.fail("import did not finish")

    def test_automount_on_insert_once(self):
        l = U.api_list(None, {}, None)
        self.assertEqual(len(l), 1)
        self.assertEqual((l[0]["id"], l[0]["label"], l[0]["path"]), ("AAAA-BBBB", "MUSIC", self.stick))
        self.assertTrue(l[0]["free"] > 0 and l[0]["total"] > 0)
        self.assertEqual(sorted(l[0]), ["free", "id", "label", "path", "total"])
        self.assertIn(["fake-udisksctl", "mount", "-b", "/dev/sdb1", "--no-user-interaction"], self.calls())

    def test_eject_unmounts_and_powers_off_and_is_not_remounted(self):
        U.snapshot(fresh=True)
        r, code = U.eject({"id": "AAAA-BBBB"})
        self.assertEqual(code, 200)
        c = [x[1:3] for x in self.calls() if x[0] == "fake-udisksctl"]
        self.assertEqual(c, [["mount", "-b"], ["unmount", "-b"], ["power-off", "-b"]])
        self.assertEqual(U.api_list(None, {}, None), [])

    def test_eject_busy_keeps_power(self):
        U.snapshot(fresh=True)
        s = json.load(open(CFG["FAKE_USB_STATE"])); s["sticks"][0]["parts"][0]["busy"] = True; json.dump(s, open(CFG["FAKE_USB_STATE"], "w"))
        r, code = U.eject({"id": "AAAA-BBBB"})
        self.assertEqual((code, r["error"]), (409, "busy"))
        self.assertFalse(any(x[1] == "power-off" for x in self.calls() if x[0] == "fake-udisksctl"))

    def test_denied_mount_reported_not_retried(self):
        s = json.load(open(CFG["FAKE_USB_STATE"])); s["sticks"][0]["parts"][0]["mount_fail"] = True; json.dump(s, open(CFG["FAKE_USB_STATE"], "w"))
        st = U.state()["sticks"][0]
        self.assertEqual((st["mounted"], st["error"]), (False, "denied"))
        U.snapshot(fresh=True); U.snapshot(fresh=True)
        self.assertEqual(sum(1 for x in self.calls() if x[1:2] == ["mount"]), 1)    # one automatic try only
        r, code = U.mount({"id": "AAAA-BBBB"})                                      # the Open button retries
        self.assertEqual(code, 400)
        self.assertEqual(sum(1 for x in self.calls() if x[1:2] == ["mount"]), 2)

    def test_unknown_id_never_reaches_udisksctl(self):
        U.snapshot(fresh=True)
        n = len(self.calls())
        for fn in (U.mount, U.eject):
            self.assertEqual(fn({"id": "/dev/mmcblk0p2"})[1], 404)
            self.assertEqual(fn({"id": "x; rm -rf /"})[1], 404)
            self.assertEqual(fn({"id": ["a"]})[1], 404)
        self.assertFalse(any(x[0] == "fake-udisksctl" for x in self.calls()[n:]))   # (lsblk reads are fine)

    def test_scan_groups_by_top_folder(self):
        touch(self.stick + "/Rock/a.mp3"); touch(self.stick + "/Rock/Live/b.FLAC"); touch(self.stick + "/Hörbücher/c.m4b")
        touch(self.stick + "/Podcasts/d.opus"); touch(self.stick + "/loose.mp3"); touch(self.stick + "/Rock/cover.jpg"); touch(self.stick + "/.hidden/x.mp3")
        U.snapshot(fresh=True)
        r, code = U.scan({"id": "AAAA-BBBB"})
        self.assertEqual(code, 200)
        self.assertEqual([(f["name"], f["count"], f["dest"]) for f in r["folders"]],
                         [("Hörbücher", 1, "Audiobooks"), ("Podcasts", 1, "Podcasts"), ("Rock", 2, "Music"), ("", 1, "Music")])

    def test_import_copies_skips_and_never_touches_the_stick(self):
        data = CFG["NAV_DATA"]
        touch(self.stick + "/Rock/a.mp3", b"A" * 1000, 1_700_000_000); touch(self.stick + "/Rock/b.mp3", b"B" * 2000, 1_700_000_100)
        touch(self.stick + "/Books/x.m4b", b"C" * 500)
        touch(data + "/media/Music/Rock/a.mp3", b"A" * 1000, 1_700_000_001)           # identical (size + mtime within FAT's 2 s)
        touch(data + "/media/Music/Rock/b.mp3", b"Z" * 2000, 5)                        # same size, different content -> replaced
        before = sorted(os.listdir(self.stick + "/Rock"))
        U.snapshot(fresh=True)
        r, code = U.start_import({"id": "AAAA-BBBB", "items": [{"folder": "Rock", "dest": "Music"}, {"folder": "Books", "dest": "Audiobooks"}]})
        self.assertEqual(code, 200)
        self.wait()
        self.assertEqual((U.job["state"], U.job["copied"], U.job["skipped"]), ("done", 2, 1))
        self.assertEqual(open(data + "/media/Music/Rock/b.mp3", "rb").read(), b"B" * 2000)
        self.assertEqual(open(data + "/media/Audiobooks/Books/x.m4b", "rb").read(), b"C" * 500)
        self.assertEqual(sorted(os.listdir(self.stick + "/Rock")), before)
        self.assertEqual(open(self.stick + "/Rock/b.mp3", "rb").read(), b"B" * 2000)
        self.assertFalse(any(f.endswith(".part") for _, _, fs in os.walk(data) for f in fs))
        U.start_import({"id": "AAAA-BBBB", "items": [{"folder": "Rock", "dest": "Music"}]}); self.wait()   # second run: all identical
        self.assertEqual((U.job["copied"], U.job["skipped"]), (0, 2))

    def test_import_refuses_when_there_is_no_room(self):
        touch(self.stick + "/Rock/a.mp3", b"A" * 1000)
        U.snapshot(fresh=True)
        real = shutil.disk_usage
        shutil.disk_usage = lambda p: type("D", (), {"free": 10 << 20})()
        try:
            U.start_import({"id": "AAAA-BBBB", "items": [{"folder": "Rock", "dest": "Music"}]}); self.wait()
        finally:
            shutil.disk_usage = real
        self.assertEqual((U.job["state"], U.job["error"]), ("failed", "space"))
        self.assertFalse(os.path.exists(CFG["NAV_DATA"] + "/media/Music/Rock/a.mp3"))

    def test_import_validation(self):
        touch(self.stick + "/Rock/a.mp3")
        U.snapshot(fresh=True)
        bad = [{"folder": "Rock", "dest": "../../etc"}, {"folder": "../x", "dest": "Music"}, {"folder": "Nope", "dest": "Music"}, "Rock", {}]
        for it in bad:
            self.assertEqual(U.start_import({"id": "AAAA-BBBB", "items": [it]})[1], 400, it)
        self.assertEqual(U.start_import({"id": "AAAA-BBBB", "items": []})[1], 400)
        json.dump({"features": ["core", "usb"]}, open(CFG["EDITION_FILE"], "w"))   # basic: no media library
        self.assertEqual(U.start_import({"id": "AAAA-BBBB", "items": [{"folder": "Rock", "dest": "Music"}]})[1], 400)
        self.assertFalse(U.state()["media"])

    def test_cancel(self):
        touch(self.stick + "/Rock/a.mp3", b"A" * (6 << 20))
        U.snapshot(fresh=True)
        orig = U.copy_file
        U.copy_file = lambda s, d, bump: (U.cancel.set(), orig(s, d, bump))[1]
        try:
            U.start_import({"id": "AAAA-BBBB", "items": [{"folder": "Rock", "dest": "Music"}]}); self.wait()
        finally:
            U.copy_file = orig
        self.assertEqual(U.job["state"], "cancelled")
        self.assertFalse(os.path.exists(CFG["NAV_DATA"] + "/media/Music/Rock/a.mp3.part"))


if __name__ == "__main__":
    unittest.main()
