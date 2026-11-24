"""imagery feature: satellite / aerial photo packs (MBTiles) for the map — serve, list, delete, download, USB import.

Packs live in /srv/navdata/imagery/<id>.mbtiles (NAV_IMAGERY overrides). Format: MBTiles, scheme tms, metadata
name/bounds/minzoom/maxzoom/format/attribution; any pack in that format (e.g. made with GDAL or another tile tool)
works as it is. stdlib only (sqlite3, urllib).
  GET  /sat/<id>/<z>/<x>/<y>         one tile (XYZ in, TMS row in the file), Content-Type from the bytes, cached 7 days
  GET  /api/imagery                  {packs:[{id,name,bounds,minzoom,maxzoom,format,attribution,size,mtime}], free, job, unfinished}
  POST /api/imagery/plan {bounds, level}            providers that cover the area + size estimate + fits on the disk
  POST /api/imagery/download {bounds, level, provider, name}   background job (refused while the car moves)
  POST /api/imagery/pause | resume | cancel         the running job
  POST /api/imagery/delete {id}
  GET  /api/imagery/usb              *.mbtiles found on mounted USB sticks (features/usb /api/usb)
  POST /api/imagery/import {path}    copy one of those into the packs, with progress
Downloads: at most 2 requests at once, retries with backoff, User-Agent nav-pi; tiles are the provider's JPEG, stored
without re-encoding; the pack is written to .<id>.mbtiles.part and renamed only when complete (atomic); a paused, failed
or interrupted download keeps its .part and resumes where it stopped."""
import concurrent.futures
import json
import os
import re
import shutil
import sqlite3
import threading
import time
import urllib.error
import urllib.request
import zlib
import struct

import navd_imagery_plan as P

DATA = os.environ.get("NAV_DATA", "/srv/navdata")
DIR = os.environ.get("NAV_IMAGERY", os.path.join(DATA, "imagery"))
UA = "nav-pi/1.0 (offline car navigator; imagery download, max 2 requests at once)"
WORKERS = 2
MOVING = 3.0          # m/s: the car moves -> no downloads / imports (driving safety)
ID_RE = re.compile(r"^[A-Za-z0-9][A-Za-z0-9._-]{0,80}$")
LOCK = threading.RLock()
job = {"state": "idle"}            # idle | running | paused | done | failed | cancelled
ctl = {"pause": threading.Event(), "cancel": threading.Event()}
APP = None
_db = {}                           # path -> (stat key, connection) for serving


def _sleep(s):
    time.sleep(s)


def _fetch(url):
    """GET url -> (bytes, content type); raises OSError. Tests replace FETCH."""
    req = urllib.request.Request(url, headers={"User-Agent": UA})
    with urllib.request.urlopen(req, timeout=40) as r:
        return r.read(), r.headers.get("Content-Type", "")


FETCH = _fetch
SLEEP = _sleep
if os.environ.get("IMAGERY_FAKE_FETCH"):     # UI tests only (tools/ui-imagery.mjs): no network, a blank tile after a delay
    def FETCH(url, _d=float(os.environ["IMAGERY_FAKE_FETCH"])):  # noqa: F811
        time.sleep(_d)
        return EMPTY, "image/png"


def free_bytes():
    os.makedirs(DIR, exist_ok=True)
    return shutil.disk_usage(DIR).free


def ctype(b):
    if b[:4] == b"RIFF" and b[8:12] == b"WEBP":
        return "image/webp"
    if b[:8] == b"\x89PNG\r\n\x1a\n":
        return "image/png"
    if b[:3] == b"\xff\xd8\xff":
        return "image/jpeg"
    return "application/octet-stream"


