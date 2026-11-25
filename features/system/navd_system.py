"""system feature: storage, data versions, app version, temperature, uptime; restart / shut down; open a terminal on the screen (POST /api/system/terminal, NAV_TERMINAL).
Power actions run `systemctl reboot|poweroff` as the navd user; the setup script installs a polkit rule that
allows exactly these two logind actions for that user (pi/install-runtime.sh). Test overrides (env):
THERMAL_FILE, UPTIME_FILE, NAV_SYSTEMCTL (command used instead of systemctl), NAV_VCGENCMD, PROC_DIR, CPUFREQ_FILE,
NAV_NO_SAMPLER (no background sampling thread)."""
import json, os, re, shutil, subprocess, threading, time  # noqa: F401,E401

DATA = os.environ.get("NAV_DATA", "/srv/navdata")
REGION = os.environ.get("NAV_REGION") or os.path.basename(os.path.realpath(os.path.join(DATA, "current")))  # set by navd core
HERE = os.path.dirname(os.path.abspath(__file__))
EDITION_FILE = os.environ.get("EDITION_FILE", os.path.join(HERE, "edition.json"))
THERMAL = os.environ.get("THERMAL_FILE", "/sys/class/thermal/thermal_zone0/temp")
UPTIME = os.environ.get("UPTIME_FILE", "/proc/uptime")
SYSTEMCTL = os.environ.get("NAV_SYSTEMCTL", "systemctl")
REPLY_DELAY = 1.5
ACTIONS = {"reboot": "reboot", "poweroff": "poweroff"}
TERMINAL = os.environ.get("NAV_TERMINAL", "foot")   # Wayland terminal, opened on the kiosk screen (USB keyboard)


def _read(path):
    try:
        return open(path).read()
    except OSError:
        return ""


def _kv(text):
    """BUILD-INFO: 'key=value' tokens (map/search/routes) plus the pmtiles metadata line for the OSM date"""
    out = dict(re.findall(r"(\w+)=(\S+)", text))
    m = re.search(r"osmosisreplicationtime (\S+)", text)
    if m:
        out["osm"] = m.group(1)
    return out


def data_versions():
    d = {}
    for part, key in (("map", "map"), ("valhalla", "routes"), ("search", "search")):
        text = _read(os.path.join(DATA, REGION, part, "BUILD-INFO"))
        if text:
            kv = _kv(text)
            d[key] = {"built": kv.get("built", "")[:10], "osm": kv.get("osm", "")[:10]}
    return d


def temp_c():
    try:
        return round(int(_read(THERMAL).strip()) / 1000.0, 1)
    except ValueError:
        return None


def uptime_s():
    try:
        return int(float(_read(UPTIME).split()[0]))
    except (ValueError, IndexError):
        return None


def info(h, q, j):
    try:
        du = shutil.disk_usage(DATA if os.path.isdir(DATA) else "/")
        disk = {"free": du.free, "total": du.total}
    except OSError:
        disk = None
    try:
        ed = json.load(open(EDITION_FILE))
    except (OSError, ValueError):
        ed = {}
    return {"disk": disk, "region": REGION, "data": data_versions(), "tempC": temp_c(), "uptime": uptime_s(),
            "app": {"edition": ed.get("name", ""), "hardware": ed.get("hardware", ""), "source": ed.get("source", ""),
                    "built": (ed.get("built") or "")[:16].replace("T", " ")}}


# ---- Pi health (Settings > Pi health): live values + a 1-hour history kept in memory only, never sent anywhere ----
VCGENCMD = os.environ.get("NAV_VCGENCMD", "vcgencmd")
PROC = os.environ.get("PROC_DIR", "/proc")
CPUFREQ = os.environ.get("CPUFREQ_FILE", "/sys/devices/system/cpu/cpu0/cpufreq/scaling_cur_freq")
SERVICES = ("nav-pi", "nav-pi-tiles", "nav-pi-valhalla", "gpsd")
SAMPLE_S, KEEP = 10, 360          # one sample every 10 s, one hour kept
THROTTLE_BITS = {0: "undervolt", 1: "capped", 2: "throttled", 3: "templimit",
                 16: "undervolt_was", 17: "capped_was", 18: "throttled_was", 19: "templimit_was"}
_hist, _prev_cpu, _hlock = [], None, threading.Lock()


def _cpu_times():
    f = _read(os.path.join(PROC, "stat")).split("\n", 1)[0].split()
    if len(f) < 5 or f[0] != "cpu":
        return None
    v = [int(x) for x in f[1:]]
    return sum(v), v[3] + (v[4] if len(v) > 4 else 0)   # total, idle + iowait


