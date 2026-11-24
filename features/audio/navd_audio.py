"""audio feature: output device and volume through PipeWire (wpctl)."""
import json, math, os, queue, shutil, socket, sqlite3, subprocess, threading, time  # noqa: F401,E401

def wpctl(*args):
    try:
        return subprocess.run(["wpctl", *args], capture_output=True, text=True, timeout=5).stdout
    except Exception:
        return ""


def audio_state():
    vol = wpctl("get-volume", "@DEFAULT_AUDIO_SINK@")  # "Volume: 0.40 [MUTED]"
    sink = ""
    for line in wpctl("inspect", "@DEFAULT_AUDIO_SINK@").splitlines():
        if "node.description" in line:
            sink = line.split("=", 1)[1].strip().strip('"')
    try:
        v = float(vol.split()[1])
    except (IndexError, ValueError):
        v = None
    return {"output": sink or "", "volume": v, "muted": "MUTED" in vol}



def post_audio(h, q, j):
    if "volume" in j:
        v = max(0.0, min(1.0, float(j["volume"])))
        wpctl("set-volume", "@DEFAULT_AUDIO_SINK@", "%.2f" % v)
        wpctl("set-mute", "@DEFAULT_AUDIO_SINK@", "0")
    return audio_state()


def register(app):
    app.get("/api/audio", lambda h, q, j: audio_state())
    app.post("/api/audio", post_audio)
