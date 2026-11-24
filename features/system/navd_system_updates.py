"""system feature, updates (PN-22 map updates, PN-23 app + OS updates). Loaded by navd_system.py; standalone, no server.

MAP / APP BUNDLE = a folder with `manifest.json` (+ the files it lists, relative to it), built on a PC by
scripts/30-make-update-bundle.sh, found on a USB stick (GET /api/usb of the usb feature) or fetched from an http URL
the user typed once (any folder served over http on the LAN, e.g. `python3 -m http.server`):
  {"navpi_update": 1, "kind": "map"|"app", "region", "osm", "built", "files": [{"path", "size", "sha256"}], ...}
Map files mirror a region folder (map/<region>.pmtiles, search/places.sqlite, valhalla/valhalla_tiles.tar + valhalla.json ...).

MAP FLOW: scan -> free-space plan (two copies fit = side by side; else replace-in-place only with an explicit warning)
-> copy with progress into /srv/navdata/.incoming-<name> (sha256 of the stream, then of the written file) -> rename to
/srv/navdata/<region>-<osmdate> (the pmtiles inside is renamed to <name>.pmtiles: tiles are served as /tiles/<folder name>/)
-> "Switch": atomic repoint of /srv/navdata/current + restart of tiles / valhalla / navd. The previous folder stays for
"Roll back" until the user deletes it. Never while driving (gps speed from /api/status, plus the app's "guiding" flag).
APP FLOW: same copy into /srv/navdata/updates/app-staged, then the root oneshot unit nav-pi-app-update applies it.
OS FLOW: the root oneshot unit nav-pi-os-update runs `apt-get update && upgrade`; navd only starts it and reads its log.
navd (user nav, no sudo) may start/stop/restart exactly five units through polkit (pi/50-nav-pi-update.rules.in).
Test hooks: module attributes svc / speed_mps / usb_mounts are replaced in tests/test_updates.py; env NAV_DATA, NAV_UPDATE_DIRS
(extra source folders, ':' separated), NAV_STATE_DIR (os/app logs), NAV_SYSTEMCTL, NAV_REBOOT_FILE."""
import hashlib, json, os, re, shutil, subprocess, threading, time, urllib.parse, urllib.request  # noqa: E401

DATA = os.environ.get("NAV_DATA", "/srv/navdata")
HERE = os.path.dirname(os.path.abspath(__file__))
EDITION_FILE = os.environ.get("EDITION_FILE", os.path.join(HERE, "edition.json"))
STATE_DIR = os.environ.get("NAV_STATE_DIR", "/var/lib/nav-pi")
SYSTEMCTL = os.environ.get("NAV_SYSTEMCTL", "systemctl")
REBOOT_FILE = os.environ.get("NAV_REBOOT_FILE", "/run/reboot-required")
PORT = os.environ.get("NAV_PORT", "8080")
RESERVE = int(os.environ.get("NAV_UPDATE_RESERVE", str(500 * 1000 * 1000)))   # always keep this much free
CHUNK = 4 * 1024 * 1024
MOVING_MPS = 0.7                       # GPS jitter at a standstill stays below this (~2.5 km/h)
RESERVED = {"current", "updates", "fonts", "media", "voice", "trips"}
NAME_RE = re.compile(r"^[a-z0-9][a-z0-9_-]{0,47}$")
SHA_RE = re.compile(r"^[0-9a-f]{64}$")
MAP_DIRS = ("map/", "search/", "valhalla/")
MAP_REQUIRED = ("search/places.sqlite", "valhalla/valhalla_tiles.tar", "valhalla/valhalla.json")
UNITS = {"tiles": "nav-pi-tiles", "valhalla": "nav-pi-valhalla", "navd": "nav-pi"}
LOCK = threading.RLock()
cancel = threading.Event()
job = {"state": "idle"}                # idle | running | ready | switching | done | failed | cancelled
bundles = {}                           # id -> bundle (last scan); the client only ever sends an id back


class UpdateError(Exception):
    def __init__(self, code, msg=""):
        super().__init__(code)
        self.code, self.msg = code, msg


# ---------------------------------------------------------------- environment (replaced in tests)
def svc(action, units, block=True):
    """systemctl <action> <unit>... as the navd user (polkit rule). True when every call succeeded."""
    ok = True
    for u in units:
        try:
            args = [SYSTEMCTL, action] + ([] if block else ["--no-block"]) + [u + ".service"]
            ok = subprocess.run(args, capture_output=True, timeout=120).returncode == 0 and ok
        except Exception:
            ok = False
    return ok


