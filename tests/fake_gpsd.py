"""A tiny fake gpsd (TCP, JSON protocol as gpsd 3.25 speaks it) for tests of features/gps — no receiver needed.

A connecting client gets VERSION; after `?WATCH={"enable":true,"json":true}` it gets DEVICES + WATCH and then, every
`interval` seconds, TPV (+ SKY with a satellite list and a DOP-only SKY, like gpsd with a u-blox). The simulated car
drives along `path` ([[lon, lat], ...]) at `speed` m/s from the moment the server starts; the state decides what is sent:
  fix        TPV mode 3 with the position, SKY with 12 satellites (8 used)
  loss       TPV mode 1 (no position: a tunnel), SKY with 2 weak unused satellites; the car keeps driving
  unplugged  DEVICES with an empty list once, then silence (receiver pulled)
State changes: FakeGpsd.set(state) or a line "fix" / "loss" / "unplugged" on the control port (CLI use; the line "pos" answers
"lon lat track" of the car):
  python3 tests/fake_gpsd.py --port 29470 --control 29471 [--path route.json] [--speed 15] [--state fix]
"""
import argparse, json, math, socket, threading, time

DEV = {"class": "DEVICE", "path": "/dev/ttyACM0", "driver": "u-blox", "subtype": "SW EXT CORE 4.04 (7f89f7),HW 00190000",
       "activated": "2026-11-12T10:00:00.000Z", "flags": 1, "native": 1, "bps": 9600, "parity": "N", "stopbits": 1, "cycle": 1.0}
# (PRN, elevation, azimuth, dB-Hz, used, gnssid): the sky of a car park in Munich, recorded-style
SATS = [(2, 45, 120, 41, 1, 0), (5, 62, 200, 44, 1, 0), (7, 30, 310, 38, 1, 0), (13, 15, 20, 31, 0, 0), (15, 70, 80, 46, 1, 0),
        (20, 25, 250, 35, 1, 0), (29, 55, 330, 43, 1, 0), (30, 8, 170, 24, 0, 0), (211, 40, 140, 39, 1, 2), (212, 20, 60, 33, 1, 2),
        (233, 12, 290, 27, 0, 2), (131, 36, 160, 30, 0, 1)]
LOSS_SATS = [(13, 15, 20, 12, 0, 0), (30, 8, 170, 9, 0, 0)]


def iso(t):
    return time.strftime("%Y-%m-%dT%H:%M:%S", time.gmtime(t)) + ".%03dZ" % int((t % 1) * 1000)


def hav(a, b):
    k = math.pi / 180
    x = math.sin((b[1] - a[1]) * k / 2) ** 2 + math.cos(a[1] * k) * math.cos(b[1] * k) * math.sin((b[0] - a[0]) * k / 2) ** 2
    return 2 * 6371000 * math.asin(math.sqrt(x))


def bearing(a, b):
    k = math.pi / 180
    y = math.sin((b[0] - a[0]) * k) * math.cos(b[1] * k)
    x = math.cos(a[1] * k) * math.sin(b[1] * k) - math.sin(a[1] * k) * math.cos(b[1] * k) * math.cos((b[0] - a[0]) * k)
    return (math.atan2(y, x) / k + 360) % 360