def _png_empty():
    """a transparent 256x256 PNG (stdlib zlib), sent for a missing tile inside a pack's bounds"""
    def chunk(t, d):
        return struct.pack(">I", len(d)) + t + d + struct.pack(">I", zlib.crc32(t + d) & 0xffffffff)
    raw = b"".join(b"\x00" + b"\x00" * 256 * 4 for _ in range(256))
    return b"\x89PNG\r\n\x1a\n" + chunk(b"IHDR", struct.pack(">IIBBBBB", 256, 256, 8, 6, 0, 0, 0)) + \
        chunk(b"IDAT", zlib.compress(raw, 9)) + chunk(b"IEND", b"")


EMPTY = _png_empty()


def open_ro(path):
    return sqlite3.connect("file:%s?mode=ro" % urllib.request.pathname2url(os.path.abspath(path)), uri=True,
                           check_same_thread=False)


def meta_of(path):
    """pack metadata dict, or None when the file is not a readable MBTiles with tiles"""
    try:
        db = open_ro(path)
        try:
            m = dict(db.execute("SELECT name, value FROM metadata"))
            if not db.execute("SELECT 1 FROM tiles LIMIT 1").fetchone():
                return None
        finally:
            db.close()
    except sqlite3.Error:
        return None
    try:
        b = [float(v) for v in m.get("bounds", "-180,-85,180,85").split(",")]
        if len(b) != 4:
            raise ValueError
        mz = [int(float(m.get("minzoom", 0))), int(float(m.get("maxzoom", 18)))]
    except ValueError:
        return None
    return {"name": m.get("name") or os.path.basename(path), "bounds": b, "minzoom": mz[0], "maxzoom": mz[1],
            "format": m.get("format", ""), "attribution": m.get("attribution", ""), "description": m.get("description", "")}


def packs():
    out = []
    try:
        names = sorted(os.listdir(DIR))
    except OSError:
        return out
    for f in names:
        if not f.endswith(".mbtiles") or f.startswith("."):
            continue
        pid, p = f[:-8], os.path.join(DIR, f)
        if not ID_RE.match(pid):
            continue
        m = meta_of(p)
        if not m:
            continue
        st = os.stat(p)
        m.update(id=pid, size=st.st_size, mtime=int(st.st_mtime))
        out.append(m)
    return out


def conn(pid):
    p = os.path.join(DIR, pid + ".mbtiles")
    try:
        st = os.stat(p)
    except OSError:
        return None
    key = (st.st_ino, st.st_size, st.st_mtime)
    with LOCK:
        c = _db.get(p)
        if c and c[0] == key:
            return c[1]
        if c:
            c[1].close()
        db = open_ro(p)
        _db[p] = (key, db)
        return db


def send_tile(h, data, code=200, cache=True):
    h.send_response(code)
    h.send_header("Content-Type", ctype(data))
    h.send_header("Content-Length", str(len(data)))
    h.send_header("Cache-Control", "public, max-age=604800" if cache else "no-cache")
    # skip navd's own end_headers (it always adds "no-cache"): BaseHTTPRequestHandler's writes the headers out
    from http.server import BaseHTTPRequestHandler
    BaseHTTPRequestHandler.end_headers(h)
    h.wfile.write(data)


def tile_get(h, q, j):
    parts = h.path_only[len("/sat/"):].split("/")
    if len(parts) != 4 or not ID_RE.match(parts[0]):
        return {"error": "bad tile path"}, 404
    try:
        z, x, y = int(parts[1]), int(parts[2]), int(parts[3].split(".")[0])
    except ValueError:
        return {"error": "bad tile path"}, 404
    if not (0 <= z <= 24 and 0 <= x < 2 ** z and 0 <= y < 2 ** z):
        return {"error": "bad tile"}, 404
    db = conn(parts[0])
    if db is None:
        return {"error": "no such pack"}, 404
    try:
        with LOCK:
            row = db.execute("SELECT tile_data FROM tiles WHERE zoom_level=? AND tile_column=? AND tile_row=?",
                             (z, x, 2 ** z - 1 - y)).fetchone()   # MBTiles rows are TMS: counted from the south
    except sqlite3.Error as e:
        return {"error": str(e)}, 500
    send_tile(h, row[0] if row else EMPTY)
    return None


