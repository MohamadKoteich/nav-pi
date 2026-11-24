"""PN-64: /api/limits splits shapes over Valhalla's 16000-point limit and shifts indices back."""
import io, json, os, sys, unittest
from unittest import mock
sys.path.insert(0, os.path.join(os.path.dirname(__file__), "..", "features", "nav"))
import navd_nav as n


class LimitChunks(unittest.TestCase):
    def test_polyline_roundtrip(self):
        pts = [(47990000 + i * 37, 7850000 - i * 91) for i in range(50)] + [(-33865000, 151209000)]
        self.assertEqual(n._decode6(n._encode6(pts)), pts)

    def test_long_shape_is_chunked_and_offset(self):
        pts = [(48000000 + i * 10, 7800000 + i * 10) for i in range(2 * n.LIMIT_CHUNK + 501)]
        calls = []
        def fake(req, timeout=0):
            k = len(n._decode6(json.loads(req.data)["encoded_polyline"]))
            calls.append(k)
            self.assertLessEqual(k, 16000)
            return io.StringIO(json.dumps({"edges": [{"begin_shape_index": 0, "end_shape_index": k - 1, "speed_limit": 50}]}))
        with mock.patch("urllib.request.urlopen", fake):
            out = n.limits(None, None, {"shape": n._encode6(pts)})
        self.assertEqual(len(calls), 3)
        self.assertEqual([e[0] for e in out["edges"]], [0, n.LIMIT_CHUNK, 2 * n.LIMIT_CHUNK])
        self.assertEqual(out["edges"][-1][1], len(pts) - 1)


if __name__ == "__main__":
    unittest.main()
