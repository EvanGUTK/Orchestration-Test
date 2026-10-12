"""Tests for oracle_cli.py (the differential-fuzzing front end)."""

from __future__ import annotations

import json
import os
import subprocess
import sys
import unittest

HERE = os.path.dirname(os.path.abspath(__file__))
CLI = os.path.join(HERE, "oracle_cli.py")
VECTORS = os.path.normpath(os.path.join(HERE, "..", "vectors", "engine-v1.json"))


def run_cli(payload) -> dict:
    proc = subprocess.run([sys.executable, CLI], input=json.dumps(payload).encode("utf-8"),
                          capture_output=True, check=True)
    return json.loads(proc.stdout.decode("utf-8"))


class OracleCli(unittest.TestCase):
    def test_reproduces_golden_move_sequences(self):
        with open(VECTORS, encoding="utf-8") as fh:
            doc = json.load(fh)
        cases = [{"id": i, "seed": s["seed"], "size": 4, "directions": s["directions"]}
                 for i, s in enumerate(doc["moveSequences"])]
        out = run_cli({"cases": cases})["results"]
        for res, seq in zip(out, doc["moveSequences"]):
            self.assertEqual(res["initial"]["checksum"], seq["initial"]["checksum"])
            self.assertEqual([s["checksum"] for s in res["steps"]],
                             [s["checksum"] for s in seq["steps"]])
            self.assertEqual([s["rngWords"] for s in res["steps"]],
                             [s["rngWords"] for s in seq["steps"]])
            self.assertEqual(res["final"]["canonicalJson"], seq["final"]["canonicalJson"])

    def test_single_case_and_unicode_seed(self):
        out = run_cli({"seed": "ünïcødé", "size": 3, "fourWeight": 10,
                       "rulesetVersion": "practice-v1", "directions": ["left"]})
        res = out["results"][0]
        self.assertIn('"rulesetVersion":"practice-v1"', res["initial"]["canonicalJson"])
        # fourWeight 10: every spawn is exponent "2"
        cells = json.loads(res["initial"]["canonicalJson"])["board"]["cells"]
        self.assertEqual(sorted(c for c in cells if c), ["2", "2"])

    def test_game_not_active_recorded(self):
        # 3x3 with many moves eventually completes for some seed; search a few.
        for k in range(200):
            res = run_cli({"seed": "end-%d" % k, "size": 3,
                           "directions": ["up", "left", "down", "right"] * 60})["results"][0]
            errors = [s["error"] for s in res["steps"] if s["error"]]
            if errors:
                self.assertEqual(set(errors), {"GAME_NOT_ACTIVE"})
                first = next(i for i, s in enumerate(res["steps"]) if s["error"])
                self.assertEqual(res["steps"][first - 1]["status"], "completed")
                return
        self.fail("no 3x3 game completed within the search")


if __name__ == "__main__":
    unittest.main()