# ---------------- jobs (one at a time: a download or a USB import) ----------------
def moving():
    fn = APP.statuses.get("gps") if APP else None
    try:
        g = fn() if fn else {}
        return g.get("mode", 0) >= 2 and (g.get("speed") or 0) > MOVING
    except Exception:  # noqa: BLE001 — no GPS module / no fix: not moving
        return False


def busy():
    return job.get("state") in ("running", "paused")


def slug(s):
    s = re.sub(r"[^A-Za-z0-9]+", "-", s or "").strip("-").lower()[:40]
    return s or "area"


def unique_id(base):
    pid, i = base, 2
    while os.path.exists(os.path.join(DIR, pid + ".mbtiles")):
        pid = "%s-%d" % (base, i)
        i += 1
    return pid


def part_path(pid):
    return os.path.join(DIR, "." + pid + ".mbtiles.part")


def unfinished():
    """interrupted downloads (a .part with its request saved inside), so they can be resumed or dropped"""
    out = []
    try:
        names = os.listdir(DIR)
    except OSError:
        return out
    for f in names:
        if not (f.startswith(".") and f.endswith(".mbtiles.part")):
            continue
        pid = f[1:-len(".mbtiles.part")]
        if busy() and job.get("id") == pid:
            continue
        try:
            db = sqlite3.connect(os.path.join(DIR, f))
            try:
                r = db.execute("SELECT value FROM metadata WHERE name='navpi_request'").fetchone()
                n = db.execute("SELECT COUNT(*) FROM tiles").fetchone()[0]
            finally:
                db.close()
            req = json.loads(r[0]) if r else None
        except (sqlite3.Error, ValueError):
            req, n = None, 0
        if req:
            out.append({"id": pid, "name": req.get("name"), "provider": req.get("provider"), "level": req.get("level"),
                        "done": n, "total": req.get("tiles")})
    return out


def create_part(path, req):
    db = sqlite3.connect(path, check_same_thread=False)
    db.executescript("""
        CREATE TABLE IF NOT EXISTS metadata (name TEXT PRIMARY KEY, value TEXT);
        CREATE TABLE IF NOT EXISTS tiles (zoom_level INTEGER, tile_column INTEGER, tile_row INTEGER, tile_data BLOB,
            PRIMARY KEY (zoom_level, tile_column, tile_row));
    """)
    with db:
        db.execute("INSERT OR REPLACE INTO metadata VALUES ('navpi_request', ?)", (json.dumps(req),))
    return db


class TileRefused(OSError):
    """the provider refuses or lacks this one tile (400/404 after retries): skip it, the job goes on"""


def get_tile(p, z, x, y):
    """one tile from the provider with retries (2, 4, 8, 16, 30 s); returns JPEG/PNG bytes; raises OSError
    (401/403 = access refused: the job stops) or TileRefused (400/404: one tile; a 400 is retried twice first —
    IGN answered one 400 inside a Paris job on the Pi 2026-11-22 while the same request format works at z12–19)"""
    url = P.tile_url(p, z, x, y, "image/jpeg")
    for attempt in range(6):
        if ctl["cancel"].is_set():
            raise OSError("cancelled")
        try:
            data, ct = FETCH(url)
            if not ct.startswith("image/") or ctype(data) == "application/octet-stream":
                raise OSError("not an image (%s)" % ct)
            return data
        except urllib.error.HTTPError as e:
            if e.code in (401, 403):
                raise OSError("HTTP %d" % e.code)
            if e.code == 404 or (e.code == 400 and attempt >= 2):
                print("imagery: tile %d/%d/%d refused (HTTP %d): %s" % (z, x, y, e.code, url), flush=True)
                raise TileRefused("HTTP %d" % e.code)
            err = e
        except (OSError, ValueError) as e:
            err = e
        if attempt == 5:
            raise OSError(str(err))
        SLEEP(min(30, 2 ** (attempt + 1)))
    raise OSError("unreachable")


