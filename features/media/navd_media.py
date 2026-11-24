"""media feature: local library (Music, Audiobooks, Podcasts folders under DATA/media), file serving
with HTTP Range (seeking), and control of a phone that plays to the Pi over Bluetooth (AVRCP via BlueZ
MediaPlayer1 on D-Bus, through busctl)."""
import json
import os
import re
import subprocess

DATA = os.environ.get("NAV_DATA", "/srv/navdata")
ROOT = os.path.join(DATA, "media")
SOURCES = ("Music", "Audiobooks", "Podcasts")
AUDIO = (".mp3", ".m4a", ".m4b", ".aac", ".ogg", ".oga", ".opus", ".flac", ".wav")
CTYPE = {".mp3": "audio/mpeg", ".m4a": "audio/mp4", ".m4b": "audio/mp4", ".aac": "audio/aac", ".ogg": "audio/ogg",
         ".oga": "audio/ogg", ".opus": "audio/ogg", ".flac": "audio/flac", ".wav": "audio/wav"}


def natural(s):
    return [int(t) if t.isdigit() else t.lower() for t in re.split(r"(\d+)", s)]


def safe(src, rel):
    if src not in SOURCES:
        return None
    base = os.path.realpath(os.path.join(ROOT, src))
    p = os.path.realpath(os.path.join(base, rel or ""))
    return p if p == base or p.startswith(base + os.sep) else None


def count_audio(d):
    n = 0
    for _, _, fs in os.walk(d):
        n += sum(1 for f in fs if f.lower().endswith(AUDIO))
    return n


def listing(h, q, j):
    src, rel = q.get("src", ["Music"])[0], q.get("path", [""])[0]
    p = safe(src, rel)
    if not p or not os.path.isdir(p):
        return {"src": src, "path": rel, "dirs": [], "files": []}
    dirs, files = [], []
    for name in sorted(os.listdir(p), key=natural):
        if name.startswith("."):
            continue
        full = os.path.join(p, name)
        r = os.path.relpath(full, safe(src, ""))
        if os.path.isdir(full):
            n = count_audio(full)
            if n:
                dirs.append({"name": name, "path": r, "count": n})
        elif name.lower().endswith(AUDIO):
            files.append({"name": os.path.splitext(name)[0], "path": r, "size": os.path.getsize(full)})
    return {"src": src, "path": rel, "dirs": dirs, "files": files}


def summary(h, q, j):
    return {s: count_audio(os.path.join(ROOT, s)) for s in SOURCES}


def serve(h, q, j):
    from urllib.parse import unquote
    parts = unquote(h.path_only[len("/api/media/file/"):]).split("/", 1)
    p = safe(parts[0], parts[1] if len(parts) > 1 else "")
    if not p or not os.path.isfile(p):
        return {"error": "not found"}, 404
    size = os.path.getsize(p)
    start, end = 0, size - 1
    rng = h.headers.get("Range")
    m = re.match(r"bytes=(\d*)-(\d*)$", rng or "")
    if m and (m.group(1) or m.group(2)):
        try:
            if m.group(1):
                start = int(m.group(1))
                end = int(m.group(2)) if m.group(2) else end
            else:  # suffix range: last N bytes
                start = max(0, size - int(m.group(2)))
        except ValueError:
            start, end = 0, size - 1
        end = min(end, size - 1)
        if start >= size or start > end:
            h.send_response(416)
            h.send_header("Content-Range", "bytes */%d" % size)
            h.send_header("Content-Length", "0")
            h.end_headers()
            return None
        h.send_response(206)
        h.send_header("Content-Range", "bytes %d-%d/%d" % (start, end, size))
    else:
        h.send_response(200)
    h.send_header("Content-Type", CTYPE.get(os.path.splitext(p)[1].lower(), "application/octet-stream"))
    h.send_header("Accept-Ranges", "bytes")
    h.send_header("Content-Length", str(end - start + 1))
    h.end_headers()
    try:
        with open(p, "rb") as f:
            f.seek(start)
            left = end - start + 1
            while left > 0:
                chunk = f.read(min(left, 256 * 1024))
                if not chunk:
                    break
                h.wfile.write(chunk)
                left -= len(chunk)
    except (BrokenPipeError, ConnectionResetError):
        pass
    return None


# ---- phone over Bluetooth: AVRCP through BlueZ MediaPlayer1 ----
def busctl(*args):
    try:
        return subprocess.run(["busctl", "--system", "--json=short", *args], capture_output=True, text=True, timeout=5).stdout
    except Exception:
        return ""


def players():
    try:
        out = subprocess.run(["busctl", "--system", "tree", "--list", "org.bluez"], capture_output=True, text=True, timeout=5).stdout
    except (OSError, subprocess.TimeoutExpired):
        return []
    return [l.strip() for l in out.splitlines() if re.search(r"/dev_[0-9A-F_]+/player\d+$", l.strip())]


def prop(path, name):
    out = busctl("get-property", "org.bluez", path, "org.bluez.MediaPlayer1", name)
    try:
        return json.loads(out)["data"]
    except (ValueError, KeyError):
        return None


def phone(h, q, j):
    ps = players()
    if not ps:
        return {"connected": False}
    path = ps[0]
    track = prop(path, "Track") or {}
    val = lambda k: (track.get(k) or {}).get("data")  # noqa: E731
    dev = path.rsplit("/", 1)[0]
    name = None
    try:
        name = json.loads(busctl("get-property", "org.bluez", dev, "org.bluez.Device1", "Alias"))["data"]
    except (ValueError, KeyError):
        pass
    return {"connected": True, "device": name, "status": prop(path, "Status"), "position": prop(path, "Position"),
            "title": val("Title"), "artist": val("Artist"), "album": val("Album"), "duration": val("Duration")}


def phone_cmd(h, q, j, cmd):
    ps = players()
    if not ps:
        return {"error": "no phone playing"}, 404
    busctl("call", "org.bluez", ps[0], "org.bluez.MediaPlayer1", cmd)
    return {"ok": True}


def register(app):
    for s in SOURCES:
        os.makedirs(os.path.join(ROOT, s), exist_ok=True)
    app.get("/api/media/list", listing)
    app.get("/api/media/summary", summary)
    app.get_prefix("/api/media/file/", serve)   # NOT /media/: that is where the app's own media.js lives
    app.get("/api/media/phone", phone)
    for c in ("Play", "Pause", "Next", "Previous"):
        app.post("/api/media/phone/" + c.lower(), lambda h, q, j, c=c: phone_cmd(h, q, j, c))