def speed_mps():
    """Latest GPS speed from navd's own /api/status (gps feature); None = no fix / no gps feature."""
    try:
        with urllib.request.urlopen("http://127.0.0.1:%s/api/status" % PORT, timeout=2) as r:
            g = json.load(r).get("gps") or {}
        return float(g.get("speed") or 0) if (g.get("mode") or 0) >= 2 else None
    except Exception:
        return None


def usb_mounts():
    try:
        with urllib.request.urlopen("http://127.0.0.1:%s/api/usb" % PORT, timeout=3) as r:
            return json.load(r)
    except Exception:
        return []


# ---------------------------------------------------------------- helpers
def _read(p):
    try:
        with open(p) as f:
            return f.read()
    except OSError:
        return ""


def _kv(text):
    out = dict(re.findall(r"(\w+)=(\S+)", text))
    m = re.search(r"osmosisreplicationtime (\S+)", text)
    if m:
        out["osm"] = m.group(1)
    return out


def current_name():
    link = os.path.join(DATA, "current")
    return os.path.basename(os.path.realpath(link)) if os.path.islink(link) else ""


def dir_size(p):
    n = 0
    for root, _, files in os.walk(p):
        for f in files:
            try:
                n += os.path.getsize(os.path.join(root, f))
            except OSError:
                pass
    return n


def free_bytes():
    return shutil.disk_usage(DATA if os.path.isdir(DATA) else "/").free


def region_dirs():
    """Region folders in DATA (a folder with map/ or valhalla/), newest first."""
    out = []
    try:
        names = os.listdir(DATA)
    except OSError:
        return out
    for n in names:
        p = os.path.join(DATA, n)
        if n.startswith(".") or n in RESERVED or not os.path.isdir(p) or os.path.islink(p):
            continue
        if not (os.path.isdir(os.path.join(p, "map")) or os.path.isdir(os.path.join(p, "valhalla"))):
            continue
        kv = _kv(_read(os.path.join(p, "map", "BUILD-INFO")))
        out.append({"name": n, "region": kv.get("region", n), "osm": kv.get("osm", "")[:10], "built": kv.get("built", "")[:10],
                    "size": dir_size(p), "mtime": os.path.getmtime(p)})
    out.sort(key=lambda r: -r["mtime"])
    return out


def load_state():
    try:
        with open(os.path.join(DATA, "updates", "state.json")) as f:
            return json.load(f)
    except (OSError, ValueError):
        return {}


def save_state(**kw):
    s = load_state()
    s.update(kw)
    d = os.path.join(DATA, "updates")
    os.makedirs(d, exist_ok=True)
    tmp = os.path.join(d, "state.json.tmp")
    with open(tmp, "w") as f:
        json.dump(s, f)
    os.replace(tmp, os.path.join(d, "state.json"))


def url_saved():
    return _read(os.path.join(DATA, "updates", "url.txt")).strip()


def driving(guiding=False):
    if guiding:
        return True
    v = speed_mps()
    return v is not None and v > MOVING_MPS


def check_parked(j):
    if driving(bool(j.get("guiding"))):
        raise UpdateError("driving")


# ---------------------------------------------------------------- manifest + sources
def safe_rel(p, kind):
    if not isinstance(p, str) or not p or p.startswith("/") or "\\" in p or "\x00" in p:
        raise UpdateError("manifest", "bad path")
    parts = p.split("/")
    if any(x in ("", ".", "..") for x in parts):
        raise UpdateError("manifest", "bad path")
    ok = p.startswith(MAP_DIRS) if kind == "map" else (p.startswith(("app/", "navd/")) or p == "edition.json")
    if not ok:
        raise UpdateError("manifest", "path not allowed: " + p)
    return p


