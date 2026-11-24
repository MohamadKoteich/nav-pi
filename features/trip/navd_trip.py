"""trip feature: trip computer (Trip A auto-resets after 4 h parked, Trip B manual) and trip log (PN-49, PN-50).
Real GPS only (own gpsd watch). Simulated drives are ignored unless the test flag NAV_TRIP_SIM=1 is set (then they
count and are logged tagged "sim"; off on the Pi). Each drive is recorded 1 point / 2 s to NAV_DATA/trips/<id>.jsonl
(header line, [t,lat,lon,speed] lines, a final {"end":..} summary line); pruned to the last TRIP_KEEP trips and
TRIP_MAX_MB. GPX: GET /api/trips/<id>.gpx, or POST /api/trips/export {id, dir} to a mounted /media/* dir.
Env (tests): NAV_DATA, TRIP_END_IDLE (s), GPSD_HOST/GPSD_PORT, NAV_TRIP_SIM, TRIP_MEDIA (root of the USB mounts, default /media)."""
import glob, json, math, os, re, socket, threading, time  # noqa: F401,E401
from xml.sax.saxutils import escape

DATA = os.environ.get("NAV_DATA", "/srv/navdata")
DIR = os.path.join(DATA, "trips")
GPSD = (os.environ.get("GPSD_HOST", "127.0.0.1"), int(os.environ.get("GPSD_PORT", "2947")))
SIM_OK = os.environ.get("NAV_TRIP_SIM") == "1"
MEDIA = os.environ.get("TRIP_MEDIA", "/media")
KEEP, MAX_BYTES = int(os.environ.get("TRIP_KEEP", "100")), int(os.environ.get("TRIP_MAX_MB", "50")) * 1e6
STOP_V, JITTER_M = 1.5, 12.0       # below 1.5 m/s and within 12 m of the anchor = standing still (GPS jitter)
MAX_V = 80.0                       # m/s (288 km/h): faster = a bad fix, ignored
MAX_GAP = 30.0                     # s without a fix: the gap adds no time/distance (tunnel)
PARK_RESET = 4 * 3600              # Trip A starts again after 4 h without moving
END_IDLE = int(os.environ.get("TRIP_END_IDLE", "600"))                    # a recorded drive ends after 10 min standing
LOG_EVERY = 2.0
MIN_TRIP_M, MIN_TRIP_S = 300, 60   # shorter drives are not kept
lock = threading.RLock()


def hav(a, b):
    """metres between (lat, lon) points"""
    p1, p2 = math.radians(a[0]), math.radians(b[0])
    h = math.sin((p2 - p1) / 2) ** 2 + math.cos(p1) * math.cos(p2) * math.sin(math.radians(b[1] - a[1]) / 2) ** 2
    return 12742000 * math.asin(math.sqrt(h))


class Counter:
    """distance m, driving seconds, max m/s since reset; stand-still jitter and bad fixes ignored"""
    def __init__(self, d=None):
        d = d or {}
        self.dist, self.drive, self.vmax = d.get("dist", 0.0), d.get("drive", 0.0), d.get("vmax", 0.0)
        self.since = d.get("since", time.time())
        self.moved_t = d.get("moved_t")       # time of the last movement
        self.last_t = self.last_p = None      # last fix = anchor of the standing-still test

    def feed(self, t, lat, lon, v):
        """returns True when this fix counts as moving"""
        p = (lat, lon)
        if self.last_p is None or t - self.last_t > MAX_GAP or t < self.last_t:
            self.last_t, self.last_p = t, p
            return False
        dt, d = t - self.last_t, hav(self.last_p, p)
        if v < STOP_V and d < JITTER_M:
            self.last_t = t                    # standing: the anchor stays, nothing counts
            return False
        if v > MAX_V or d / max(dt, .01) > MAX_V:
            self.last_t = t                    # bad fix
            return False
        self.dist += d
        self.drive += dt
        self.vmax = max(self.vmax, v)
        self.last_t, self.last_p, self.moved_t = t, p, t
        return True

    def view(self):
        return {"dist": round(self.dist), "drive": round(self.drive), "vmax": round(self.vmax * 3.6, 1),
                "avg": round(self.dist / self.drive * 3.6, 1) if self.drive > 5 else 0.0, "since": self.since}

    def save(self):
        return {"dist": self.dist, "drive": self.drive, "vmax": self.vmax, "since": self.since, "moved_t": self.moved_t}


def gpx(points, name="nav-pi trip"):
    """points: [[t, lat, lon, speed m/s], ...] -> GPX 1.1 text"""
    out = ['<?xml version="1.0" encoding="UTF-8"?>',
           '<gpx version="1.1" creator="nav-pi" xmlns="http://www.topografix.com/GPX/1/1"><trk><name>%s</name><trkseg>' % escape(name)]
    for t, la, lo, v in points:
        out.append('<trkpt lat="%.6f" lon="%.6f"><time>%s</time><extensions><speed>%.1f</speed></extensions></trkpt>'
                   % (la, lo, time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime(t)), v))
    out.append("</trkseg></trk></gpx>")
    return "\n".join(out) + "\n"