class FakeGpsd:
    def __init__(self, port=0, path=None, speed=15.0, interval=1.0, state="fix", control_port=None):
        self.path = path or [[7.85, 48.0], [7.85, 48.1]]
        self.speed, self.interval, self.state = speed, interval, state
        self.t0 = time.time()
        self.cum = [0.0]
        for a, b in zip(self.path, self.path[1:]):
            self.cum.append(self.cum[-1] + hav(a, b))
        self.srv = socket.socket(); self.srv.setsockopt(socket.SOL_SOCKET, socket.SO_REUSEADDR, 1)
        self.srv.bind(("127.0.0.1", port)); self.srv.listen(5)
        self.port = self.srv.getsockname()[1]
        self.ctl, self.control_port = None, None
        if control_port is not None:
            self.ctl = socket.socket(); self.ctl.setsockopt(socket.SOL_SOCKET, socket.SO_REUSEADDR, 1)
            self.ctl.bind(("127.0.0.1", control_port)); self.ctl.listen(2); self.control_port = self.ctl.getsockname()[1]
        self.closed = False

    def start(self):
        threading.Thread(target=self._accept, args=(self.srv, self._client), daemon=True).start()
        if self.ctl:
            threading.Thread(target=self._accept, args=(self.ctl, self._control), daemon=True).start()
        return self

    def stop(self):
        self.closed = True
        for s in (self.srv, self.ctl):
            try:
                s and s.close()
            except OSError:
                pass

    def set(self, state):
        assert state in ("fix", "loss", "unplugged")
        self.state = state

    def car(self, now=None):
        """(lon, lat, track) of the simulated car, clamped at the end of the path."""
        d = min(self.cum[-1], self.speed * ((now or time.time()) - self.t0))
        i = max(0, min(len(self.path) - 2, next((k for k in range(len(self.cum) - 1) if self.cum[k + 1] >= d), len(self.path) - 2)))
        seg = (self.cum[i + 1] - self.cum[i]) or 1.0
        t = (d - self.cum[i]) / seg
        a, b = self.path[i], self.path[i + 1]
        return a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t, bearing(a, b)

    def tpv(self, now):
        base = {"class": "TPV", "device": DEV["path"], "time": iso(now)}
        if self.state == "loss":
            return dict(base, mode=1)
        lon, lat, trk = self.car(now)
        return dict(base, mode=3, ept=0.005, lat=lat, lon=lon, altHAE=290.1, altMSL=243.9, alt=243.9, epx=3.1, epy=4.0, epv=8.2,
                    track=round(trk, 2), speed=self.speed, climb=0.0, eps=0.8, epc=1.6, eph=4.2)

    def sky(self, sats, now):
        return [{"class": "SKY", "device": DEV["path"], "time": iso(now), "xdop": 0.8, "ydop": 1.1, "vdop": 1.4, "tdop": 0.9,
                 "hdop": 1.3 if sats is SATS else 9.9, "gdop": 2.4, "pdop": 1.9},
                {"class": "SKY", "device": DEV["path"], "time": iso(now), "nSat": len(sats), "uSat": sum(s[4] for s in sats),
                 "satellites": [{"PRN": p, "el": e, "az": a, "ss": ss, "used": bool(u), "gnssid": g, "svid": p % 100, "health": 1}
                                for p, e, a, ss, u, g in sats]}]

    def _accept(self, srv, handler):
        while not self.closed:
            try:
                c, _ = srv.accept()
            except OSError:
                return
            threading.Thread(target=handler, args=(c,), daemon=True).start()

    def _control(self, c):
        with c, c.makefile("r") as f:
            for line in f:
                w = line.strip()
                if w in ("fix", "loss", "unplugged"):
                    self.set(w); c.sendall(b"ok\n")
                elif w == "pos":   # where the simulated car is now: "lon lat track"
                    c.sendall(("%.7f %.7f %.1f\n" % self.car()).encode())

    def _client(self, c):
        def send(o):
            c.sendall((json.dumps(o) + "\n").encode())
        try:
            with c:
                send({"class": "VERSION", "release": "3.25", "rev": "3.25", "proto_major": 3, "proto_minor": 15})
                c.settimeout(0.2)
                buf, watching, plugged = b"", False, None
                while not self.closed:
                    try:
                        d = c.recv(4096)
                        if not d:
                            return
                        buf += d
                    except socket.timeout:
                        pass
                    if b"?WATCH" in buf:
                        watching = True
                    if not watching:
                        continue
                    now = time.time()
                    up = self.state != "unplugged"
                    if up != plugged:
                        plugged = up
                        send({"class": "DEVICES", "devices": [DEV] if up else []})
                        if watching and buf:
                            send({"class": "WATCH", "enable": True, "json": True, "nmea": False, "raw": 0, "scaled": False, "timing": False})
                            buf = b""
                    if up:
                        send(self.tpv(now))
                        for m in self.sky(SATS if self.state == "fix" else LOSS_SATS, now):
                            send(m)
                    time.sleep(self.interval)
        except OSError:
            return


if __name__ == "__main__":
    ap = argparse.ArgumentParser()
    ap.add_argument("--port", type=int, default=29470)
    ap.add_argument("--control", type=int, default=29471)
    ap.add_argument("--path", help="JSON file: [[lon, lat], ...]")
    ap.add_argument("--speed", type=float, default=15.0)
    ap.add_argument("--interval", type=float, default=1.0)
    ap.add_argument("--state", default="fix")
    a = ap.parse_args()
    g = FakeGpsd(a.port, json.load(open(a.path)) if a.path else None, a.speed, a.interval, a.state, a.control).start()
    print("fake gpsd on %d, control %d, state %s" % (g.port, g.control_port, g.state), flush=True)
    while True:
        time.sleep(3600)
