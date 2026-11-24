"""wifi feature: NetworkManager through nmcli — state, scan, connect, forget, radio on/off.
Every nmcli call is an argument list (never a shell): SSIDs are untrusted input. The password is fed to
`nmcli --ask` on stdin: not on the command line (ps), not logged, not kept by navd (NetworkManager stores it).
navd runs as a system service without a login session, so polkit needs the rule installed by
pi/49-nav-pi-wifi.rules.in (setup/update scripts). Without NetworkManager / a Wi-Fi device: {"present": false}."""
import os, re, subprocess, threading  # noqa: E401

NMCLI = os.environ.get("NMCLI", "nmcli")
LOCK = threading.Lock()
job = {"state": "idle", "ssid": "", "error": ""}   # connect job: idle | connecting | failed | done
UUID_RE = re.compile(r"^[0-9a-fA-F-]{36}$")
CON_FIELDS = ("-t", "-f", "NAME,UUID,TYPE", "con", "show")


def split_terse(line):
    """split one `nmcli -t` line on unescaped ':' and undo the \\: and \\\\ escapes"""
    out, cur, i = [], [], 0
    while i < len(line):
        c = line[i]
        if c == "\\" and i + 1 < len(line):
            cur.append(line[i + 1])
            i += 2
        elif c == ":":
            out.append("".join(cur))
            cur = []
            i += 1
        else:
            cur.append(c)
            i += 1
    out.append("".join(cur))
    return out


def nm(*args, timeout=15, stdin=None):
    try:
        p = subprocess.run([NMCLI, *args], capture_output=True, text=True, timeout=timeout, input=stdin)
        return p.returncode, p.stdout, p.stderr
    except subprocess.TimeoutExpired:
        return 1, "", "timeout"
    except FileNotFoundError:
        return 127, "", "nmcli missing"


def parse_wifi_list(out):
    """`nmcli -t -f IN-USE,SSID,SIGNAL,SECURITY dev wifi list` -> unique SSIDs, connected first, then strongest"""
    best = {}
    for line in out.splitlines():
        f = split_terse(line)
        if len(f) < 4 or not f[1]:
            continue   # hidden network (empty SSID)
        inuse, ssid, sec = f[0] == "*", f[1], f[3].strip()
        sig = int(f[2]) if f[2].isdigit() else 0
        secure = sec not in ("", "--")
        n = {"ssid": ssid, "signal": sig, "secure": secure, "security": sec if secure else "",
             "enterprise": "802.1X" in sec, "inuse": inuse}
        old = best.get(ssid)
        if old is None or (inuse and not old["inuse"]) or (not old["inuse"] and sig > old["signal"]):
            best[ssid] = n
    return sorted(best.values(), key=lambda n: (not n["inuse"], -n["signal"], n["ssid"].lower()))


def parse_saved(out):
    """`nmcli -t -f NAME,UUID,TYPE con show` -> saved Wi-Fi profiles"""
    res = []
    for line in out.splitlines():
        f = split_terse(line)
        if len(f) >= 3 and f[2] == "802-11-wireless" and UUID_RE.match(f[1]):
            res.append({"name": f[0], "uuid": f[1]})
    return res


def parse_kv(out):
    d = {}
    for line in out.splitlines():
        f = split_terse(line)
        if len(f) >= 2:
            d[f[0]] = ":".join(f[1:])
    return d


def wifi_device():
    rc, out, _ = nm("-t", "-f", "DEVICE,TYPE,STATE", "dev", timeout=5)
    if rc != 0:
        return None
    for line in out.splitlines():
        f = split_terse(line)
        if len(f) >= 3 and f[1] == "wifi":
            return {"dev": f[0], "state": f[2]}
    return None


def state():
    d = wifi_device()
    if not d:
        return {"present": False}
    _, radio, _ = nm("radio", "wifi", timeout=5)
    enabled = radio.strip() == "enabled"
    st = {"present": True, "enabled": enabled, "device": d["dev"], "state": d["state"], "ssid": "", "ip": "",
          "networks": [], "saved": [], "job": dict(job)}
    _, out, _ = nm(*CON_FIELDS, timeout=8)
    saved = parse_saved(out)
    if enabled:
        _, out, _ = nm("-t", "-f", "IN-USE,SSID,SIGNAL,SECURITY", "dev", "wifi", "list", "ifname", d["dev"], "--rescan", "no", timeout=8)
        st["networks"] = parse_wifi_list(out)
        if d["state"] == "connected":
            _, out, _ = nm("-t", "-f", "GENERAL.CONNECTION,IP4.ADDRESS", "dev", "show", d["dev"], timeout=5)
            kv = parse_kv(out)
            st["ip"] = kv.get("IP4.ADDRESS[1]", "").split("/")[0]
            for n in st["networks"]:
                if n["inuse"]:
                    st["ssid"] = n["ssid"]
            conn = kv.get("GENERAL.CONNECTION", "")
            if not st["ssid"] and conn and conn != "--":
                st["ssid"] = conn
    # a saved profile is matched to a visible network by name (nmcli names a new profile after the SSID)
    names = {s["name"]: s["uuid"] for s in saved}
    for n in st["networks"]:
        n["uuid"] = names.get(n["ssid"], "")
    shown = {n["ssid"] for n in st["networks"]}
    st["saved"] = [s for s in saved if s["name"] not in shown]   # remembered, but out of range now
    return st


