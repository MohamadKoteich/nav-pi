#!/usr/bin/env python3
"""nav-pi local service, core — the only process the head-unit app talks to (Python stdlib only).

The core serves the app and /api/status, and loads one module per feature of the installed
edition (edition.json "features" -> navd_<feature>.py next to this file). Modules register routes:
    def register(app):
        app.get("/api/x", fn)  app.post(...)  app.get_prefix("/tiles/", fn)
        app.thread(loop_fn)    app.status("key", fn)
    fn(handler, query_dict, json_body) -> object (sent as JSON) | (object, status) | None (handler replied)
Everything binds to 127.0.0.1: nothing on the Pi is reachable from the network.
"""
import importlib.util
import json
import os
import sys
import threading
import urllib.error
import urllib.request
from http.server import SimpleHTTPRequestHandler, ThreadingHTTPServer
from urllib.parse import parse_qs, urlparse

HERE = os.path.dirname(os.path.abspath(__file__))
APP_DIR = os.environ.get("APP_DIR", os.path.join(HERE, "app"))
EDITION_FILE = os.environ.get("EDITION_FILE", os.path.join(HERE, "edition.json"))
PORT = int(os.environ.get("NAV_PORT", "8080"))
BIND = os.environ.get("NAV_BIND", "127.0.0.1")
DATA = os.environ.get("NAV_DATA", "/srv/navdata")
DEFAULT_REGION = "europe"


def region():
    """The region the Pi serves: NAV_REGION if set, else the folder /srv/navdata/current links to
    (set by scripts/21-push-data.sh when a region's data is verified), else europe."""
    r = os.environ.get("NAV_REGION")
    link = os.path.join(DATA, "current")
    if not r and os.path.islink(link):
        r = os.path.basename(os.path.realpath(link))
    return r or DEFAULT_REGION


def region_view(name):
    """Default map view (no last position) from the region's bounding box in map/BUILD-INFO:
    {"bbox": [W,S,E,N], "center": [lon, lat], "zoom": z} — None when the map has no bbox."""
    try:
        text = open(os.path.join(DATA, name, "map", "BUILD-INFO")).read()
        w, s, e, n = [float(v) for v in text.split("bbox=", 1)[1].split()[0].split(",")]
    except (OSError, IndexError, ValueError):
        return None
    import math
    zoom = math.log2(900 * 360 / (512 * max(e - w, 0.01)))  # ~900 px across the box (720-1280 px screens)
    return {"bbox": [w, s, e, n], "center": [round((w + e) / 2, 3), round((s + n) / 2, 3)],
            "zoom": round(max(1.0, min(zoom, 12.0)), 2)}


class App:
    def __init__(self):
        self.routes, self.prefixes, self.threads, self.statuses = {}, [], [], {}

    def get(self, path, fn): self.routes[("GET", path)] = fn
    def post(self, path, fn): self.routes[("POST", path)] = fn
    def get_prefix(self, prefix, fn): self.prefixes.append((prefix, fn))
    def thread(self, fn): self.threads.append(fn)
    def status(self, key, fn): self.statuses[key] = fn


APP = App()
EDITION = {"name": "dev", "features": []}


def load_modules():
    global EDITION
    try:
        EDITION = json.load(open(EDITION_FILE))
    except (OSError, ValueError) as e:
        print("no edition file (%s): only the core runs" % e, flush=True)
    for feat in EDITION.get("features", []):
        path = os.path.join(HERE, "navd_%s.py" % feat)
        if not os.path.exists(path):
            continue  # feature without a service part (pure app feature)
        spec = importlib.util.spec_from_file_location("navd_" + feat, path)
        mod = importlib.util.module_from_spec(spec)
        spec.loader.exec_module(mod)
        mod.register(APP)
        print("module:", feat, flush=True)


def probe(h, q, j):  # performance probe results (app ?probe=1) -> journal + file
    line = h.raw_body.decode("utf-8", "replace")[:2000]
    print("PROBE", line, flush=True)
    with open("/tmp/nav-pi-probe.log", "a") as f:
        f.write(line + "\n")
    return {"ok": True}


