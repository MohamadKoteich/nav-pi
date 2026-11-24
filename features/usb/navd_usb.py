"""usb feature: USB sticks through udisks2 (udisksctl) — detect, mount on insert, free/total, eject (unmount + power-off),
and the media import (copy audio from a stick into the Music / Audiobooks / Podcasts library).
Detection = lsblk JSON (util-linux); mount / unmount / power-off = `udisksctl`. Every call is an argument list (never a
shell); device names only come from lsblk's own list, never from the client. navd runs as a service without a login
session, so polkit needs pi/49-nav-pi-usb.rules.in (setup/update scripts). Stick contents are only ever read: nothing on a
stick is deleted, renamed or overwritten (the import copies out).  Other features: GET /api/usb -> mounted sticks
[{id, label, path, free, total}] (e.g. a trip-log export writes GPX under `path`). No udisksctl: {"present": false}."""
import hashlib, json, os, shutil, subprocess, threading, time  # noqa: E401

UDISKSCTL = os.environ.get("UDISKSCTL", "udisksctl")
LSBLK = os.environ.get("LSBLK", "lsblk")
DATA = os.environ.get("NAV_DATA", "/srv/navdata")
EDITION_FILE = os.environ.get("EDITION_FILE", os.path.join(os.path.dirname(os.path.abspath(__file__)), "edition.json"))
POLL = float(os.environ.get("USB_POLL", "2"))
FS_OK = {"vfat", "exfat", "ntfs", "ext2", "ext3", "ext4"}
FS_IGNORE = {"swap", "crypto_LUKS", "LVM2_member", "linux_raid_member", "isw_raid_member", "zfs_member"}
DEST = ("Music", "Audiobooks", "Podcasts")
AUDIO = (".mp3", ".m4a", ".m4b", ".aac", ".ogg", ".oga", ".opus", ".flac", ".wav")   # same list as the media feature
SKIP_DIRS = ("System Volume Information", "$RECYCLE.BIN", "lost+found")
LOCK = threading.RLock()
cache = {"at": 0.0, "list": []}
tried = set()        # devices already auto-mounted once (an Eject / failed mount is not retried until the stick is pulled)
failed = {}          # dev -> short reason of the last failed mount
job = {"state": "idle"}   # import job: idle | running | done | failed | cancelled
cancel = threading.Event()


def run(binary, *args, timeout=30):
    try:
        p = subprocess.run([binary, *args], capture_output=True, text=True, timeout=timeout)
        return p.returncode, p.stdout, p.stderr
    except subprocess.TimeoutExpired:
        return 1, "", "timeout"
    except FileNotFoundError:
        return 127, "", "missing"


def truthy(v):
    return v is True or str(v).lower() in ("1", "true")


def parse_lsblk(out):
    """lsblk -J tree -> removable (USB) filesystems [{dev, disk, label, fs, uuid, size, mount}]. A stick is a disk with
    tran=usb (or rm+hotplug, never an SD/eMMC slot) whose partitions — or the disk itself — carry a filesystem."""
    try:
        tree = json.loads(out).get("blockdevices", [])
    except ValueError:
        return []
    res = []

    def mp(n):
        m = n.get("mountpoints")
        if m is None:
            m = [n.get("mountpoint")]
        m = [x for x in m if x]
        return m[0] if m else ""

    def visit(n, disk):
        for c in n.get("children") or []:
            visit(c, disk)
        fs = n.get("fstype")
        if n.get("type") in ("disk", "part") and fs and fs not in FS_IGNORE and not n.get("children"):
            res.append({"dev": n["path"], "disk": disk["path"], "label": n.get("label") or "", "fs": fs, "uuid": n.get("uuid") or "",
                        "size": int(n.get("size") or 0), "mount": mp(n)})

    for d in tree:
        if d.get("type") != "disk":
            continue
        internal = str(d.get("name", "")).startswith(("mmcblk", "zram", "loop", "nvme")) and d.get("tran") != "usb"
        if not internal and (d.get("tran") == "usb" or (truthy(d.get("rm")) and truthy(d.get("hotplug")))):
            visit(d, d)
    return res


def usage(path):
    try:
        s = os.statvfs(path)
        return s.f_bavail * s.f_frsize, s.f_blocks * s.f_frsize
    except OSError:
        return None, None


def read_devices():
    rc, out, _ = run(LSBLK, "-J", "-b", "-p", "-o", "NAME,PATH,TYPE,RM,HOTPLUG,TRAN,FSTYPE,LABEL,UUID,SIZE,MOUNTPOINTS", timeout=8)
    return parse_lsblk(out) if rc == 0 else []


def entry(d):
    mounted = bool(d["mount"])
    free, total = usage(d["mount"]) if mounted else (None, d["size"])
    n = os.path.basename(d["dev"])
    return {"id": d["uuid"] or n, "dev": d["dev"], "disk": d["disk"], "label": d["label"] or d["fs"].upper() + " " + n, "fs": d["fs"],
            "path": d["mount"] if mounted else "", "mounted": mounted, "free": free, "total": total,
            "supported": d["fs"] in FS_OK, "writable": mounted and os.access(d["mount"], os.W_OK),
            "error": failed.get(d["dev"], "")}