def finish(db, path, final, req, p):
    meta = {"name": req["name"], "format": "jpg", "type": "overlay", "version": "1.0", "scheme": "tms",
            "bounds": ",".join(map(str, req["bounds"])), "minzoom": str(req["minzoom"]), "maxzoom": str(req["maxzoom"]),
            "attribution": p["attribution"], "description": "%s · %s detail · downloaded %s by nav-pi" % (
                p["name"], req["level"], time.strftime("%Y-%m-%d"))}
    with db:
        db.executemany("INSERT OR REPLACE INTO metadata VALUES (?, ?)", meta.items())
        db.execute("DELETE FROM metadata WHERE name='navpi_request'")
    if db.execute("PRAGMA quick_check").fetchone()[0] != "ok":
        raise OSError("integrity check failed")
    db.execute("PRAGMA journal_mode=DELETE")
    db.close()
    with open(path, "rb") as f:
        os.fsync(f.fileno())
    os.replace(path, final)                      # atomic: the pack appears complete or not at all
    dfd = os.open(DIR, os.O_RDONLY)
    try:
        os.fsync(dfd)
    finally:
        os.close(dfd)


def download_job(req):
    p = P.BY_ID[req["provider"]]
    path, final = part_path(req["id"]), os.path.join(DIR, req["id"] + ".mbtiles")
    db = create_part(path, req)
    try:
        have = set(db.execute("SELECT zoom_level, tile_column, tile_row FROM tiles"))
        todo = [t for t in P.tiles(req["bounds"], req["minzoom"], req["maxzoom"], p["outlines"])
                if (t[0], t[1], 2 ** t[0] - 1 - t[2]) not in have]
        job.update(done=req["tiles"] - len(todo), total=req["tiles"], bytes=0, skipped=0)
        max_skip = max(20, req["tiles"] // 50)   # a few refused tiles leave holes; more means the provider is unwell
        it = iter(todo)
        with concurrent.futures.ThreadPoolExecutor(max_workers=WORKERS) as pool:
            active = {}
            while True:
                while len(active) < WORKERS and not ctl["pause"].is_set() and not ctl["cancel"].is_set():
                    t = next(it, None)
                    if t is None:
                        break
                    active[pool.submit(get_tile, p, *t)] = t
                if not active:
                    if ctl["cancel"].is_set() or not ctl["pause"].is_set():
                        break
                    job["state"] = "paused"
                    time.sleep(0.2)
                    continue
                done, _ = concurrent.futures.wait(list(active), timeout=1, return_when=concurrent.futures.FIRST_COMPLETED)
                for f in done:
                    z, x, y = active.pop(f)
                    try:
                        data = f.result()         # raises after the retries: the job fails, the .part stays
                    except TileRefused:
                        job["skipped"] += 1       # a hole (transparent on the map); a resume asks for it again
                        if job["skipped"] > max_skip:
                            raise OSError("the provider refused %d tiles" % job["skipped"])
                        continue
                    with db:
                        db.execute("INSERT OR REPLACE INTO tiles VALUES (?, ?, ?, ?)", (z, x, 2 ** z - 1 - y, data))
                    job["done"] += 1
                    job["bytes"] += len(data)
                if job["state"] == "paused" and not ctl["pause"].is_set():
                    job["state"] = "running"
                if free_bytes() < P.RESERVE:
                    raise OSError("disk full")
        if ctl["cancel"].is_set():
            db.close()
            os.unlink(path)
            job.update(state="cancelled")
            return
        finish(db, path, final, req, p)
        job.update(state="done", pack=req["id"])
    except Exception as e:  # noqa: BLE001 — any failure ends the job, the .part keeps the progress
        try:
            db.close()
        except sqlite3.Error:
            pass
        if ctl["cancel"].is_set():
            try:
                os.unlink(path)
            except OSError:
                pass
            job.update(state="cancelled")
        else:
            job.update(state="failed", error=offline_reason(e))


def offline_reason(e):
    s = str(e)
    if "disk full" in s:
        return "disk"
    if any(k in s for k in ("Name or service", "Temporary failure", "Network is unreachable", "No route", "timed out",
                            "getaddrinfo", "urlopen error")):
        return "offline"
    return s[:160]


def start(kind, target, **info):
    ctl["pause"].clear()
    ctl["cancel"].clear()
    job.clear()
    job.update(dict(dict(done=0, total=0, bytes=0), **info), state="running", kind=kind, started=time.time())
    threading.Thread(target=target, daemon=True).start()


def api_list(h, q, j):
    try:
        free = free_bytes()
    except OSError:
        free = None
    return {"packs": packs(), "free": free, "job": dict(job), "unfinished": unfinished(),
            "providers": [{k: p[k] for k in ("id", "name", "license", "nc")} for p in P.PROVIDERS]}


def api_plan(h, q, j):
    try:
        b, opts = P.plan(j.get("bounds"), j.get("level", "standard"), free_bytes())
    except ValueError as e:
        return {"error": str(e)}, 400
    return {"bounds": b, "options": opts, "free": free_bytes()}


def api_download(h, q, j):
    if moving():
        return {"error": "driving"}, 409
    with LOCK:
        if busy():
            return {"error": "busy"}, 409
        resume = j.get("resume")
        if resume:
            u = next((x for x in unfinished() if x["id"] == resume), None)
            if not u:
                return {"error": "unknown"}, 404
            db = sqlite3.connect(part_path(resume))
            req = json.loads(db.execute("SELECT value FROM metadata WHERE name='navpi_request'").fetchone()[0])
            db.close()
        else:
            try:
                b, opts = P.plan(j.get("bounds"), j.get("level", "standard"), free_bytes())
            except ValueError as e:
                return {"error": str(e)}, 400
            o = next((x for x in opts if x["id"] == j.get("provider")), None) or (opts[0] if opts and not j.get("provider") else None)
            if not o:
                return {"error": "provider"}, 400
            if o["too_big"]:
                return {"error": "too_big"}, 400
            if not o["fits"]:
                return {"error": "space", "need": o["need_bytes"], "free": free_bytes()}, 400
            name = str(j.get("name") or "").strip()[:60] or "%s %.3f %.3f" % (o["name"].split(" (")[0], (b[1] + b[3]) / 2, (b[0] + b[2]) / 2)
            req = {"id": unique_id(slug(name) + "-" + o["id"]), "name": name, "bounds": b, "level": j.get("level", "standard"),
                   "provider": o["id"], "minzoom": o["minzoom"], "maxzoom": o["maxzoom"], "tiles": o["tiles"]}
        os.makedirs(DIR, exist_ok=True)
        start("download", lambda: download_job(req), id=req["id"], name=req["name"], provider=req["provider"],
              level=req["level"], total=req["tiles"])
    return {"ok": True, "id": req["id"]}


def api_pause(h, q, j):
    if job.get("state") == "running":
        ctl["pause"].set()
        job["state"] = "paused"
    return {"ok": True, "job": dict(job)}


def api_resume(h, q, j):
    if moving():
        return {"error": "driving"}, 409
    if job.get("state") == "paused":
        ctl["pause"].clear()
        job["state"] = "running"
    return {"ok": True, "job": dict(job)}


def api_cancel(h, q, j):
    if busy():
        ctl["cancel"].set()
        ctl["pause"].clear()
        return {"ok": True}
    drop = j.get("drop")                      # an unfinished download from before: delete its .part
    if drop and ID_RE.match(drop) and os.path.exists(part_path(drop)):
        os.unlink(part_path(drop))
        return {"ok": True}
    return {"ok": False, "error": "idle"}


def api_delete(h, q, j):
    pid = j.get("id")
    if not isinstance(pid, str) or not ID_RE.match(pid):
        return {"error": "bad id"}, 400
    p = os.path.join(DIR, pid + ".mbtiles")
    if not os.path.exists(p):
        return {"error": "unknown"}, 404
    with LOCK:
        c = _db.pop(p, None)
        if c:
            c[1].close()
        os.unlink(p)
    return {"ok": True}


# ---------------- USB import (an .mbtiles file carried on a stick) ----------------
def sticks():
    fn = APP.routes.get(("GET", "/api/usb")) if APP else None
    if not fn:
        return []
    try:
        return fn(None, {}, {}) or []
    except Exception:  # noqa: BLE001
        return []


def usb_files():
    out = []
    for s in sticks():
        root = s.get("path")
        if not root or not os.path.isdir(root):
            continue
        seen = 0
        for d, dirs, files in os.walk(root):
            dirs[:] = [x for x in dirs if not x.startswith(".") and x not in ("System Volume Information", "$RECYCLE.BIN")
                       and d[len(root):].count(os.sep) < 3]
            for f in files:
                seen += 1
                if f.lower().endswith(".mbtiles") and not f.startswith("."):
                    p = os.path.join(d, f)
                    m = meta_of(p)
                    if m and not os.path.islink(p):
                        m.update(path=p, size=os.path.getsize(p), stick=s.get("label"))
                        out.append(m)
            if seen > 5000:
                break
    return out


def import_job(src, pid, size):
    dst, final = part_path(pid), os.path.join(DIR, pid + ".mbtiles")
    try:
        with open(src, "rb") as a, open(dst, "wb") as b:
            while True:
                if ctl["cancel"].is_set():
                    raise OSError("cancelled")
                while ctl["pause"].is_set() and not ctl["cancel"].is_set():
                    time.sleep(0.2)
                chunk = a.read(4 << 20)
                if not chunk:
                    break
                b.write(chunk)
                job["done"] += len(chunk)
            b.flush()
            os.fsync(b.fileno())
        if job["done"] != size or not meta_of(dst):
            raise OSError("copy incomplete or not a pack")
        os.replace(dst, final)
        job.update(state="done", pack=pid)
    except OSError as e:
        try:
            os.unlink(dst)
        except OSError:
            pass
        job.update(state="cancelled" if ctl["cancel"].is_set() else "failed", error=str(e)[:160])


def api_usb(h, q, j):
    return {"files": usb_files()}


def api_import(h, q, j):
    if moving():
        return {"error": "driving"}, 409
    src = j.get("path")
    f = next((x for x in usb_files() if x["path"] == src), None)   # only a file the stick scan found
    if not f:
        return {"error": "unknown"}, 404
    with LOCK:
        if busy():
            return {"error": "busy"}, 409
        if free_bytes() < f["size"] + P.RESERVE:
            return {"error": "space", "need": f["size"] + P.RESERVE, "free": free_bytes()}, 400
        os.makedirs(DIR, exist_ok=True)
        pid = unique_id(slug(os.path.basename(src)[:-8]))
        start("import", lambda: import_job(src, pid, f["size"]), id=pid, name=f["name"], total=f["size"])
    return {"ok": True, "id": pid}


def register(app):
    global APP
    APP = app
    app.get_prefix("/sat/", tile_get)   # not /imagery/: that is this feature's app folder (imagery.js)
    app.get("/api/imagery", api_list)
    app.get("/api/imagery/usb", api_usb)
    for name, fn in (("plan", api_plan), ("download", api_download), ("pause", api_pause), ("resume", api_resume),
                     ("cancel", api_cancel), ("delete", api_delete), ("import", api_import)):
        app.post("/api/imagery/" + name, fn)
    app.status("imagery", lambda: {"packs": len(packs()), "job": job.get("state")})
