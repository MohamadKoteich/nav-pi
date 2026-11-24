"""gps feature: relays gpsd to the app.
  /api/gps       Server-Sent Events: the fix (TPV: mode, lat, lon, speed, track, alt, time, eph) + receiver flag
  /api/gps/info  JSON for the GPS status page: receiver (gpsd DEVICES), satellites (SKY), accuracy, DOP, speed, heading, time
gpsd 3.25 JSON (Debian 13 image: gpsd_3.25-5+deb13u2). A TPV without a fix (mode 0/1) carries no position: the old
position is dropped, so a tunnel never keeps showing a stale fix. SKY arrives as two kinds of message (DOP only / with
the satellites list): both are merged. A fix older than GPS_STALE_S seconds counts as lost (gpsd silent although the
receiver is there)."""
import calendar, json, math, os, queue, shutil, socket, sqlite3, subprocess, threading, time  # noqa: F401,E401

GPSD = (os.environ.get("GPSD_HOST", "127.0.0.1"), int(os.environ.get("GPSD_PORT", "2947")))
STALE_S = float(os.environ.get("GPS_STALE_S", "4"))
FIX_KEYS = ("lat", "lon", "speed", "track", "alt", "eph", "time")
gps_state = {"mode": 0, "receiver": False}
gps_info = {"devices": [], "sats": [], "nSat": None, "uSat": None, "dop": {}, "tpv": {}}
gps_ts = {"tpv": 0.0, "sky": 0.0}
gps_cond = threading.Condition()

# --- system clock from GPS time (the Pi has no RTC; in a car without network the clock would be days stale) ---
# Rule: a TPV with a fix and a valid time sets the clock when it is off by more than
# CLOCK_TOL_S, but ONLY while systemd-timesyncd has not synchronized (NTPSynchronized != yes: with network NTP wins).
# Forward steps need any fix (mode >= 2); a step BACKWARDS needs a 3D fix (mode 3). GPS times before CLOCK_FLOOR
# (2026-11-01) are refused (receiver without almanac / week-rollover junk). At most one attempt per CLOCK_EVERY_S.
# The root work is a tiny helper (pi/set-clock.sh) run through sudo: `timedatectl set-time` is refused while NTP is
# enabled ("Automatic time synchronization is enabled"), which is the normal state of this Pi. Once the clock is
# trusted, the helper is also asked every CLOCK_EVERY_S to touch /var/lib/systemd/timesync/clock, so a reboot
# never starts earlier than the last trusted time (what timesyncd restores at boot): fake-hwclock without a package.
CLOCK_HELPER = os.environ.get("GPSCLOCK_HELPER", "/usr/local/lib/nav-pi/set-clock.sh")
CLOCK_TOL_S = 2.0
CLOCK_EVERY_S = float(os.environ.get("GPSCLOCK_EVERY_S", "600"))
CLOCK_FLOOR = 1793491200   # 2026-11-01T00:00:00Z
clock_state = {"last": 0.0, "set": None, "last_rc": None}


def ntp_synced():
    try:
        r = subprocess.run(["timedatectl", "show", "-p", "NTPSynchronized", "--value"], capture_output=True, text=True, timeout=5)
        return r.stdout.strip() == "yes"
    except (OSError, subprocess.SubprocessError):
        return False


def run_helper(*args):
    try:
        return subprocess.run(["sudo", "-n", CLOCK_HELPER, *args], capture_output=True, text=True, timeout=10).returncode
    except (OSError, subprocess.SubprocessError):
        return 127


def parse_gps_time(t):
    try:
        head, _, frac = t.rstrip("Z").partition(".")
        return calendar.timegm(time.strptime(head, "%Y-%m-%dT%H:%M:%S")) + (float("0." + frac) if frac else 0.0)
    except (AttributeError, ValueError):
        return None


def sync_clock(msg, now=None, synced=None, helper=None):
    """Called for every TPV. Returns "set" / "saved" / None. `now` = system time; `synced`/`helper` injectable for tests."""
    now = time.time() if now is None else now
    gps = parse_gps_time(msg.get("time")) if msg.get("mode", 0) >= 2 else None
    if gps is None or gps < CLOCK_FLOOR or now - clock_state["last"] < CLOCK_EVERY_S:
        return None
    if (synced or ntp_synced)():
        clock_state["last"] = now   # NTP owns the clock: do not even ask again for a while
        return None
    diff = gps - now
    run = helper or run_helper
    if abs(diff) > CLOCK_TOL_S:
        if diff < 0 and msg.get("mode") != 3:
            return None   # wait for the 3D fix before moving the clock back
        clock_state["last"] = now
        clock_state["last_rc"] = run("set", str(int(round(gps))))
        if clock_state["last_rc"] == 0:
            clock_state["set"] = gps
            return "set"
        return None
    clock_state["last"] = now
    clock_state["last_rc"] = run("save")
    return "saved"


