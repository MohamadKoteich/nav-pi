#!/usr/bin/env python3
"""Render the navigation voice pack (short recorded phrases) through a text-to-speech HTTP service, e.g. one
running Piper voices.

    build_voicepack.py OUT_DIR --url http://localhost:5000 [--langs en,de]     (or NAVPI_VOICE_URL=<url>)

HTTP contract the service must implement (one request per phrase):

    POST <url>/api/tts
    Content-Type: application/json
    {"text": "In 300 meters,", "lang": "en", "voice": "piper:en_US-lessac-medium", "format": "wav"}

    -> 200, body = the WAV file bytes (any sample rate, mono or stereo; at least 1000 bytes)

"voice" is the VOICES entry of the language below (rename it to whatever your service calls its voices).
http:// and https:// both work; for https the certificate is not checked (a local service is usually self-signed).

OUT_DIR/<lang>/<key>.wav + OUT_DIR/manifest.json. On the Pi navd plays cue keys back to back
(e.g. in_300m + turn_right); anything without a clip falls back to espeak-ng reading the text.
"""
import argparse
import json
import os
import ssl
import sys
import time
import urllib.request

VOICES = {"en": "piper:en_US-lessac-medium", "de": "piper:de_DE-thorsten-medium"}
ORD_EN = ["first", "second", "third", "fourth", "fifth", "sixth", "seventh", "eighth"]
ORD_DE = ["erste", "zweite", "dritte", "vierte", "fünfte", "sechste", "siebte", "achte"]
NUM_DE = {1: "einem", 1.5: "eineinhalb", 2: "zwei", 2.5: "zweieinhalb", 3: "drei", 3.5: "dreieinhalb", 4: "vier",
          4.5: "viereinhalb", 5: "fünf", 6: "sechs", 7: "sieben", 8: "acht", 9: "neun", 10: "zehn"}
NUM_EN = {1: "one", 1.5: "one and a half", 2: "two", 2.5: "two and a half", 3: "three", 3.5: "three and a half", 4: "four",
          4.5: "four and a half", 5: "five", 6: "six", 7: "seven", 8: "eight", 9: "nine", 10: "ten"}
KMS = [1, 1.5, 2, 2.5, 3, 3.5, 4, 4.5, 5, 6, 7, 8, 9, 10]


def km_key(k):
    return "in_%skm" % str(k).replace(".", "_")


def phrases():
    P = {"en": {}, "de": {}}
    for m in range(50, 1000, 50):
        P["en"]["in_%dm" % m] = "In %d meters," % m
        P["de"]["in_%dm" % m] = "In %d Metern" % m
    for k in KMS:
        P["en"][km_key(k)] = "In %s kilometer%s," % (NUM_EN[k], "" if k == 1 else "s")
        P["de"][km_key(k)] = "In %s Kilometer%s" % (NUM_DE[k], "" if k == 1 else "n")
    A = {  # action key: (en, de)
        "turn_right": ("turn right.", "rechts abbiegen."), "turn_left": ("turn left.", "links abbiegen."),
        "slight_right": ("bear right.", "leicht rechts abbiegen."), "slight_left": ("bear left.", "leicht links abbiegen."),
        "sharp_right": ("make a sharp right.", "scharf rechts abbiegen."), "sharp_left": ("make a sharp left.", "scharf links abbiegen."),
        "uturn": ("make a U-turn.", "wenden."), "straight": ("continue straight.", "geradeaus weiterfahren."),
        "keep_right": ("keep right.", "rechts halten."), "keep_left": ("keep left.", "links halten."),
        "keep_straight": ("keep straight.", "geradeaus halten."),
        "exit_right": ("take the exit on the right.", "die Ausfahrt rechts nehmen."),
        "exit_left": ("take the exit on the left.", "die Ausfahrt links nehmen."),
        "ramp_right": ("take the ramp on the right.", "rechts auf die Auffahrt fahren."),
        "ramp_left": ("take the ramp on the left.", "links auf die Auffahrt fahren."),
        "ramp_straight": ("take the ramp.", "auf die Auffahrt fahren."),
        "merge": ("merge.", "einfädeln."), "merge_right": ("merge right.", "rechts einfädeln."), "merge_left": ("merge left.", "links einfädeln."),
        "ferry": ("board the ferry.", "auf die Fähre fahren."),
        "arrive": ("you will reach your destination.", "erreichen Sie Ihr Ziel."),
        "roundabout": ("enter the roundabout.", "in den Kreisverkehr fahren."),
    }
    for k, (en, de) in A.items():
        P["en"][k] = en
        P["de"][k] = de
    for i in range(8):
        P["en"]["roundabout_%d" % (i + 1)] = "at the roundabout, take the %s exit." % ORD_EN[i]
        P["de"]["roundabout_%d" % (i + 1)] = "im Kreisverkehr die %s Ausfahrt nehmen." % ORD_DE[i]
    # actions said "now" (no distance) start with a capital in a sentence of their own
    for lang in ("en", "de"):
        for k in list(P[lang]):
            if not k.startswith("in_"):
                t = P[lang][k]
                P[lang]["now_" + k] = t[0].upper() + t[1:]
    P["en"].update({"arrived": "You have arrived at your destination.", "reroute": "Recalculating route.", "go": "Let's go.",
                    "stop_reached": "You have reached your stop.", "then": "Then", "test": "This is a test of the navigation voice."})
    P["de"].update({"arrived": "Sie haben Ihr Ziel erreicht.", "reroute": "Route wird neu berechnet.", "go": "Los geht's.",
                    "stop_reached": "Sie haben Ihren Zwischenstopp erreicht.", "then": "Danach", "test": "Dies ist ein Test der Navigationsstimme."})
    return P


def render(url, ctx, text, lang, voice):
    body = json.dumps({"text": text, "lang": lang, "voice": voice, "format": "wav"}).encode()
    req = urllib.request.Request(url + "/api/tts", data=body, headers={"Content-Type": "application/json"})
    with urllib.request.urlopen(req, timeout=60, context=ctx) as r:
        return r.read()


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("out")
    ap.add_argument("--url", default=os.environ.get("NAVPI_VOICE_URL"), help="base URL of the TTS service")
    ap.add_argument("--langs", default="en,de")
    a = ap.parse_args()
    if not a.url:
        ap.error("--url (or NAVPI_VOICE_URL) is required: the TTS service that renders the phrases")
    ctx = ssl.create_default_context()
    ctx.check_hostname = False
    ctx.verify_mode = ssl.CERT_NONE  # a local TTS service often uses a self-signed certificate (local only)
    P = phrases()
    manifest = {"voices": {}, "built": time.strftime("%Y-%m-%dT%H:%M:%S"), "keys": {}}
    for lang in a.langs.split(","):
        d = os.path.join(a.out, lang)
        os.makedirs(d, exist_ok=True)
        manifest["voices"][lang] = VOICES[lang]
        manifest["keys"][lang] = P[lang]
        n = 0
        for key, text in P[lang].items():
            f = os.path.join(d, key + ".wav")
            if os.path.exists(f) and os.path.getsize(f) > 1000:
                continue
            data = render(a.url, ctx, text, lang, VOICES[lang])
            if len(data) < 1000:
                sys.exit("the TTS service returned no audio for %s/%s" % (lang, key))
            open(f + ".part", "wb").write(data)
            os.replace(f + ".part", f)
            n += 1
        print("%s: %d phrases (%d rendered now)" % (lang, len(P[lang]), n), flush=True)
    json.dump(manifest, open(os.path.join(a.out, "manifest.json"), "w"), indent=1, ensure_ascii=False)


if __name__ == "__main__":
    main()
