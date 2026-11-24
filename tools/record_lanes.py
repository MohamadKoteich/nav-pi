"""Record a real route + its lanes for tools/test-lanes.mjs (PN-36/40): Munich -> Ingolstadt over the A9, from the
local Valhalla 3.5.1 (VALHALLA_URL, e.g. a Valhalla container on the build PC), through navd_nav.lanes() exactly as the app gets it.
  VALHALLA_URL=http://<valhalla>:8002 python3 tools/record_lanes.py   -> tools/fixtures/lanes-munich-ingolstadt.json
Works with the oberbayern region (or germany). Also prints which maneuvers got lanes."""
import json, os, sys, urllib.request
sys.path.insert(0, os.path.join(os.path.dirname(__file__), "..", "features", "nav"))
import navd_nav as n  # noqa: E402

body = {"locations": [{"lat": 48.1371, "lon": 11.5754}, {"lat": 48.7630, "lon": 11.4250}], "costing": "auto",
        "directions_options": {"units": "kilometers", "language": "de-DE"}}
req = urllib.request.Request(n.VALHALLA_URL + "/route", json.dumps(body).encode(), {"Content-Type": "application/json"})
trip = json.load(urllib.request.urlopen(req, timeout=60))["trip"]
leg = trip["legs"][0]
lanes = n.lanes(None, None, {"shape": leg["shape"]})
keep = ("type", "instruction", "begin_shape_index", "street_names", "highway", "time", "length",
        "verbal_pre_transition_instruction", "verbal_transition_alert_instruction", "verbal_succinct_transition_instruction", "roundabout_exit_count")
fx = {"route": {"summary": trip["summary"], "legs": [{"shape": leg["shape"], "maneuvers": [{k: m[k] for k in keep if k in m} for m in leg["maneuvers"]]}]},
      "lanes": lanes, "valhalla": json.load(urllib.request.urlopen(n.VALHALLA_URL + "/status", timeout=10)).get("version")}
out = os.path.join(os.path.dirname(__file__), "fixtures", "lanes-munich-ingolstadt.json")
json.dump(fx, open(out, "w"), separators=(",", ":"))
print("route %.1f km, %d maneuvers, %d step points, Valhalla %s -> %s" % (trip["summary"]["length"], len(leg["maneuvers"]), len(lanes["points"]), fx["valhalla"], out))
for m, p in zip(leg["maneuvers"], lanes["points"]):
    ln = p["lanes"]
    print("%2d %-60s %s" % (m["type"], m["instruction"][:60], " ".join(("*" if v else ".") + i for i, v, _ in ln) if ln else "-"))