def connect_job(ssid, password, uuid):
    global job
    try:
        _, out, _ = nm(*CON_FIELDS, timeout=8)
        before = {s["uuid"] for s in parse_saved(out)}
        if uuid:
            rc, o, e = nm("con", "up", "uuid", uuid, timeout=45)
        else:
            rc, o, e = nm("--ask", "dev", "wifi", "connect", ssid, timeout=60, stdin=(password or "") + "\n")
        if rc == 0:
            job = {"state": "done", "ssid": ssid, "error": ""}
            return
        # drop the half-made profile of a failed first attempt (wrong password) so it is not "saved"
        _, out, _ = nm(*CON_FIELDS, timeout=8)
        for s in parse_saved(out):
            if s["uuid"] not in before:
                nm("con", "delete", "uuid", s["uuid"], timeout=10)
        msg = (e or o).strip().lower()
        why = "secrets" if ("secrets" in msg or "password" in msg or "802-1x" in msg) else "timeout" if "timeout" in msg else "failed"
        job = {"state": "failed", "ssid": ssid, "error": why}   # never echo nmcli text: it may quote input
    except Exception as ex:  # noqa: BLE001
        job = {"state": "failed", "ssid": ssid, "error": "failed"}
        print("wifi job:", type(ex).__name__, flush=True)


def action(name, j):
    global job
    if name == "power":
        rc, _, _ = nm("radio", "wifi", "on" if j.get("on") else "off", timeout=10)
        return {"ok": rc == 0}, (200 if rc == 0 else 400)
    if name == "scan":
        nm("dev", "wifi", "rescan", timeout=10)   # non-zero when a scan just ran: harmless, results via GET
        return {"ok": True}, 200
    if name == "connect":
        ssid, pw, uuid = j.get("ssid"), j.get("password") or "", j.get("uuid") or ""
        if not isinstance(ssid, str) or not ssid or len(ssid.encode()) > 32 or "\0" in ssid or "\n" in ssid:
            return {"ok": False, "error": "bad ssid"}, 400
        if uuid and not (isinstance(uuid, str) and UUID_RE.match(uuid)):
            return {"ok": False, "error": "bad id"}, 400
        if not uuid and ssid.startswith("-"):
            return {"ok": False, "error": "unsupported name"}, 400   # would be read as an nmcli option
        if not isinstance(pw, str) or "\n" in pw or "\r" in pw or "\0" in pw or len(pw) > 64:
            return {"ok": False, "error": "bad password"}, 400
        if pw and not uuid and len(pw) < 8:
            return {"ok": False, "error": "bad password"}, 400   # WPA needs 8-63 characters (or 64 hex)
        with LOCK:
            if job["state"] == "connecting":
                return {"ok": False, "error": "busy"}, 409
            job = {"state": "connecting", "ssid": ssid, "error": ""}
        threading.Thread(target=connect_job, args=(ssid, pw, uuid), daemon=True).start()
        return {"ok": True}, 200
    if name == "forget":
        uuid = j.get("uuid")
        _, out, _ = nm(*CON_FIELDS, timeout=8)
        if not (isinstance(uuid, str) and uuid in {s["uuid"] for s in parse_saved(out)}):   # Wi-Fi profiles only
            return {"ok": False, "error": "unknown network"}, 400
        rc, _, _ = nm("con", "delete", "uuid", uuid, timeout=15)
        return {"ok": rc == 0}, (200 if rc == 0 else 400)
    return {"ok": False, "error": "unknown action"}, 404


def get_state(h, q, j):
    return state()


def register(app):
    app.get("/api/wifi", get_state)
    for a in ("power", "scan", "connect", "forget"):
        app.post("/api/wifi/" + a, lambda h, q, j, a=a: action(a, j))