def parse_manifest(m):
    """Validate a manifest object, return a normalised copy. UpdateError("manifest") on anything odd."""
    if not isinstance(m, dict) or m.get("navpi_update") != 1 or m.get("kind") not in ("map", "app"):
        raise UpdateError("manifest", "not a nav-pi update")
    kind = m["kind"]
    files = []
    for f in m.get("files") or []:
        if not isinstance(f, dict) or not isinstance(f.get("size"), int) or f["size"] < 0 or not SHA_RE.match(str(f.get("sha256", ""))):
            raise UpdateError("manifest", "bad file entry")
        files.append({"path": safe_rel(f.get("path"), kind), "size": f["size"], "sha256": f["sha256"]})
    paths = [f["path"] for f in files]
    if not files or len(set(paths)) != len(paths):
        raise UpdateError("manifest", "no files or duplicates")
    out = {"kind": kind, "files": files, "total": sum(f["size"] for f in files), "built": str(m.get("built", ""))[:19],
           "osm": str(m.get("osm", ""))[:10]}
    if kind == "map":
        region = str(m.get("region", ""))
        if not NAME_RE.match(region) or region in RESERVED:
            raise UpdateError("manifest", "bad region name")
        for need in MAP_REQUIRED + ("map/%s.pmtiles" % region, "map/BUILD-INFO"):
            if need not in paths:
                raise UpdateError("manifest", "missing " + need)
        out["region"] = region
    else:
        if "edition.json" not in paths or not any(p.startswith("app/") for p in paths) or not any(p.startswith("navd/") for p in paths):
            raise UpdateError("manifest", "incomplete app bundle")
        out.update(edition=str(m.get("edition", "")), hardware=str(m.get("hardware", "")), source=str(m.get("source", ""))[:40])
    return out


class LocalSource:
    def __init__(self, root):
        self.root = root

    def label(self):
        return self.root

    def read_manifest(self):
        with open(os.path.join(self.root, "manifest.json")) as f:
            return json.load(f)

    def open(self, rel):
        return open(os.path.join(self.root, *rel.split("/")), "rb")


class HttpSource:
    def __init__(self, base):
        self.base = base.rstrip("/")

    def label(self):
        return self.base

    def _get(self, rel):
        return urllib.request.urlopen(self.base + "/" + urllib.parse.quote(rel), timeout=30)

    def read_manifest(self):
        with self._get("manifest.json") as r:
            return json.loads(r.read(5_000_000))

    def open(self, rel):
        return self._get(rel)


def bad_url(u):
    p = urllib.parse.urlparse(u or "")
    return p.scheme not in ("http", "https") or not p.netloc


def local_roots():
    """Folders that hold a manifest.json: root and up to two levels below every stick (and NAV_UPDATE_DIRS)."""
    roots = [m.get("path") for m in usb_mounts() if m.get("path")]
    roots += [d for d in os.environ.get("NAV_UPDATE_DIRS", "").split(":") if d]
    out = []
    for r in roots:
        stack = [(r, 0)]
        while stack:
            d, depth = stack.pop()
            if os.path.isfile(os.path.join(d, "manifest.json")):
                out.append((r, d))
                continue
            if depth >= 2:
                continue
            try:
                for e in os.scandir(d):
                    if e.is_dir(follow_symlinks=False) and not e.name.startswith((".", "$")) and e.name != "System Volume Information":
                        stack.append((e.path, depth + 1))
            except OSError:
                pass
    return out


def compare(b):
    """What the bundle means for this Pi: new | same | older (by OSM date for maps, build time for apps)."""
    if b["kind"] == "map":
        cur = _kv(_read(os.path.join(DATA, "current", "map", "BUILD-INFO")))
        have = cur.get("osm", "")[:10]
        same_region = cur.get("region", "") == b["region"]
        b["current"] = {"region": cur.get("region", ""), "osm": have}
        key = b["osm"] or b["built"][:10]
        b["state"] = "new" if not have or not same_region or key > have else ("same" if key == have else "older")
    else:
        try:
            with open(EDITION_FILE) as f:
                ed = json.load(f)
        except (OSError, ValueError):
            ed = {}
        b["current"] = {"edition": ed.get("name", ""), "built": (ed.get("built") or "")[:19], "source": ed.get("source", "")}
        b["state"] = "new" if b["built"] > (ed.get("built") or "")[:19] else ("same" if b["built"] == (ed.get("built") or "")[:19] else "older")
        if ed.get("hardware") and b.get("hardware") and ed["hardware"] != b["hardware"]:
            b["state"] = "hardware"


def plan_for(b):
    """Free-space plan BEFORE anything is copied. fits: side (two copies fit) | replace (only after deleting the old
    region(s); needs the explicit warning) | none."""
    free = free_bytes()
    need = b["total"] + RESERVE
    p = {"need": need, "free": free, "fits": "side" if free >= need else "none"}
    if b["kind"] == "map" and p["fits"] == "none":
        regs = region_dirs()
        p["freeable"] = sum(r["size"] for r in regs)
        p["fits"] = "replace" if free + p["freeable"] >= need else "none"
        p["delete"] = [r["name"] for r in regs]
    return p