def edition_js(h, q, j):
    """app/edition.js with the runtime region added (the build writes a static one without it)"""
    ed = dict(EDITION, region=os.environ["NAV_REGION"], regionView=region_view(os.environ["NAV_REGION"]))
    return h.send_bytes(("window.EDITION = %s;\n" % json.dumps(ed)).encode(), "application/javascript")


def status(h, q, j):
    out = {"edition": EDITION}
    for k, fn in APP.statuses.items():
        try:
            out[k] = fn()
        except Exception as e:
            out[k] = "error: %s" % e
    return out


class QuietServer(ThreadingHTTPServer):
    def handle_error(self, request, client_address):
        if isinstance(sys.exc_info()[1], (BrokenPipeError, ConnectionResetError)):
            return   # client dropped mid-response (also from finish()): no traceback
        super().handle_error(request, client_address)


class Handler(SimpleHTTPRequestHandler):
    server_version = "nav-pi"

    def __init__(self, *a, **kw):
        super().__init__(*a, directory=APP_DIR, **kw)

    def handle(self):
        try:
            super().handle()
        except (BrokenPipeError, ConnectionResetError):
            pass   # the client (Chromium) dropped mid-response: nothing to report

    def log_message(self, fmt, *args):
        if os.environ.get("NAV_LOG"):
            super().log_message(fmt, *args)

    def end_headers(self):
        self.send_header("Cache-Control", "no-cache")
        super().end_headers()

    # helpers for modules
    def send_bytes(self, b, ctype, code=200):
        self.send_response(code)
        self.send_header("Content-Type", ctype)
        self.send_header("Content-Length", str(len(b)))
        self.end_headers()
        self.wfile.write(b)

    def send_json(self, obj, code=200):
        self.send_bytes(json.dumps(obj).encode(), "application/json", code)

    def proxy(self, url, body=None):
        req = urllib.request.Request(url, data=body or None, headers={"Content-Type": "application/json"} if body else {})
        try:
            with urllib.request.urlopen(req, timeout=30) as r:
                data, code, headers = r.read(), r.status, r.headers
        except urllib.error.HTTPError as e:
            data, code, headers = e.read(), e.code, e.headers
        except OSError as e:
            return self.send_json({"error": "upstream unavailable: %s" % e}, 502)
        self.send_response(code)
        for hname in ("Content-Type", "Content-Encoding"):
            if headers.get(hname):
                self.send_header(hname, headers[hname])
        self.send_header("Content-Length", str(len(data)))
        self.end_headers()
        self.wfile.write(data)

    def dispatch(self, method):
        u = urlparse(self.path)
        self.path_only = u.path
        q = parse_qs(u.query)
        n = int(self.headers.get("Content-Length") or 0)
        self.raw_body = self.rfile.read(n) if n else b""
        try:
            j = json.loads(self.raw_body) if self.raw_body and method == "POST" else {}
        except ValueError:
            return self.send_json({"error": "bad json"}, 400)
        fn = APP.routes.get((method, u.path))
        if fn is None and method == "GET":
            fn = next((f for p, f in APP.prefixes if u.path.startswith(p)), None)
        if fn is None:
            if method == "GET" and not u.path.startswith("/api/"):
                return super().do_GET()
            return self.send_json({"error": "not in this edition: %s" % u.path}, 404)
        res = fn(self, q, j if isinstance(j, dict) else {})
        if res is None:
            return
        if isinstance(res, tuple):
            return self.send_json(res[0], res[1])
        return self.send_json(res)

    def do_GET(self):
        self.dispatch("GET")

    def do_POST(self):
        self.dispatch("POST")


def main():
    sys.path.insert(0, HERE)
    APP.get("/api/status", status)
    APP.post("/api/probe", probe)
    APP.get("/edition.js", edition_js)
    os.environ["NAV_REGION"] = region()   # feature modules read it
    load_modules()
    for fn in APP.threads:
        threading.Thread(target=fn, daemon=True).start()
    srv = QuietServer((BIND, PORT), Handler)
    srv.daemon_threads = True
    print("nav-pi navd on http://%s:%d — edition %s: %s — region %s" % (BIND, PORT, EDITION.get("name"), " ".join(EDITION.get("features", [])), os.environ["NAV_REGION"]), flush=True)
    srv.serve_forever()


if __name__ == "__main__":
    main()