class Trips:
    def __init__(self):
        self.moving = False
        self.rec = None                # current recording: {id, path, c, last, idle_t, sim, names}
        self.names = {}                # destination names offered by the app: {from, to}
        os.makedirs(DIR, exist_ok=True)
        try:
            with open(os.path.join(DIR, "state.json")) as f:
                s = json.load(f)
        except (OSError, ValueError):
            s = {}
        self.a, self.b = Counter(s.get("a")), Counter(s.get("b"))
        if self.a.moved_t and time.time() - self.a.moved_t > PARK_RESET:
            self.a = Counter()
        for f in glob.glob(os.path.join(DIR, "*.jsonl")):     # a drive cut off by power loss: close it
            if not self.read(f)[2]:
                self.finish_file(f)

    def save(self):
        tmp = os.path.join(DIR, "state.json.tmp")
        with open(tmp, "w") as f:
            json.dump({"a": self.a.save(), "b": self.b.save()}, f)
        os.replace(tmp, os.path.join(DIR, "state.json"))

    def reset(self, which):
        with lock:
            if which not in ("a", "b"):
                return False
            setattr(self, which, Counter())
            self.save()
            return True

    def feed(self, t, lat, lon, v, src="gps"):
        if src == "sim" and not SIM_OK:
            return
        with lock:
            if self.a.moved_t and t - self.a.moved_t > PARK_RESET:
                self.a = Counter()             # parked 4 h: Trip A starts again
            mv = self.a.feed(t, lat, lon, v)
            self.b.feed(t, lat, lon, v)
            self.moving = mv
            self.record(t, lat, lon, v, mv, src)
            if int(t) % 10 == 0:
                self.save()

    def record(self, t, lat, lon, v, mv, src):
        r = self.rec
        if r is None:
            if not mv:
                return
            os.makedirs(DIR, exist_ok=True)
            tid = time.strftime("%Y%m%d-%H%M%S", time.localtime(t)) + ("-sim" if src == "sim" else "")
            r = self.rec = {"id": tid, "path": os.path.join(DIR, tid + ".jsonl"), "last": 0, "idle_t": t, "sim": src == "sim",
                            "names": self.names}
            with open(r["path"], "w") as f:
                f.write(json.dumps({"id": tid, "start": t, "sim": r["sim"]}) + "\n")
        if mv:
            r["idle_t"] = t
        if t - r["last"] >= LOG_EVERY:
            r["last"] = t
            with open(r["path"], "a") as f:
                f.write(json.dumps([round(t, 1), round(lat, 6), round(lon, 6), round(v, 1)]) + "\n")
        if t - r["idle_t"] > END_IDLE:
            self.stop_rec()

    def stop_rec(self):
        r, self.rec = self.rec, None
        if r:
            self.finish_file(r["path"], r["names"])
            self.names = {}
            self.prune()

    def tick(self, t):
        """no fixes for a while (receiver lost): end an idle drive"""
        with lock:
            if self.rec and t - self.rec["idle_t"] > END_IDLE:
                self.stop_rec()
            if self.a.last_t is None or t - self.a.last_t > 5:
                self.moving = False

    def dest(self, frm, to):
        with lock:
            self.names.update({k: v for k, v in (("from", frm), ("to", to)) if v})

    # ---- files
    def read(self, path):
        head, pts, end = {}, [], {}
        try:
            with open(path) as f:
                for i, line in enumerate(f):
                    try:
                        o = json.loads(line)
                    except ValueError:
                        continue
                    if i == 0:
                        head = o
                    elif isinstance(o, list):
                        pts.append(o)
                    else:
                        end = o
        except OSError:
            pass
        return head, pts, end

    def finish_file(self, path, names=None):
        h, pts, _ = self.read(path)
        c = Counter()
        for t, la, lo, v in pts:
            c.feed(t, la, lo, v)
        if len(pts) < 2 or c.dist < MIN_TRIP_M or c.drive < MIN_TRIP_S:
            try:
                os.remove(path)
            except OSError:
                pass
            return
        names = names or {}
        end = {"end": pts[-1][0], "dist": round(c.dist), "drive": round(c.drive), "dur": round(pts[-1][0] - pts[0][0]),
               "vmax": round(c.vmax * 3.6, 1), "avg": round(c.dist / c.drive * 3.6, 1) if c.drive else 0,
               "from": names.get("from"), "to": names.get("to"), "from_xy": pts[0][1:3], "to_xy": pts[-1][1:3], "n": len(pts)}
        with open(path, "a") as f:
            f.write(json.dumps(end) + "\n")

    def listing(self):
        out = []
        for f in sorted(glob.glob(os.path.join(DIR, "*.jsonl")), reverse=True):
            h, _, end = self.read(f)
            if end:                            # no summary yet = still recording
                out.append(dict(end, id=h.get("id"), start=h.get("start"), sim=bool(h.get("sim"))))
        return out

    def prune(self):
        total = 0
        for i, f in enumerate(sorted(glob.glob(os.path.join(DIR, "*.jsonl")), reverse=True)):
            total += os.path.getsize(f)
            if i >= KEEP or total > MAX_BYTES:
                try:
                    os.remove(f)
                except OSError:
                    pass

    def path(self, tid):
        if not re.fullmatch(r"[0-9]{8}-[0-9]{6}(-sim)?", tid or ""):
            return None
        p = os.path.join(DIR, tid + ".jsonl")
        return p if os.path.exists(p) else None