def mount_dev(dev):
    rc, out, err = run(UDISKSCTL, "mount", "-b", dev, "--no-user-interaction", timeout=40)
    if rc == 0:
        failed.pop(dev, None)
        return True
    msg = (err or out).lower()
    failed[dev] = "denied" if "authoriz" in msg else "unsupported" if ("unknown filesystem" in msg or "wrong fs" in msg) else "failed"
    return False


def snapshot(fresh=False):
    """current sticks; cached for a second so several pollers cost one lsblk. Mounts newly inserted ones (once each)."""
    with LOCK:
        if not fresh and time.time() - cache["at"] < 1.0:
            return cache["list"]
        devs = read_devices()
        seen = {d["dev"] for d in devs}
        tried.intersection_update(seen)
        for k in [k for k in failed if k not in seen]:
            failed.pop(k)
        for d in devs:
            if not d["mount"] and d["dev"] not in tried and d["fs"] in FS_OK and job["state"] != "running":
                tried.add(d["dev"])
                mount_dev(d["dev"])
        devs = read_devices()
        cache["list"] = [entry(d) for d in devs]
        cache["at"] = time.time()
        return cache["list"]


def find(stick_id, need_mounted=False):
    if not isinstance(stick_id, str):
        return None
    for s in snapshot(fresh=True):
        if s["id"] == stick_id and (s["mounted"] or not need_mounted):
            return s
    return None


def has_media():
    try:
        return "media" in json.load(open(EDITION_FILE)).get("features", [])
    except (OSError, ValueError):
        return False


def state():
    if shutil.which(UDISKSCTL) is None:
        return {"present": False}
    return {"present": True, "media": has_media(), "sticks": snapshot(), "job": dict(job)}


def api_list(h, q, j):
    return [{"id": s["id"], "label": s["label"], "path": s["path"], "free": s["free"], "total": s["total"]}
            for s in snapshot() if s["mounted"]]


def mount(j):
    s = find(j.get("id"))
    if not s:
        return {"ok": False, "error": "unknown stick"}, 404
    if not s["mounted"] and not mount_dev(s["dev"]):
        return {"ok": False, "error": failed.get(s["dev"], "failed")}, 400
    snapshot(fresh=True)
    return {"ok": True}, 200


def eject(j):
    s = find(j.get("id"))
    if not s:
        return {"ok": False, "error": "unknown stick"}, 404
    if job["state"] == "running" and job.get("stick") == s["id"]:
        return {"ok": False, "error": "busy"}, 409
    with LOCK:
        tried.add(s["dev"])
        for p in [x for x in snapshot(fresh=True) if x["disk"] == s["disk"] and x["mounted"]]:
            rc, _, _ = run(UDISKSCTL, "unmount", "-b", p["dev"], "--no-user-interaction", timeout=40)
            if rc != 0:
                snapshot(fresh=True)
                return {"ok": False, "error": "busy"}, 409   # still in use (open file) or not allowed: nothing is powered off
        rc, _, _ = run(UDISKSCTL, "power-off", "-b", s["disk"], "--no-user-interaction", timeout=30)
        snapshot(fresh=True)
    return {"ok": True, "powered_off": rc == 0}, 200


# ---------------- media import ----------------
def audio_files(root):
    """audio files under root as (relpath, size, mtime); hidden entries and symlinks skipped, bounded walk"""
    out = []
    for dp, dns, fns in os.walk(root, followlinks=False):
        dns[:] = sorted(d for d in dns if not d.startswith(".") and d not in SKIP_DIRS and not os.path.islink(os.path.join(dp, d)))
        for f in sorted(fns):
            p = os.path.join(dp, f)
            if f.startswith(".") or not f.lower().endswith(AUDIO) or os.path.islink(p):
                continue
            try:
                st = os.stat(p)
            except OSError:
                continue
            out.append((os.path.relpath(p, root), st.st_size, st.st_mtime))
            if len(out) >= 50000:
                return out
    return out


def top_of(rel):
    return rel.split(os.sep, 1)[0] if os.sep in rel else ""


def group(files):
    """top folder -> {name, count, size}; audio directly in the root of the stick is group ''"""
    g = {}
    for rel, size, _ in files:
        e = g.setdefault(top_of(rel), {"name": top_of(rel), "count": 0, "size": 0})
        e["count"] += 1
        e["size"] += size
    return sorted(g.values(), key=lambda e: (e["name"] == "", e["name"].lower()))


def guess(name):
    n = name.lower()
    return "Audiobooks" if any(k in n for k in ("audiobook", "hörbuch", "hörbüch", "hoerbuch", "book", "buch", "hörspiel")) else \
        "Podcasts" if "podcast" in n else "Music"


