"""Backend tests for features/car (PN-51 service reminders). Run: python3 -m unittest tests/test_car.py"""
import importlib.util, json, os, shutil, tempfile, time, unittest

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))


def load(**env):
    os.environ.update(env)
    spec = importlib.util.spec_from_file_location("navd_car", os.path.join(ROOT, "features", "car", "navd_car.py"))
    m = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(m)
    return m


def trip_file(d, t, km, sim=False, finished=True):
    tid = time.strftime("%Y%m%d-%H%M%S", time.localtime(t)) + ("-sim" if sim else "")
    os.makedirs(os.path.join(d, "trips"), exist_ok=True)
    with open(os.path.join(d, "trips", tid + ".jsonl"), "w") as f:
        f.write(json.dumps({"id": tid, "start": t}) + "\n")
        f.write(json.dumps([t, 48.0, 8.0, 10.0]) + "\n")
        if finished:
            f.write(json.dumps({"end": t + 600, "dist": km * 1000}) + "\n")


class Car(unittest.TestCase):
    def setUp(self):
        self.t = tempfile.mkdtemp()
        self.m = load(NAV_DATA=self.t)

    def tearDown(self):
        shutil.rmtree(self.t)

    def call(self, fn, body=None):
        r = fn(None, {}, body or {})
        return r if isinstance(r, tuple) else (r, 200)

    def test_empty_and_file_created_on_save(self):
        v, _ = self.call(self.m.get)
        self.assertEqual(v["items"], [])
        self.assertIsNone(v["km"])
        self.assertFalse(os.path.exists(os.path.join(self.t, "car", "reminders.json")))
        self.call(self.m.put, {"kind": "oil", "due_km": 100000})
        self.assertTrue(os.path.exists(os.path.join(self.t, "car", "reminders.json")))

    def test_validation(self):
        bad = [{"kind": "x", "due_km": 1}, {"kind": "oil"}, {"kind": "custom", "due_km": 5},
               {"kind": "oil", "due_month": "2027-13"}, {"kind": "oil", "due_km": "abc"}, {"kind": "oil", "due_km": -4},
               {"kind": "oil", "due_km": 5, "every_months": 500}]
        for b in bad:
            _, code = self.call(self.m.put, b)
            self.assertEqual(code, 400, b)
        _, code = self.call(self.m.set_odo, {"km": "x"})
        self.assertEqual(code, 400)

    def test_odometer_plus_real_drives_since(self):
        self.call(self.m.set_odo, {"km": 100000})
        now = time.time()
        trip_file(self.t, now - 86400, 50)            # before the entry: ignored
        trip_file(self.t, now + 5, 12.4)              # after: counted
        trip_file(self.t, now + 10, 30, sim=True)     # simulated: never counted
        trip_file(self.t, now + 20, 99, finished=False)  # still recording: not yet
        v, _ = self.call(self.m.get)
        self.assertEqual(v["km"], 100012)
        self.assertEqual(v["kmSource"], "trip")

    def test_states_by_date_and_km(self):
        ym = self.m.this_month()
        self.call(self.m.set_odo, {"km": 50000})
        self.call(self.m.put, {"kind": "inspection", "due_month": ym})
        self.call(self.m.put, {"kind": "tyres", "due_month": self.m.add_months(ym, 1)})
        self.call(self.m.put, {"kind": "oil", "due_km": 50500})
        self.call(self.m.put, {"kind": "custom", "name": "Brakes", "due_km": 49000})
        self.call(self.m.put, {"kind": "custom", "name": "Later", "due_month": self.m.add_months(ym, 6), "due_km": 90000})
        v, _ = self.call(self.m.get)
        st = {(x["kind"], x["name"]): x["state"] for x in v["items"]}
        self.assertEqual(st[("inspection", "")], "due")
        self.assertEqual(st[("tyres", "")], "soon")
        self.assertEqual(st[("oil", "")], "soon")
        self.assertEqual(st[("custom", "Brakes")], "due")
        self.assertEqual(st[("custom", "Later")], "ok")
        self.assertEqual(v["items"][0]["state"], "due")       # due first

    def test_done_rolls_forward_or_removes(self):
        self.call(self.m.set_odo, {"km": 60000})
        v, _ = self.call(self.m.put, {"kind": "oil", "due_km": 59000, "due_month": "2020-01", "every_months": 12, "every_km": 15000})
        oid = v["items"][0]["id"]
        v, _ = self.call(self.m.done, {"id": oid})
        it = v["items"][0]
        self.assertEqual(it["due_km"], 75000)
        self.assertEqual(it["due_month"], self.m.add_months(self.m.this_month(), 12))
        self.assertEqual(it["state"], "ok")
        v, _ = self.call(self.m.put, {"kind": "custom", "name": "Once", "due_km": 1})
        once = next(x for x in v["items"] if x["name"] == "Once")["id"]
        v, _ = self.call(self.m.done, {"id": once})
        self.assertEqual(len(v["items"]), 1)

    def test_snooze_edit_delete(self):
        v, _ = self.call(self.m.put, {"kind": "inspection", "due_month": "2020-05"})
        rid = v["items"][0]["id"]
        v, _ = self.call(self.m.snooze, {"id": rid})
        self.assertTrue(v["items"][0]["snoozed"])
        v, _ = self.call(self.m.put, {"id": rid, "kind": "inspection", "due_month": "2099-05"})
        self.assertEqual(v["items"][0]["due_month"], "2099-05")
        self.assertEqual(len(v["items"]), 1)
        _, code = self.call(self.m.put, {"id": "nope", "kind": "oil", "due_km": 5})
        self.assertEqual(code, 404)
        v, _ = self.call(self.m.delete, {"id": rid})
        self.assertEqual(v["items"], [])
        # survives a restart (new module instance reading the same file)
        self.call(self.m.put, {"kind": "tyres", "due_month": "2030-10"})
        m2 = load(NAV_DATA=self.t)
        self.assertEqual(len(m2.get(None, {}, {})["items"]), 1)


if __name__ == "__main__":
    unittest.main()