def scan(url=None):
    """List the update bundles on the sticks and at the URL (the URL is kept for next time)."""
    found, errors = [], []
    cand = [("usb", LocalSource(d), os.path.relpath(d, r)) for r, d in local_roots()]
    if url is None:
        url = url_saved()
    elif url:
        if bad_url(url):
            raise UpdateError("url")
        os.makedirs(os.path.join(DATA, "updates"), exist_ok=True)
        with open(os.path.join(DATA, "updates", "url.txt"), "w") as f:
            f.write(url)
    if url:
        if bad_url(url):
            raise UpdateError("url")
        cand.append(("url", HttpSource(url), ""))
    for kind, src, rel in cand:
        try:
            b = parse_manifest(src.read_manifest())
        except UpdateError as e:
            errors.append({"source": src.label(), "error": e.code, "msg": e.msg})
            continue
        except (OSError, ValueError) as e:
            errors.append({"source": src.label(), "error": "unreachable" if kind == "url" else "manifest", "msg": str(e)[:120]})
            continue
        b["source"], b["via"] = src, kind
        b["where"] = src.label() if kind == "url" else (rel if rel != "." else "")
        b["id"] = "b" + hashlib.sha1((kind + src.label()).encode()).hexdigest()[:10]
        compare(b)
        b["plan"] = plan_for(b)
        found.append(b)
    with LOCK:
        bundles.clear()
        bundles.update({b["id"]: b for b in found})
    public = [{k: v for k, v in b.items() if k not in ("source", "files")} for b in found]
    return {"bundles": public, "errors": errors, "url": url}


# ---------------------------------------------------------------- copy + verify
def _set(**kw):
    with LOCK:
        job.update(kw)


def copy_files(src, files, dest, rename=None):
    """Copy every file (resumes nothing: a failed copy is thrown away), sha256 of the stream, then of the written file."""
    total = sum(f["size"] for f in files)
    _set(phase="copy", done=0, total=total, files=len(files), file_i=0)
    done = 0
    for i, f in enumerate(files):
        rel = rename(f["path"]) if rename else f["path"]
        out = os.path.join(dest, *rel.split("/"))
        os.makedirs(os.path.dirname(out), exist_ok=True)
        _set(file=rel, file_i=i + 1)
        h, n = hashlib.sha256(), 0
        with src.open(f["path"]) as r, open(out, "wb") as w:
            while True:
                if cancel.is_set():
                    raise UpdateError("cancelled")
                b = r.read(CHUNK)
                if not b:
                    break
                w.write(b)
                h.update(b)
                n += len(b)
                done += len(b)
                _set(done=done)
            w.flush()
            os.fsync(w.fileno())
        if n != f["size"] or h.hexdigest() != f["sha256"]:
            raise UpdateError("sha256", rel)
    _set(phase="verify", done=0, file_i=0)
    done = 0
    for i, f in enumerate(files):
        rel = rename(f["path"]) if rename else f["path"]
        h = hashlib.sha256()
        _set(file=rel, file_i=i + 1)
        with open(os.path.join(dest, *rel.split("/")), "rb") as r:
            while True:
                if cancel.is_set():
                    raise UpdateError("cancelled")
                b = r.read(CHUNK)
                if not b:
                    break
                h.update(b)
                done += len(b)
                _set(done=done)
        if h.hexdigest() != f["sha256"]:
            raise UpdateError("sha256", rel)


def new_region_name(b):
    day = (b["osm"] or b["built"][:10] or time.strftime("%Y-%m-%d")).replace("-", "")[:8]
    base, n, name = "%s-%s" % (b["region"], day), 1, ""
    name = base
    while os.path.exists(os.path.join(DATA, name)):
        n += 1
        name = "%s-%d" % (base, n)
    return name


