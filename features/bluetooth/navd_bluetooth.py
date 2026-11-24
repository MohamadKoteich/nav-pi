"""bluetooth feature: BlueZ through bluetoothctl — state, scan, pair/trust/connect, disconnect, remove, auto-reconnect of trusted audio devices."""
import json, math, os, queue, shutil, socket, sqlite3, subprocess, threading, time  # noqa: F401,E401

BT_LOCK = threading.Lock()
visible_until = 0   # pairing by phones is allowed only until this time (POST /api/bt/visible)
bt_jobs = {}  # mac -> "pairing" | "connecting" | error text


def btctl(*args, timeout=15):
    try:
        p = subprocess.run(["bluetoothctl", *args], capture_output=True, text=True, timeout=timeout)
        return p.returncode, p.stdout + p.stderr
    except subprocess.TimeoutExpired:
        return 1, "timeout"
    except FileNotFoundError:
        return 1, "bluetoothctl missing"


def bt_info(mac):
    _, out = btctl("info", mac, timeout=5)
    d = {"mac": mac}
    for line in out.splitlines():
        k, _, v = line.strip().partition(": ")
        if k in ("Name", "Alias", "Icon"):
            d[k.lower()] = v
        elif k in ("Paired", "Trusted", "Connected", "Bonded"):
            d[k.lower()] = v == "yes"
    d["name"] = d.get("alias") or d.get("name") or mac
    d["audio"] = d.get("icon", "").startswith(("audio", "headset", "headphone"))
    d["phone"] = d.get("icon", "").startswith("phone")
    d["job"] = bt_jobs.get(mac)
    return d


def agent_loop():
    """keep a pairing agent registered so a PHONE can pair with the Pi ("just works", no PIN dialog on
    the Pi). Only possible while the Pi is visible (POST /api/bt/visible), i.e. on the user's request."""
    while True:
        try:
            p = subprocess.Popen(["bluetoothctl"], stdin=subprocess.PIPE, stdout=subprocess.DEVNULL,
                                 stderr=subprocess.DEVNULL, text=True)
            p.stdin.write("agent NoInputNoOutput\ndefault-agent\n")
            p.stdin.flush()
            p.wait()
        except Exception as e:
            print("bt agent:", e, flush=True)
        time.sleep(5)


def bt_state():
    _, show = btctl("show", timeout=5)
    powered = "Powered: yes" in show
    visible = "Discoverable: yes" in show
    scanning = "Discovering: yes" in show
    _, out = btctl("devices", timeout=5)
    devs = []
    for line in out.splitlines():
        parts = line.split(" ", 2)
        if len(parts) >= 2 and parts[0] == "Device":
            mac = parts[1]
            name = parts[2] if len(parts) > 2 else ""
            d = bt_info(mac)
            # skip nameless scan results (BlueZ shows the address as name) unless already known
            if not d.get("paired") and (not name or name.replace("-", ":") == mac):
                continue
            devs.append(d)
    devs.sort(key=lambda d: (not d.get("connected"), not d.get("paired"), d["name"].lower()))
    return {"present": "Controller " in show, "powered": powered, "scanning": scanning, "visible": visible, "devices": devs}


def bt_action(action, mac=None, on=None):
    if action == "power":
        return btctl("power", "on" if on else "off")
    if action == "visible":  # let a phone find and pair with the Pi for 3 minutes, then close again
        global visible_until
        if on:
            visible_until = time.time() + 180
            btctl("pairable", "on")
            btctl("discoverable-timeout", "180")
            return btctl("discoverable", "on")
        visible_until = 0
        btctl("pairable", "off")
        return btctl("discoverable", "off")
    if action == "scan":
        if on:  # scan in the background for 25 s; results appear in GET /api/bt
            threading.Thread(target=btctl, args=("--timeout", "25", "scan", "on"), kwargs={"timeout": 30}, daemon=True).start()
            return 0, "scanning"
        return btctl("scan", "off")
    if not mac or len(mac) != 17:
        return 1, "bad address"
    if action == "pair":
        def job():
            bt_jobs[mac] = "pairing"
            rc, out = btctl("--agent", "NoInputNoOutput", "pair", mac, timeout=40)
            if rc != 0 and "AlreadyExists" not in out:
                bt_jobs[mac] = "Koppeln fehlgeschlagen" + (" (Gerät verlangt PIN)" if "AuthenticationFailed" in out else "")
                return
            btctl("trust", mac)
            bt_jobs[mac] = "connecting"
            rc, out = btctl("connect", mac, timeout=25)
            bt_jobs[mac] = None if rc == 0 else "Gekoppelt, aber Verbinden fehlgeschlagen"
        threading.Thread(target=job, daemon=True).start()
        return 0, "pairing"
    if action == "connect":
        def job():
            bt_jobs[mac] = "connecting"
            rc, _ = btctl("connect", mac, timeout=25)
            bt_jobs[mac] = None if rc == 0 else "Verbinden fehlgeschlagen – ist das Gerät an?"
        threading.Thread(target=job, daemon=True).start()
        return 0, "connecting"
    if action == "disconnect":
        return btctl("disconnect", mac)
    if action == "remove":
        bt_jobs.pop(mac, None)
        return btctl("remove", mac)
    return 1, "unknown action"


def bt_autoconnect_loop():
    """car start: reconnect the known (trusted) audio device that is switched on"""
    btctl("pairable", "off")   # never left open from an earlier run: phones pair only via "make visible"
    time.sleep(15)
    while True:
        try:
            st = bt_state()
            if visible_until and time.time() > visible_until:   # window over: no more pairing
                btctl("pairable", "off")
                globals()["visible_until"] = 0
            for d in st["devices"]:  # a phone that paired from its side DURING the window: trust it
                if visible_until and d.get("paired") and not d.get("trusted"):
                    btctl("trust", d["mac"])
            if st["powered"] and not any(d.get("connected") and d.get("audio") for d in st["devices"]):
                for d in st["devices"]:
                    if d.get("trusted") and d.get("audio") and not d.get("job"):
                        if btctl("connect", d["mac"], timeout=12)[0] == 0:
                            break
        except Exception as e:
            print("bt autoconnect:", e, flush=True)
        time.sleep(20)




def get_state(h, q, j):
    with BT_LOCK:
        return bt_state()


def post_action(h, q, j, action):
    rc, out = bt_action(action, j.get("mac"), j.get("on"))
    return {"ok": rc == 0, "detail": out.strip()[-300:]}, (200 if rc == 0 else 400)


def register(app):
    app.thread(bt_autoconnect_loop)
    app.thread(agent_loop)
    app.get("/api/bt", get_state)
    for a in ("power", "scan", "visible", "pair", "connect", "disconnect", "remove"):
        app.post("/api/bt/" + a, lambda h, q, j, a=a: post_action(h, q, j, a))
