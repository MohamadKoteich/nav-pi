"""car feature (PN-51): service reminders by date and/or km (oil change, inspection/TUV, tyres, custom).
Stored on the Pi in NAV_DATA/car/reminders.json (created by navd, like trips/), so it survives browser resets.
Odometer: the user enters the reading; when the trip feature records drives (NAV_DATA/trips/*.jsonl), the
kilometres of the real (not simulated) drives finished since that entry are added = an estimate the user can
correct any time. Due: a date month at or before this month, or the estimated km at or past the due km.
"soon": next month, or within SOON_KM. The app decides when to show a notice (never while driving).
Env (tests): NAV_DATA."""
import glob, json, os, re, threading, time, uuid  # noqa: E401

DATA = os.environ.get("NAV_DATA", "/srv/navdata")
DIR = os.path.join(DATA, "car")
FILE = os.path.join(DIR, "reminders.json")
TRIPS = os.path.join(DATA, "trips")
KINDS = ("oil", "inspection", "tyres", "custom")
SOON_KM = 1000
MAX_ITEMS = 30
MAX_KM = 2_000_000
lock = threading.RLock()


def load():
    try:
        with open(FILE) as f:
            d = json.load(f)
        if isinstance(d, dict):
            d.setdefault("odo", None)
            d.setdefault("items", [])
            return d
    except (OSError, ValueError):
        pass
    return {"odo": None, "items": []}


def save(d):
    os.makedirs(DIR, exist_ok=True)
    tmp = FILE + ".tmp"
    with open(tmp, "w") as f:
        json.dump(d, f, indent=1)
    os.replace(tmp, FILE)


def trip_km_since(t0):
    """km of finished real drives that started at or after t0 (trip ids are local YYYYMMDD-HHMMSS)
    -> (km, have_trip_log)"""
    if not os.path.isdir(TRIPS):
        return 0.0, False
    total = 0.0
    for p in glob.glob(os.path.join(TRIPS, "*.jsonl")):
        m = re.fullmatch(r"(\d{8}-\d{6})\.jsonl", os.path.basename(p))   # "-sim" drives never count
        if not m:
            continue
        try:
            start = time.mktime(time.strptime(m.group(1), "%Y%m%d-%H%M%S"))
        except ValueError:
            continue
        if start < t0:
            continue
        try:
            with open(p, "rb") as f:                # the summary is the last line: read only the tail
                f.seek(0, 2)
                f.seek(max(0, f.tell() - 4096))
                last = f.read().decode("utf-8", "replace").strip().splitlines()[-1]
            end = json.loads(last)
            if isinstance(end, dict) and "end" in end:
                total += float(end.get("dist") or 0) / 1000.0
        except (OSError, ValueError, IndexError):
            continue
    return total, True


def km_now(d):
    """-> (km or None, source "trip" | "entered" | None)"""
    o = d.get("odo")
    if not o:
        return None, None
    extra, have = trip_km_since(o.get("t", 0))
    return int(round(o["km"] + extra)), ("trip" if have else "entered")


def month_index(ym):
    y, m = ym.split("-")
    return int(y) * 12 + int(m) - 1


