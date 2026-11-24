#!/usr/bin/env python3
"""Record a Valhalla /route + /trace_attributes pair as a test fixture for the speed-limit mapping.
   python3 tools/record_limits.py http://<valhalla>:8002 tools/fixtures/limits-munich.json 48.1402,11.5600 48.2595,11.4347
   (the fixture in the repo: Munich Hauptbahnhof -> Dachau, recorded from the oberbayern region)"""
import json, sys, urllib.request
base, out, a, b = sys.argv[1:5]


def post(path, body):
    return json.load(urllib.request.urlopen(urllib.request.Request(base + path, json.dumps(body).encode()), timeout=90))


def loc(s):
    return dict(zip(("lat", "lon"), map(float, s.split(","))))


route = post("/route", {"locations": [loc(a), loc(b)], "costing": "auto", "directions_options": {"language": "en-US", "units": "kilometers"}})
ta = post("/trace_attributes", {"encoded_polyline": route["trip"]["legs"][0]["shape"], "costing": "auto", "shape_match": "edge_walk",
                                "filters": {"action": "include", "attributes": ["edge.speed_limit", "edge.length", "edge.begin_shape_index", "edge.end_shape_index"]}})
json.dump({"route": route, "attrs": ta}, open(out, "w"))
e = ta["edges"]
total = sum(x["length"] for x in e)
print(len(e), "edges; with limit: %.0f%% of length" % (100 * sum(x["length"] for x in e if x.get("speed_limit")) / total))