def run_job(b, mode):
    kind = b["kind"]
    try:
        if kind == "map":
            name = new_region_name(b)
            _set(name=name)
            inc = os.path.join(DATA, ".incoming-" + name)
            shutil.rmtree(inc, ignore_errors=True)
            if mode == "replace":
                if not svc("stop", [UNITS["tiles"], UNITS["valhalla"]]):
                    raise UpdateError("service")
                for r in region_dirs():
                    shutil.rmtree(os.path.join(DATA, r["name"]), ignore_errors=True)
                save_state(previous="")
            elif free_bytes() < b["total"] + RESERVE:
                raise UpdateError("space")
            if mode == "replace" and free_bytes() < b["total"] + RESERVE:
                raise UpdateError("space")
            pm = "map/%s.pmtiles" % b["region"]
            copy_files(b["source"], b["files"], inc, rename=lambda p: "map/%s.pmtiles" % name if p == pm else p)
            os.rename(inc, os.path.join(DATA, name))
            _set(state="ready", target=name)
            if mode == "replace":   # the old map is gone: nothing to wait for
                finish_switch(name, keep_previous=False)
        else:
            inc = os.path.join(DATA, "updates", "app-incoming")
            staged = os.path.join(DATA, "updates", "app-staged")
            for d in (inc, staged):
                shutil.rmtree(d, ignore_errors=True)
            if free_bytes() < b["total"] + RESERVE:
                raise UpdateError("space")
            copy_files(b["source"], b["files"], inc)
            with open(os.path.join(inc, "SHA256SUMS"), "w") as w:
                w.writelines("%s  %s\n" % (f["sha256"], f["path"]) for f in b["files"])
            with open(os.path.join(inc, "ACTION"), "w") as f:
                f.write("update\n")
            os.rename(inc, staged)
            _set(state="ready", target=b["edition"] or "app")
    except UpdateError as e:
        _fail(e, b, kind)
    except Exception as e:   # unreadable stick, URL dropped, disk full ...
        _fail(UpdateError("copy", str(e)[:160]), b, kind)


def _fail(e, b, kind):
    if kind == "map":
        shutil.rmtree(os.path.join(DATA, ".incoming-" + str(job.get("name", ""))), ignore_errors=True)
    else:
        shutil.rmtree(os.path.join(DATA, "updates", "app-incoming"), ignore_errors=True)
    _set(state="cancelled" if e.code == "cancelled" else "failed", error=e.code, msg=e.msg)


def start(j):
    check_parked(j)
    with LOCK:
        if job.get("state") in ("running", "switching"):
            raise UpdateError("busy")
        b = bundles.get(j.get("id"))
        if not b:
            raise UpdateError("rescan")
        mode = j.get("mode", "side")
        if mode not in ("side", "replace"):
            raise UpdateError("bad")
        plan = plan_for(b)
        if plan["fits"] == "none":
            raise UpdateError("space", json.dumps(plan))
        if mode == "side" and plan["fits"] != "side":
            raise UpdateError("space", json.dumps(plan))          # replace-in-place needs the explicit flag AND the choice
        if mode == "replace" and not j.get("confirm"):
            raise UpdateError("confirm")
        if b["kind"] == "app" and b.get("state") == "hardware":
            raise UpdateError("hardware")
        cancel.clear()
        job.clear()
        job.update(state="running", kind=b["kind"], phase="copy", done=0, total=b["total"], mode=mode, file="", started=time.time(),
                   label=b.get("region") or b.get("edition") or "")
    threading.Thread(target=run_job, args=(b, mode), daemon=True).start()
    return {"ok": True}


def cancel_job(j):
    cancel.set()
    return {"ok": True}


# ---------------------------------------------------------------- switch / rollback / delete
def link_to(name):
    tmp = os.path.join(DATA, ".current.new")
    try:
        os.unlink(tmp)
    except OSError:
        pass
    os.symlink(name, tmp)
    os.replace(tmp, os.path.join(DATA, "current"))   # atomic: tiles/valhalla/navd see the old or the new region, never none


def restart_all():
    return svc("restart", [UNITS["tiles"], UNITS["valhalla"]])


def finish_switch(name, keep_previous=True):
    """Repoint `current` to `name`, restart the map services; undo the link when they will not restart."""
    if not NAME_RE.match(name) or not os.path.isdir(os.path.join(DATA, name, "map")):
        raise UpdateError("missing")
    old = current_name()
    _set(state="switching")
    link_to(name)
    if not restart_all():
        if old and os.path.isdir(os.path.join(DATA, old)):
            link_to(old)
            restart_all()
        _set(state="failed", error="service", msg="")
        raise UpdateError("service")
    save_state(previous=old if keep_previous and old and old != name else "", switched_to=name, switched_at=time.strftime("%Y-%m-%dT%H:%M:%S"))
    _set(state="done", target=name)
    # navd reads the region once at start (tile URL, search db): restart it last, after this reply has gone out
    threading.Timer(1.5, lambda: svc("restart", [UNITS["navd"]], block=False)).start()