_T = None


def trips():
    global _T
    with lock:
        if _T is None:
            _T = Trips()
        return _T


def gps_loop():
    """own gpsd watch (no dependency on the gps module)"""
    t = trips()
    while True:
        try:
            with socket.create_connection(GPSD, timeout=5) as s:
                s.settimeout(10)
                s.sendall(b'?WATCH={"enable":true,"json":true}\n')
                f = s.makefile("r", encoding="utf-8", errors="replace")
                while True:
                    try:
                        line = f.readline()
                    except socket.timeout:
                        t.tick(time.time())
                        continue
                    if not line:
                        break
                    try:
                        m = json.loads(line)
                    except ValueError:
                        continue
                    if m.get("class") == "TPV" and m.get("mode", 0) >= 2 and "lat" in m:
                        t.feed(time.time(), m["lat"], m["lon"], m.get("speed") or 0.0)
        except OSError:
            time.sleep(3)


def media_dirs():
    return sorted(d for d in glob.glob(os.path.join(MEDIA, "*")) + glob.glob(os.path.join(MEDIA, "*", "*"))
                  if os.path.isdir(d) and os.access(d, os.W_OK))[:12]


def current(h, q, j):
    t = trips()
    t.tick(time.time())
    with lock:
        return {"a": t.a.view(), "b": t.b.view(), "moving": t.moving, "recording": bool(t.rec),
                "simFeed": SIM_OK, "media": media_dirs()}


def feed(h, q, j):
    """simulated positions from the app; counted only with the test flag NAV_TRIP_SIM=1"""
    try:
        trips().feed(time.time(), float(j["lat"]), float(j["lng"]), float(j.get("speed") or 0), "sim")
    except (KeyError, ValueError, TypeError):
        return {"error": "bad point"}, 400
    return {"ok": SIM_OK}


def reset(h, q, j):
    return {"ok": True} if trips().reset(j.get("which")) else ({"error": "which = a|b"}, 400)


def dest(h, q, j):
    trips().dest(j.get("from"), j.get("to"))
    return {"ok": True}


def lst(h, q, j):
    return {"trips": trips().listing()}


def one(h, q, j):
    """GET /api/trips/<id>.json | <id>.gpx | media"""
    t = trips()
    name = h.path_only[len("/api/trips/"):]
    if name == "media":
        return {"dirs": media_dirs()}
    m = re.fullmatch(r"(.+)\.(json|gpx)", name)
    p = t.path(m.group(1)) if m else None
    if not p:
        return {"error": "no such trip"}, 404
    head, pts, end = t.read(p)
    if m.group(2) == "json":
        return {"id": head.get("id"), "points": pts, "sum": end}
    body = gpx(pts, "nav-pi " + time.strftime("%Y-%m-%d %H:%M", time.localtime(head.get("start", 0)))).encode()
    h.send_response(200)
    h.send_header("Content-Type", "application/gpx+xml")
    h.send_header("Content-Disposition", 'attachment; filename="%s.gpx"' % head.get("id"))
    h.send_header("Content-Length", str(len(body)))
    h.end_headers()
    h.wfile.write(body)


def delete(h, q, j):
    p = trips().path(j.get("id"))
    if p:
        os.remove(p)
    return {"ok": bool(p)}


def export(h, q, j):
    """write <id>.gpx into one of the mounted /media dirs (the user picks it)"""
    t = trips()
    p, d = t.path(j.get("id")), os.path.realpath(j.get("dir") or "")
    if not p:
        return {"error": "no such trip"}, 404
    if d not in [os.path.realpath(x) for x in media_dirs()]:
        return {"error": "not a mounted drive"}, 400
    head, pts, _ = t.read(p)
    out = os.path.join(d, head["id"] + ".gpx")
    try:
        with open(out, "w") as f:
            f.write(gpx(pts, "nav-pi " + head["id"]))
    except OSError as e:
        return {"error": str(e)}, 500
    return {"ok": True, "path": out}


def register(app):
    app.thread(gps_loop)
    app.get("/api/trip", current)
    app.post("/api/trip/feed", feed)
    app.post("/api/trip/reset", reset)
    app.post("/api/trip/dest", dest)
    app.get("/api/trips", lst)
    app.get_prefix("/api/trips/", one)
    app.post("/api/trips/delete", delete)
    app.post("/api/trips/export", export)
