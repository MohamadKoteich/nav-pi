"""display feature: screen orientation (wlr-randr, kept in DATA/rotation for boot) and DSI backlight brightness.
Brightness: /sys/class/backlight/*/brightness (dir overridable with BACKLIGHT_DIR for tests). The raw value is never
below MINPCT of the range (0 = black screen, unrecoverable on a touch-only head unit). State in DATA/brightness.json:
day level, night level, "dim at night" switch, and whether the app currently shows the night theme."""
import json, math, os, queue, shutil, socket, sqlite3, subprocess, threading, time  # noqa: F401,E401

DATA = os.environ.get("NAV_DATA", "/srv/navdata")
ROT_FILE = os.path.join(DATA, "rotation")
ROTATIONS = ("normal", "90", "180", "270")
BL_DIR = os.environ.get("BACKLIGHT_DIR", "/sys/class/backlight")
BR_FILE = os.path.join(DATA, "brightness.json")
MINPCT = 8                    # lowest level offered, in percent of the panel's range
BOOT_DELAY = 2
LOCK = threading.Lock()


def _backlight():
    """first backlight device dir, or None (no panel backlight: HDMI monitor, dev PC)"""
    try:
        for d in sorted(os.listdir(BL_DIR)):
            p = os.path.join(BL_DIR, d)
            if os.path.exists(os.path.join(p, "brightness")) and os.path.exists(os.path.join(p, "max_brightness")):
                return p
    except OSError:
        pass
    return None


def _num(path):
    return int(open(path).read().strip())


def _raw(pct, mx):
    pct = max(MINPCT, min(100, pct))
    return max(1, int(round(mx * pct / 100.0)))


def _load():
    st = {"day": None, "night": 30, "dim": False, "isNight": False}
    try:
        st.update({k: v for k, v in json.load(open(BR_FILE)).items() if k in st})
    except (OSError, ValueError):
        pass
    return st


def _save(st):
    try:
        tmp = BR_FILE + ".tmp"
        with open(tmp, "w") as f:
            json.dump(st, f)
        os.replace(tmp, BR_FILE)
    except OSError as e:
        print("display: cannot save brightness:", e, flush=True)


def _active(st):
    return "night" if (st["dim"] and st["isNight"]) else "day"


def _apply(st, bl):
    mx = _num(os.path.join(bl, "max_brightness"))
    pct = st[_active(st)]
    if pct is None:
        pct = 100
    with open(os.path.join(bl, "brightness"), "w") as f:
        f.write(str(_raw(int(pct), mx)))


def brightness_state():
    bl = _backlight()
    if not bl:
        return {"available": False}
    st = _load()
    try:
        mx, cur = _num(os.path.join(bl, "max_brightness")), _num(os.path.join(bl, "brightness"))
    except (OSError, ValueError):
        return {"available": False}
    return {"available": True, "level": int(round(100.0 * cur / mx)), "min": MINPCT, "dim": st["dim"],
            "night": st["isNight"], "nightLevel": st["night"]}


def brightness_set(j):
    """j: level (percent; goes to the active slot: night level while dimmed at night, else day), dim (bool), night (bool)"""
    bl = _backlight()
    if not bl:
        return False
    with LOCK:
        st = _load()
        if st["day"] is None:
            try:
                st["day"] = int(round(100.0 * _num(os.path.join(bl, "brightness")) / _num(os.path.join(bl, "max_brightness"))))
            except (OSError, ValueError):
                st["day"] = 100
        if "dim" in j:
            st["dim"] = bool(j["dim"])
        if "night" in j:
            st["isNight"] = bool(j["night"])
        if "level" in j:
            st[_active(st)] = max(MINPCT, min(100, int(j["level"])))
        _save(st)
        try:
            _apply(st, bl)
        except OSError as e:
            print("display: backlight not writable:", e, flush=True)
            return False
    return True


def _boot_apply():
    """the firmware starts the panel at its own level: re-apply the saved one (the app re-reports night on load)"""
    time.sleep(BOOT_DELAY)
    bl = _backlight()
    st = _load()
    if bl and st["day"] is not None:
        try:
            _apply(st, bl)
        except OSError as e:
            print("display: backlight not writable:", e, flush=True)


def display_state():
    try:
        r = open(ROT_FILE).read().strip()
    except OSError:
        r = "90"
    return {"rotation": r if r in ROTATIONS else "90", "brightness": brightness_state()}


def display_set(rot):
    if rot not in ROTATIONS:
        return False
    with open(ROT_FILE, "w") as f:
        f.write(rot + "\n")
    env = dict(os.environ, WAYLAND_DISPLAY=os.environ.get("WAYLAND_DISPLAY", "wayland-0"))
    try:
        out = subprocess.run(["wlr-randr"], capture_output=True, text=True, timeout=5, env=env).stdout
        name = next((l.split()[0] for l in out.splitlines() if l and not l.startswith(" ")), None)
        if name:
            subprocess.run(["wlr-randr", "--output", name, "--transform", rot], timeout=5, env=env)
    except Exception as e:
        print("display:", e, flush=True)
    return True


def post_display(h, q, j):
    if "rotation" in j and not display_set(str(j["rotation"])):
        return {"error": "bad rotation"}, 400
    if any(k in j for k in ("level", "dim", "night")):
        try:
            if not brightness_set(j):
                return {"error": "no backlight"}, 409
        except (TypeError, ValueError):
            return {"error": "bad brightness"}, 400
    return display_state()


def register(app):
    app.get("/api/display", lambda h, q, j: display_state())
    app.post("/api/display", post_display)
    app.thread(_boot_apply)