def switch(j):
    check_parked(j)
    with LOCK:
        if job.get("state") != "ready" or job.get("kind") != "map":
            raise UpdateError("nothing")
        name = job["target"]
    finish_switch(name)
    return {"ok": True, "switched": name}


def rollback(j):
    check_parked(j)
    with LOCK:
        if job.get("state") in ("running", "switching"):
            raise UpdateError("busy")
    prev = load_state().get("previous", "")
    if not prev or not os.path.isdir(os.path.join(DATA, prev, "map")):
        raise UpdateError("nothing")
    cur = current_name()
    finish_switch(prev, keep_previous=False)
    save_state(previous=cur if cur and cur != prev else "")   # rolling back is reversible: "Roll back" again goes forward
    return {"ok": True, "switched": prev}


def delete_region(j):
    name = str(j.get("name", ""))
    if not NAME_RE.match(name) or name in RESERVED or name == current_name():
        raise UpdateError("bad")
    if name not in [r["name"] for r in region_dirs()]:
        raise UpdateError("bad")
    with LOCK:
        if job.get("state") in ("running", "switching"):
            raise UpdateError("busy")
    shutil.rmtree(os.path.join(DATA, name))
    if load_state().get("previous") == name:
        save_state(previous="")
    return {"ok": True}


def apply_app(j):
    check_parked(j)
    with LOCK:
        if job.get("state") != "ready" or job.get("kind") != "app":
            raise UpdateError("nothing")
        _set(state="switching")
    if not svc("start", ["nav-pi-app-update"], block=False):
        _set(state="failed", error="service", msg="")
        raise UpdateError("service")
    return {"ok": True}   # the unit rsyncs the staged files, then restarts navd; the page reloads when navd is back


# ---------------------------------------------------------------- OS update (apt, root oneshot unit)
def os_state():
    st = _read(os.path.join(STATE_DIR, "os-update.state")).strip()   # "running <t>" | "done <t>" | "failed <rc> <t>"
    active = False
    try:
        active = subprocess.run([SYSTEMCTL, "is-active", "--quiet", "nav-pi-os-update.service"], timeout=10).returncode == 0
    except Exception:
        pass
    log = _read(os.path.join(STATE_DIR, "os-update.log")).splitlines()[-40:]
    word = st.split()[0] if st else "idle"
    if word == "running" and not active:
        word = "failed"            # the unit died without writing its end state (power cut, kill)
    return {"state": "running" if active else word, "log": "\n".join(log), "reboot": os.path.exists(REBOOT_FILE),
            "at": st.split()[-1] if st else ""}


def os_start(j):
    check_parked(j)
    if os_state()["state"] == "running":
        raise UpdateError("busy")
    if not svc("start", ["nav-pi-os-update"], block=False):
        raise UpdateError("service")
    return {"ok": True}


# ---------------------------------------------------------------- API
def state(h=None, q=None, j=None):
    with LOCK:
        jb = {k: v for k, v in job.items()}
    app_ready = os.path.isdir(os.path.join(DATA, "updates", "app-staged"))
    regs = region_dirs()
    st = load_state()
    cur, prev = current_name(), st.get("previous", "")
    for r in regs:
        r["current"], r["previous"] = r["name"] == cur, r["name"] == prev
        r.pop("mtime", None)
    v = speed_mps()
    return {"job": jb, "regions": regs, "current": cur, "previous": prev if any(r["name"] == prev for r in regs) else "",
            "free": free_bytes(), "url": url_saved(), "moving": v is not None and v > MOVING_MPS, "appStaged": app_ready,
            "os": os_state()}


def api(fn):
    def wrap(h, q, j):
        try:
            return fn(j or {})
        except UpdateError as e:
            return {"ok": False, "error": e.code, "msg": e.msg}, (409 if e.code in ("driving", "busy") else 400)
    return wrap


def register(app):
    app.get("/api/update/state", state)
    for name, fn in (("scan", lambda j: scan(j.get("url") if "url" in j else None)), ("start", start), ("cancel", cancel_job),
                     ("switch", switch), ("rollback", rollback), ("delete", delete_region), ("apply-app", apply_app),
                     ("os/start", os_start)):
        app.post("/api/update/" + name, api(fn))