def scan(j):
    s = find(j.get("id"), True)
    if not s:
        return {"ok": False, "error": "unknown stick"}, 404
    groups = group(audio_files(s["path"]))
    for g in groups:
        g["dest"] = guess(g["name"])
    return {"ok": True, "folders": groups}, 200


def digest(p):
    h = hashlib.sha256()
    with open(p, "rb") as f:
        for b in iter(lambda: f.read(1 << 20), b""):
            h.update(b)
    return h.digest()


def same_file(src, dst, size, mtime):
    try:
        st = os.stat(dst)
    except OSError:
        return False
    if st.st_size != size:
        return False
    if abs(st.st_mtime - mtime) <= 2:     # FAT keeps mtime to 2 s; the copy below preserves it
        return True
    return digest(src) == digest(dst)


def copy_file(src, dst, bump):
    os.makedirs(os.path.dirname(dst), exist_ok=True)
    tmp = dst + ".part"
    try:
        with open(src, "rb") as a, open(tmp, "wb") as b:
            while True:
                if cancel.is_set():
                    raise InterruptedError
                chunk = a.read(1 << 20)
                if not chunk:
                    break
                b.write(chunk)
                bump(len(chunk))
        shutil.copystat(src, tmp)
        os.replace(tmp, dst)
    finally:
        if os.path.exists(tmp):
            os.remove(tmp)


def plan(root, picks):
    """picks [(folder, dest)] -> [(src, dst, size, mtime)]; target = DATA/media/<dest>/<rel path on the stick>"""
    lib = os.path.join(DATA, "media")
    files = audio_files(root)
    return [(os.path.join(root, rel), os.path.join(lib, dest, rel), size, mt)
            for folder, dest in picks for rel, size, mt in files if top_of(rel) == folder]


def import_job(stick_id, root, items):
    global job
    try:
        todo = [it for it in items if not same_file(it[0], it[1], it[2], it[3])]
        skipped = len(items) - len(todo)
        need = sum(it[2] for it in todo)
        lib = os.path.join(DATA, "media")
        os.makedirs(lib, exist_ok=True)
        free = shutil.disk_usage(lib).free
        if need > free - (50 << 20):      # keep 50 MB for the system
            job = {"state": "failed", "error": "space", "need": need, "free": free, "stick": stick_id}
            return
        job = {"state": "running", "stick": stick_id, "total": need, "done": 0, "files": len(todo), "files_done": 0, "skipped": skipped, "current": ""}
        for s, d, z, m in todo:
            job["current"] = os.path.basename(s)
            copy_file(s, d, lambda n: job.__setitem__("done", job["done"] + n))
            job["files_done"] += 1
        job = {"state": "done", "stick": stick_id, "copied": len(todo), "skipped": skipped, "bytes": need}
    except InterruptedError:
        job = {"state": "cancelled", "stick": stick_id}
    except OSError as e:
        job = {"state": "failed", "error": "stick" if not os.path.isdir(root) else "write", "stick": stick_id}
        print("usb import:", type(e).__name__, flush=True)
    except Exception as e:  # noqa: BLE001
        job = {"state": "failed", "error": "failed", "stick": stick_id}
        print("usb import:", type(e).__name__, flush=True)


def start_import(j):
    global job
    if not has_media():
        return {"ok": False, "error": "no media in this edition"}, 400
    s = find(j.get("id"), True)
    if not s:
        return {"ok": False, "error": "unknown stick"}, 404
    known = {g["name"] for g in group(audio_files(s["path"]))}
    picks = []
    for it in j.get("items") or []:
        f, d = (it.get("folder"), it.get("dest")) if isinstance(it, dict) else (None, None)
        if not isinstance(f, str) or f not in known or d not in DEST:
            return {"ok": False, "error": "bad item"}, 400
        picks.append((f, d))
    if not picks:
        return {"ok": False, "error": "nothing chosen"}, 400
    with LOCK:
        if job["state"] == "running":
            return {"ok": False, "error": "busy"}, 409
        cancel.clear()
        job = {"state": "running", "stick": s["id"], "total": 0, "done": 0, "files": 0, "files_done": 0, "skipped": 0, "current": ""}
    threading.Thread(target=import_job, args=(s["id"], s["path"], plan(s["path"], picks)), daemon=True).start()
    return {"ok": True}, 200


def do_cancel(j):
    cancel.set()
    return {"ok": True}, 200


def monitor():
    while True:
        try:
            snapshot(fresh=True)
        except Exception as e:  # noqa: BLE001
            print("usb monitor:", type(e).__name__, flush=True)
        time.sleep(POLL)


def register(app):
    app.get("/api/usb", api_list)
    app.get("/api/usb/state", lambda h, q, j: state())
    for name, fn in (("mount", mount), ("eject", eject), ("scan", scan), ("import", start_import), ("cancel", do_cancel)):
        app.post("/api/usb/" + name, lambda h, q, j, fn=fn: fn(j or {}))
    app.thread(monitor)