def reset():
    gps_state.clear(); gps_state.update(mode=0, receiver=False)
    gps_info.update(devices=[], sats=[], nSat=None, uSat=None, dop={}, tpv={})
    gps_ts.update(tpv=0.0, sky=0.0)


def apply_msg(msg, now=None):
    """Fold one gpsd JSON object into the state (caller holds gps_cond). Unit-tested."""
    now = time.time() if now is None else now
    cls = msg.get("class")
    if cls == "DEVICES":
        devs = [{"path": d.get("path"), "driver": d.get("driver"), "subtype": d.get("subtype"), "bps": d.get("bps")}
                for d in msg.get("devices", []) if d.get("path")]
        gps_info["devices"] = devs
        gps_state["receiver"] = bool(devs)
        if not devs:   # receiver unplugged
            gps_state["mode"] = 0
            for k in FIX_KEYS:
                gps_state.pop(k, None)
            gps_info.update(sats=[], nSat=None, uSat=None, tpv={})
    elif cls == "TPV":
        for k in FIX_KEYS:
            gps_state.pop(k, None)
        mode = msg.get("mode", 0)
        keep = {k: msg[k] for k in FIX_KEYS if k in msg} if mode >= 2 else {}
        eph = msg.get("eph")
        if eph is None and "epx" in msg and "epy" in msg:
            eph = math.hypot(msg["epx"], msg["epy"])
        if eph is not None and mode >= 2:
            keep["eph"] = round(eph, 1)
        if mode >= 2 and "alt" not in keep and msg.get("altMSL", msg.get("altHAE")) is not None:
            keep["alt"] = msg.get("altMSL", msg.get("altHAE"))
        gps_state.update(keep, mode=mode, receiver=True)
        gps_ts["tpv"] = now
        gps_info["tpv"] = {k: msg[k] for k in ("mode", "time", "epx", "epy", "epv", "eph", "eps", "ept", "climb") if k in msg}
    elif cls == "SKY":
        for k in ("xdop", "ydop", "vdop", "tdop", "hdop", "gdop", "pdop"):
            if k in msg:
                gps_info["dop"][k] = msg[k]
        if "satellites" in msg:
            gps_info["sats"] = [{"prn": s.get("PRN"), "gnss": s.get("gnssid"), "el": s.get("el"), "az": s.get("az"),
                                 "ss": s.get("ss"), "used": bool(s.get("used"))} for s in msg["satellites"]]
            gps_info["nSat"] = msg.get("nSat", len(gps_info["sats"]))
            gps_info["uSat"] = msg.get("uSat", sum(1 for s in gps_info["sats"] if s["used"]))
            gps_ts["sky"] = now


def current(now=None):
    """The SSE payload; a fix that stopped arriving is reported as no fix."""
    now = time.time() if now is None else now
    cur = dict(gps_state)
    if cur.get("mode", 0) >= 2 and now - gps_ts["tpv"] > STALE_S:
        cur = {"mode": 1, "receiver": cur.get("receiver", False), "stale": True}
    return cur


def info(h=None, q=None, j=None):
    now = time.time()
    with gps_cond:
        cur = current(now)
        out = dict(gps_info, receiver=gps_state["receiver"], mode=cur.get("mode", 0), stale=bool(cur.get("stale")),
                   fix={k: cur[k] for k in FIX_KEYS if k in cur}, now=now,
                   tpv_age=round(now - gps_ts["tpv"], 1) if gps_ts["tpv"] else None)
        if now - gps_ts["sky"] > 30:
            out["sats"], out["nSat"], out["uSat"] = [], None, None
    return out


def gps_loop():
    while True:
        try:
            with socket.create_connection(GPSD, timeout=5) as s:
                s.sendall(b'?WATCH={"enable":true,"json":true}\n')
                s.settimeout(None)
                for line in s.makefile("r", encoding="utf-8", errors="replace"):
                    try:
                        msg = json.loads(line)
                    except ValueError:
                        continue
                    with gps_cond:
                        apply_msg(msg)
                        gps_cond.notify_all()
                    if msg.get("class") == "TPV" and msg.get("mode", 0) >= 2:
                        try:
                            sync_clock(msg)
                        except Exception:  # noqa: BLE001  the clock must never take the relay down
                            pass
        except OSError:
            pass
        with gps_cond:   # gpsd gone or not reachable: no receiver, no fix
            reset()
            gps_cond.notify_all()
        time.sleep(3)


def sse(h, q, j):
    h.send_response(200)
    h.send_header("Content-Type", "text/event-stream")
    h.end_headers()
    last = None
    try:
        while True:
            with gps_cond:
                gps_cond.wait(timeout=1)
                cur = json.dumps(current())
            h.wfile.write((b"data: " + cur.encode() + b"\n\n") if cur != last else b": keepalive\n\n")
            h.wfile.flush()
            last = cur
    except (BrokenPipeError, ConnectionResetError):
        pass


def register(app):
    app.thread(gps_loop)
    app.get("/api/gps", sse)
    app.get("/api/gps/info", info)
    app.status("gps", lambda: current())
