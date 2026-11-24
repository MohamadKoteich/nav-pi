"""voice feature: speech queue (espeak-ng, or piper if PIPER_MODEL is set) behind POST /api/speak."""
import json, math, os, queue, shutil, socket, sqlite3, subprocess, threading, time  # noqa: F401,E401

VOICES = {"en": "en-gb", "de": "de"}  # espeak-ng voices per app language (English default)
PIPER_MODEL = os.environ.get("PIPER_MODEL", "")
PACK = os.path.join(os.environ.get("NAV_DATA", "/srv/navdata"), "voice")   # recorded clips (voice pack)


def clips(cue, lang):
    """paths of the recorded clips for a cue, or None if any is missing (then espeak reads the text)"""
    if not cue or not isinstance(cue, list):
        return None
    files = [os.path.join(PACK, lang, "%s.wav" % k) for k in cue if isinstance(k, str) and k.replace("_", "").isalnum()]
    return files if len(files) == len(cue) and all(os.path.exists(f) for f in files) else None
speech_q = queue.Queue(maxsize=4)


def chime_file():
    """a short two-tone warning chime (over-speed, PN-43), synthesised once into the runtime dir: no asset, no internet"""
    import struct, tempfile, wave
    path = os.path.join(tempfile.gettempdir(), "navpi-chime.wav")
    if not os.path.exists(path):
        rate, out = 22050, []
        for f, ms in ((988, 130), (740, 190)):
            n = rate * ms // 1000
            out += [int(9000 * math.sin(2 * math.pi * f * i / rate) * min(1, (n - i) / (rate * 0.06))) for i in range(n)]
        with wave.open(path, "wb") as w:
            w.setnchannels(1); w.setsampwidth(2); w.setframerate(rate)
            w.writeframes(b"".join(struct.pack("<h", s) for s in out))
    return path


def speech_loop():
    while True:
        text, lang, cue = speech_q.get()
        if cue == "@chime":
            try:
                subprocess.run(["pw-play", chime_file()], timeout=10)
            except Exception as e:
                print("chime:", e, flush=True)
            continue
        files = clips(cue, lang)
        if files:
            try:
                for f in files:
                    subprocess.run(["pw-play", f], timeout=20)
                continue
            except Exception as e:
                print("voice pack:", e, flush=True)
        try:
            piper = shutil.which("piper")
            if piper and PIPER_MODEL and os.path.exists(PIPER_MODEL):
                p = subprocess.run([piper, "--model", PIPER_MODEL, "--output-raw"], input=text.encode(),
                                   capture_output=True, timeout=30)
                subprocess.run(["pw-play", "--rate", "22050", "--channels", "1", "--format", "s16", "-"],
                               input=p.stdout, timeout=60)
            else:
                subprocess.run(["espeak-ng", "-v", VOICES.get(lang, "en-gb"), "-s", "160", text], timeout=60)
        except Exception as e:  # never let speech kill the service
            print("speech error:", e, flush=True)




def speak(h, q, j):
    text, lang, cue = str(j.get("text", ""))[:400], j.get("lang", "en"), j.get("cue")
    if text:
        try:
            speech_q.put_nowait((text, lang, cue))
        except queue.Full:
            pass
    return {"ok": True}


def chime(h, q, j):
    try:
        speech_q.put_nowait(("chime", "en", "@chime"))
    except queue.Full:
        pass
    return {"ok": True}


def register(app):
    app.thread(speech_loop)
    app.post("/api/chime", chime)
    app.post("/api/speak", speak)
    app.status("voice", lambda: ("recorded (Piper) + espeak-ng" if os.path.isdir(PACK) else "espeak-ng"))
