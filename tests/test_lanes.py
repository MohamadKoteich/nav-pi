"""PN-36/40: /api/lanes asks Valhalla /trace_route (format osrm, edge_walk) and returns one compact point per step."""
import io, json, os, sys, unittest
from unittest import mock
sys.path.insert(0, os.path.join(os.path.dirname(__file__), "..", "features", "nav"))
import navd_nav as n

STEP = {"intersections": [{"location": [8.380269, 48.955295], "bearings": [53, 77, 231], "in": 2, "out": 1,
                           "lanes": [{"indications": ["straight"], "valid": False, "active": False},
                                     {"indications": ["slight right"], "valid_indication": "slight right", "valid": True, "active": True}]},
                          {"location": [8.39, 48.96], "bearings": [0, 180], "in": 1, "out": 0}]}
PLAIN = {"intersections": [{"location": [8.4, 49.0], "bearings": [90], "out": 0}]}


class Lanes(unittest.TestCase):
    def test_request_and_compact_answer(self):
        sent = []
        def fake(req, timeout=0):
            sent.append((req.full_url, json.loads(req.data)))
            return io.StringIO(json.dumps({"matchings": [{"legs": [{"steps": [PLAIN, STEP]}]}]}))
        pts = [(48000000 + i * 10, 7800000 + i * 10) for i in range(20)]
        with mock.patch("urllib.request.urlopen", fake):
            out = n.lanes(None, None, {"shape": n._encode6(pts)})
        url, body = sent[0]
        self.assertTrue(url.endswith("/trace_route"))
        self.assertEqual((body["format"], body["shape_match"]), ("osrm", "edge_walk"))
        self.assertEqual(len(out["points"]), 2)   # one per step, only the first intersection of each
        self.assertIsNone(out["points"][0]["lanes"])
        p = out["points"][1]
        self.assertEqual(p["at"], [8.380269, 48.955295])
        self.assertEqual(p["lanes"], [["straight", 0, ""], ["slight right", 1, "slight right"]])
        self.assertEqual((p["b"], p["in"], p["out"]), ([53, 77, 231], 2, 1))

    def test_missing_shape_and_valhalla_down(self):
        self.assertEqual(n.lanes(None, None, {})[1], 400)
        with mock.patch("urllib.request.urlopen", side_effect=OSError("refused")):
            self.assertEqual(n.lanes(None, None, {"shape": n._encode6([(48000000, 7800000), (48000100, 7800100)])})[1], 502)


if __name__ == "__main__":
    unittest.main()