def cpu_pct():
    """busy share since the previous call (the sampler calls it every SAMPLE_S)"""
    global _prev_cpu
    now = _cpu_times()
    if not now:
        return None
    prev, _prev_cpu = _prev_cpu, now
    if not prev or now[0] <= prev[0]:
        return None
    return round(100.0 * (1 - (now[1] - prev[1]) / (now[0] - prev[0])), 1)


def mem():
    m = {k: int(v.split()[0]) * 1024 for k, v in (l.split(":", 1) for l in _read(os.path.join(PROC, "meminfo")).splitlines() if ":" in l)}
    if "MemTotal" not in m:
        return None
    return {"total": m["MemTotal"], "avail": m.get("MemAvailable", 0), "swapTotal": m.get("SwapTotal", 0),
            "swapUsed": m.get("SwapTotal", 0) - m.get("SwapFree", 0)}


def throttled():
    """Pi firmware flags (vcgencmd get_throttled): now + since boot; None off a Pi"""
    try:
        out = subprocess.run([VCGENCMD, "get_throttled"], capture_output=True, text=True, timeout=3).stdout
        v = int(out.strip().split("=")[1], 16)
    except Exception:
        return None
    return {"raw": hex(v), **{name: bool(v >> bit & 1) for bit, name in THROTTLE_BITS.items()}}


def services():
    try:
        out = subprocess.run([SYSTEMCTL, "is-active", *SERVICES], capture_output=True, text=True, timeout=5).stdout.split()
    except Exception:
        out = []
    return {n: (out[i] if i < len(out) else "unknown") for i, n in enumerate(SERVICES)}


def _sample():
    m = mem()
    return {"t": int(time.time()), "temp": temp_c(), "cpu": cpu_pct(),
            "mem": round(100.0 * (1 - m["avail"] / m["total"]), 1) if m else None}


def _sampler():
    cpu_pct()   # first reading = reference
    while True:
        time.sleep(SAMPLE_S)
        s = _sample()
        with _hlock:
            _hist.append(s)
            del _hist[:-KEEP]


def health(h, q, j):
    try:
        load = [float(x) for x in _read(os.path.join(PROC, "loadavg")).split()[:3]]
    except ValueError:
        load = None
    try:
        freq = int(_read(CPUFREQ).strip()) // 1000
    except ValueError:
        freq = None
    try:
        du = shutil.disk_usage(DATA if os.path.isdir(DATA) else "/")
        disk = {"free": du.free, "total": du.total}
    except OSError:
        disk = None
    with _hlock:
        hist = list(_hist)
    return {"tempC": temp_c(), "cpu": hist[-1]["cpu"] if hist else None, "cores": os.cpu_count(), "load": load,
            "freqMHz": freq, "mem": mem(), "disk": disk, "uptime": uptime_s(), "throttled": throttled(),
            "services": services(), "history": hist, "sampleS": SAMPLE_S}


def _run(action):
    time.sleep(REPLY_DELAY)   # let the HTTP reply reach the browser first
    try:
        subprocess.run([SYSTEMCTL, ACTIONS[action]], timeout=20)
    except Exception as e:
        print("system:", action, "failed:", e, flush=True)


def power(h, q, j):
    a = j.get("action")
    if a not in ACTIONS:
        return {"error": "bad action"}, 400
    threading.Thread(target=_run, args=(a,), daemon=True).start()
    return {"ok": True, "action": a}


def _wayland_env():
    """navd is a system service; the screen is the labwc session of the same user: find its socket."""
    run = os.environ.get("XDG_RUNTIME_DIR") or "/run/user/%d" % os.getuid()
    socks = sorted(n for n in os.listdir(run) if re.fullmatch(r"wayland-\d+", n)) if os.path.isdir(run) else []
    if not socks:
        return None
    return dict(os.environ, XDG_RUNTIME_DIR=run, WAYLAND_DISPLAY=socks[0])


def terminal(h, q, j):
    """Open a terminal window over the app (needs a USB keyboard; `exit` closes it and the app is back)."""
    if not shutil.which(TERMINAL):
        return {"error": "no terminal installed (%s)" % TERMINAL}, 501
    env = _wayland_env()
    if env is None:
        return {"error": "no screen session"}, 503
    subprocess.Popen([TERMINAL], env=env, cwd=os.path.expanduser("~"), start_new_session=True,
                     stdin=subprocess.DEVNULL, stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
    return {"ok": True}


def register(app):
    app.get("/api/system", info)
    app.get("/api/system/health", health)
    if not os.environ.get("NAV_NO_SAMPLER"):
        threading.Thread(target=_sampler, daemon=True, name="health-sampler").start()
    app.post("/api/system/power", power)
    app.post("/api/system/terminal", terminal)
    try:   # PN-22/23: map, app and OS updates live in navd_system_updates.py (next to this file)
        import navd_system_updates
        navd_system_updates.register(app)
    except ImportError as e:
        print("system: updates unavailable:", e, flush=True)