def add_months(ym, n):
    i = month_index(ym) + n
    return "%04d-%02d" % (i // 12, i % 12 + 1)


def this_month(t=None):
    return time.strftime("%Y-%m", time.localtime(t))


def state(item, km, now_ym):
    """-> ("due" | "soon" | "ok", reasons [...])"""
    st, why = "ok", []
    if item.get("due_month"):
        diff = month_index(item["due_month"]) - month_index(now_ym)
        if diff <= 0:
            st, why = "due", why + ["date"]
        elif diff == 1:
            st = "soon"
            why.append("date")
    if item.get("due_km") is not None and km is not None:
        left = item["due_km"] - km
        if left <= 0:
            st = "due"
            why.append("km")
        elif left <= SOON_KM and st != "due":
            st = "soon"
            why.append("km")
    return st, why


def view(d=None, now=None):
    d = d or load()
    km, src = km_now(d)
    ym = this_month(now)
    items = []
    for it in d["items"]:
        s, why = state(it, km, ym)
        if it.get("snooze_until", 0) > (now or time.time()) and s == "due":
            snoozed = True
        else:
            snoozed = False
        items.append(dict(it, state=s, why=why, snoozed=snoozed))
    order = {"due": 0, "soon": 1, "ok": 2}
    items.sort(key=lambda x: (order[x["state"]], x.get("due_month") or "9999", x.get("due_km") or 1e12))
    return {"odo": d.get("odo"), "km": km, "kmSource": src, "items": items, "month": ym}


def clean(j):
    """validate a reminder from the app -> dict or error string"""
    kind = j.get("kind")
    if kind not in KINDS:
        return "kind = " + "|".join(KINDS)
    name = str(j.get("name") or "").strip()[:40]
    if kind == "custom" and not name:
        return "name needed"
    out = {"kind": kind, "name": name}
    dm = j.get("due_month")
    if dm:
        if not re.fullmatch(r"(19|20|21)\d\d-(0[1-9]|1[0-2])", str(dm)):
            return "due_month = YYYY-MM"
        out["due_month"] = dm
    for k in ("due_km", "every_km"):
        v = j.get(k)
        if v not in (None, ""):
            try:
                v = int(v)
            except (TypeError, ValueError):
                return k + " must be a number"
            if not 0 < v <= MAX_KM:
                return k + " out of range"
            out[k] = v
    v = j.get("every_months")
    if v not in (None, "", 0):
        try:
            v = int(v)
        except (TypeError, ValueError):
            return "every_months must be a number"
        if not 0 < v <= 120:
            return "every_months out of range"
        out["every_months"] = v
    if "due_month" not in out and "due_km" not in out:
        return "a date or a km reading is needed"
    return out


# ---------- routes ----------
def get(h, q, j):
    with lock:
        return view()


def set_odo(h, q, j):
    try:
        km = int(j.get("km"))
    except (TypeError, ValueError):
        return {"error": "km must be a number"}, 400
    if not 0 <= km <= MAX_KM:
        return {"error": "km out of range"}, 400
    with lock:
        d = load()
        d["odo"] = {"km": km, "t": time.time()}
        save(d)
        return view(d)


def put(h, q, j):
    item = clean(j)
    if isinstance(item, str):
        return {"error": item}, 400
    with lock:
        d = load()
        rid = j.get("id")
        if rid:
            old = next((x for x in d["items"] if x["id"] == rid), None)
            if not old:
                return {"error": "no such reminder"}, 404
            old.clear()
            old.update(item, id=rid)
        else:
            if len(d["items"]) >= MAX_ITEMS:
                return {"error": "too many reminders"}, 400
            d["items"].append(dict(item, id=uuid.uuid4().hex[:10]))
        save(d)
        return view(d)


def delete(h, q, j):
    with lock:
        d = load()
        n = len(d["items"])
        d["items"] = [x for x in d["items"] if x["id"] != j.get("id")]
        if len(d["items"]) == n:
            return {"error": "no such reminder"}, 404
        save(d)
        return view(d)


def done(h, q, j):
    """service done: roll forward by the repeat interval (from today / the current km); no interval = remove"""
    with lock:
        d = load()
        it = next((x for x in d["items"] if x["id"] == j.get("id")), None)
        if not it:
            return {"error": "no such reminder"}, 404
        km, _ = km_now(d)
        if not it.get("every_months") and not it.get("every_km"):
            d["items"].remove(it)
        else:
            if it.get("every_months"):
                it["due_month"] = add_months(this_month(), it["every_months"])
            if it.get("every_km"):
                base = km if km is not None else it.get("due_km")
                if base is not None:
                    it["due_km"] = base + it["every_km"]
            it.pop("snooze_until", None)
            it["done_t"] = time.time()
        save(d)
        return view(d)


def snooze(h, q, j):
    """"Later": no notice for this reminder until tomorrow 04:00"""
    with lock:
        d = load()
        it = next((x for x in d["items"] if x["id"] == j.get("id")), None)
        if not it:
            return {"error": "no such reminder"}, 404
        lt = time.localtime(time.time() + 86400)
        it["snooze_until"] = time.mktime((lt.tm_year, lt.tm_mon, lt.tm_mday, 4, 0, 0, 0, 0, -1))
        save(d)
        return view(d)


def register(app):
    app.get("/api/car", get)
    app.post("/api/car/odo", set_odo)
    app.post("/api/car/save", put)
    app.post("/api/car/delete", delete)
    app.post("/api/car/done", done)
    app.post("/api/car/snooze", snooze)
    app.status("car", lambda: "%d reminders" % len(load()["items"]))
