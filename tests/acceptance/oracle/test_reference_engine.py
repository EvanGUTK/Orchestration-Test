"""Unit tests for the independent CONTRACT-001 reference oracle.

Run: python3 -m unittest discover -s tests/acceptance/oracle -v
"""

from __future__ import annotations

import copy
import json
import os
import random
import sys
import unittest

HERE = os.path.dirname(os.path.abspath(__file__))
if HERE not in sys.path:
    sys.path.insert(0, HERE)

import generate_vectors as G  # noqa: E402
import reference_engine as R  # noqa: E402

REPO_ROOT = os.path.normpath(os.path.join(HERE, "..", "..", ".."))
SLIDE_FIXTURE = os.path.join(REPO_ROOT, "tests", "fixtures", "slide-v1.json")


def _random_board(rnd: random.Random, size: int, fill: float = 0.6, max_e: int = 6):
    return {"size": size,
            "cells": [str(rnd.randint(1, max_e)) if rnd.random() < fill else None
                      for _ in range(size * size)]}


def _rotate_cw(board):
    n = board["size"]
    c = board["cells"]
    return {"size": n, "cells": [c[(n - 1 - col) * n + row]
                                 for row in range(n) for col in range(n)]}


class PublicSlideFixture(unittest.TestCase):
    def test_all_slide_v1_vectors(self):
        with open(SLIDE_FIXTURE, encoding="utf-8") as fh:
            fixture = json.load(fh)
        vectors = fixture["vectors"]
        self.assertEqual(len(vectors), 11)
        for v in vectors:
            with self.subTest(id=v["id"]):
                before = {"size": v["size"], "cells": list(v["before"])}
                snapshot = copy.deepcopy(before)
                res = R.slide(before, v["direction"])
                self.assertEqual(res["board"]["cells"], v["after"])
                self.assertEqual(res["scoreDelta"], v["scoreDelta"])
                self.assertEqual(res["changed"], v["changed"])
                self.assertEqual(before, snapshot, "slide mutated its input")


class Prng(unittest.TestCase):
    # Published xoshiro128** reference outputs for state {1, 2, 3, 4}
    # (independent of this file's implementation).
    REFERENCE_1234 = [11520, 0, 5927040, 70819200, 2031721883, 1637235492,
                      1287239034, 3734860849, 3729100597, 4258142804]

    def test_reference_state_1234(self):
        rng = R.Xoshiro128ss([1, 2, 3, 4])
        self.assertEqual([rng.next_u32() for _ in range(10)], self.REFERENCE_1234)

    def test_seed_derivation_little_endian(self):
        digest = R.seed_digest("abc")
        self.assertEqual(digest, __import__("hashlib").sha256(b"2048-infinite/v1:abc").digest())
        words = R.derive_words("abc")
        self.assertEqual(words[0], digest[0] | digest[1] << 8 | digest[2] << 16 | digest[3] << 24)

    def test_zero_digest_substitution(self):
        self.assertEqual(R.words_from_digest(bytes(32)), [1, 0, 0, 0])
        self.assertEqual(R.words_from_digest(bytes(16) + b"\xff" * 16), [1, 0, 0, 0])

    def test_zero_state_rejected(self):
        with self.assertRaises(ValueError):
            R.Xoshiro128ss([0, 0, 0, 0])

    def test_unicode_seed_uses_utf8(self):
        self.assertEqual(R.seed_digest("ünïcødé"),
                         __import__("hashlib").sha256("2048-infinite/v1:ünïcødé".encode("utf-8")).digest())

    def test_uniform_bounds_and_draw_accounting(self):
        rng = R.Xoshiro128ss.from_seed("abc")
        self.assertEqual(R.uniform(rng, 1), 0)
        self.assertEqual(rng.draws, 1, "uniform(1) must still consume one draw")
        for n in (2, 3, 10, 15, 16, 2 ** 32 - 1, 2 ** 32):
            x = R.uniform(rng, n)
            self.assertTrue(0 <= x < n)
        for bad in (0, -1, 2 ** 32 + 1):
            with self.assertRaises(ValueError):
                R.uniform(rng, bad)

    def test_rejection_consumes_state(self):
        case = G.gen_uniform()["rejectionCase"]
        self.assertGreaterEqual(len(case["rejectedRawDraws"]), 1)
        self.assertTrue(all(x >= case["limit"] for x in case["rejectedRawDraws"]))
        self.assertEqual(case["rawDrawsConsumed"], len(case["rejectedRawDraws"]) + 1)
        rng = R.Xoshiro128ss(case["initialWords"])
        for _ in range(case["rawDrawsConsumed"]):
            rng.next_u32()
        self.assertEqual(rng.words(), case["wordsAfter"])


class SlideInvariants(unittest.TestCase):
    def test_mass_conservation_and_score_delta(self):
        rnd = random.Random(20261012)
        for _ in range(500):
            size = rnd.randint(2, 8)
            board = _random_board(rnd, size)
            for d in R.DIRECTIONS:
                res = R.slide(board, d)
                self.assertEqual(R.board_mass(res["board"]), R.board_mass(board))
                self.assertEqual(int(res["scoreDelta"]),
                                 sum(int(m["value"]) for m in res["merges"]))
                tiles_before = sum(c is not None for c in board["cells"])
                tiles_after = sum(c is not None for c in res["board"]["cells"])
                self.assertEqual(tiles_before - tiles_after, len(res["merges"]))

    def test_rotation_consistency(self):
        # Rotating the board clockwise maps up->right, right->down, ...
        rnd = random.Random(7)
        nxt = {"up": "right", "right": "down", "down": "left", "left": "up"}
        for _ in range(200):
            board = _random_board(rnd, rnd.randint(2, 6))
            for d in R.DIRECTIONS:
                a = _rotate_cw(R.slide(board, d)["board"])
                b = R.slide(_rotate_cw(board), nxt[d])
                self.assertEqual(a, b["board"])

    def test_slide_is_idempotent_after_no_merge(self):
        board = {"size": 4, "cells": ["1", "2", None, None] + [None] * 12}
        self.assertFalse(R.slide(board, "left")["changed"])

    def test_game_over(self):
        dead = {"size": 2, "cells": ["1", "2", "2", "1"]}
        live_h = {"size": 2, "cells": ["1", "1", "2", "3"]}
        live_v = {"size": 2, "cells": ["1", "2", "1", "3"]}
        with_empty = {"size": 2, "cells": ["1", "2", "2", None]}
        self.assertTrue(R.is_game_over(dead))
        self.assertFalse(R.is_game_over(live_h))
        self.assertFalse(R.is_game_over(live_v))
        self.assertFalse(R.is_game_over(with_empty))
        self.assertEqual(R.legal_moves(dead), [])


class MoveInvariants(unittest.TestCase):
    def test_noop_consumes_zero_draws_and_changes_nothing(self):
        state = R.new_game({"size": 4}, "abc")
        # Repeat one direction until it becomes a no-op.
        d = "left"
        for _ in range(32):
            if not R.slide(state["board"], d)["changed"]:
                break
            state = R.apply_move(state, d)["state"]
        else:
            self.fail("expected repeated left moves to reach a no-op")
        self.assertGreater(state["acceptedMoves"], 0)
        snapshot = copy.deepcopy(state)
        res = R.apply_move(state, d)
        self.assertFalse(res["changed"])
        self.assertEqual(res["scoreDelta"], "0")
        self.assertEqual(res["draws"], 0)
        self.assertIsNone(res["spawn"])
        self.assertEqual(res["state"], snapshot)
        self.assertEqual(R.checksum(res["state"]), R.checksum(snapshot))
        self.assertEqual(state, snapshot, "apply_move mutated its input")

    def test_changed_move_spawns_once_and_conserves_mass(self):
        rnd = random.Random(99)
        for i in range(300):
            state = R.new_game({"size": rnd.randint(3, 8)}, "prop-%d" % i)
            for _ in range(rnd.randint(1, 30)):
                if state["status"] != "active":
                    break
                d = rnd.choice(R.DIRECTIONS)
                snapshot = copy.deepcopy(state)
                slid = R.slide(state["board"], d)
                res = R.apply_move(state, d)
                self.assertEqual(state, snapshot, "apply_move mutated its input")
                if not res["changed"]:
                    self.assertEqual(res["state"], state)
                    continue
                new = res["state"]
                spawned = res["spawn"]
                self.assertIsNone(slid["board"]["cells"][spawned["index"]])
                self.assertEqual(new["board"]["cells"][spawned["index"]], spawned["exponent"])
                diff = [k for k in range(len(new["board"]["cells"]))
                        if new["board"]["cells"][k] != slid["board"]["cells"][k]]
                self.assertEqual(diff, [spawned["index"]])
                self.assertEqual(R.board_mass(new["board"]),
                                 R.board_mass(state["board"]) + R.tile_value(spawned["exponent"]))
                self.assertEqual(int(new["score"]), int(state["score"]) + int(res["scoreDelta"]))
                self.assertEqual(new["acceptedMoves"], state["acceptedMoves"] + 1)
                self.assertEqual(new["revision"], state["revision"] + 1)
                self.assertGreaterEqual(res["draws"], 2)
                state = new

    def test_non_active_game_rejected(self):
        for status in ("completed", "forfeited"):
            s = R.new_game({"size": 4}, "abc")
            s["status"] = status
            snapshot = copy.deepcopy(s)
            with self.assertRaises(R.EngineError) as ctx:
                R.apply_move(s, "left")
            self.assertEqual(ctx.exception.code, "GAME_NOT_ACTIVE")
            self.assertEqual(s, snapshot)

    def test_move_cap_completes(self):
        s = R.new_game({"size": 4, "version": "ranked-v1"}, "cap")
        self.assertEqual(s["rulesetVersion"], "ranked-v1")
        s["acceptedMoves"] = 499
        s["revision"] = 499
        for d in R.DIRECTIONS:
            r = R.apply_move(s, d, {"moveCap": 500})
            if r["changed"]:
                self.assertEqual(r["state"]["acceptedMoves"], 500)
                self.assertEqual(r["state"]["status"], "completed")
                break
        else:
            self.fail("no changed move")

    def test_new_game_has_two_tiles(self):
        for size in (3, 4, 8):
            g = R.new_game({"size": size}, "x")
            self.assertEqual(sum(c is not None for c in g["board"]["cells"]), 2)
            self.assertEqual(g["rulesetVersion"], "classic-v1" if size == 4 else "practice-v1")

    def test_four_weight(self):
        rng = R.Xoshiro128ss.from_seed("fw")
        board = {"size": 4, "cells": [None] * 16}
        _, rec = R.spawn(board, rng, four_weight=10)
        self.assertEqual(rec["exponent"], "2")
        rng = R.Xoshiro128ss.from_seed("fw")
        _, rec = R.spawn(board, rng, four_weight=0)
        self.assertEqual(rec["exponent"], "1")

    def test_celebrates_once(self):
        cells = ["10", "10"] + [None] * 14
        s = G._state(4, cells, R.derive_words("c"))
        a = R.apply_move(s, "left")["state"]
        self.assertTrue(a["celebrated2048"])
        self.assertEqual(a["status"], "active")
        cells2 = ["11", "11"] + [None] * 14
        s2 = G._state(4, cells2, R.derive_words("c"), celebrated=True)
        self.assertTrue(R.apply_move(s2, "left")["state"]["celebrated2048"])


class CanonicalJson(unittest.TestCase):
    def test_key_order_and_no_whitespace(self):
        g = R.new_game({"size": 4}, "0")
        text = R.canonical_json(g)
        self.assertNotIn(" ", text)
        self.assertNotIn("\n", text)
        keys = list(json.loads(text).keys())
        self.assertEqual(keys, ["schemaVersion", "engineVersion", "rulesetVersion", "board",
                                "score", "acceptedMoves", "revision", "rng", "status",
                                "celebrated2048"])
        self.assertTrue(text.startswith('{"schemaVersion":1,"engineVersion":"1.0.0",'
                                        '"rulesetVersion":"classic-v1","board":{"size":4,"cells":['))
        self.assertTrue(text.endswith(',"status":"active","celebrated2048":false}'))

    def test_key_order_independent_of_input_order(self):
        g = R.new_game({"size": 4}, "abc")
        shuffled = dict(reversed(list(g.items())))
        self.assertEqual(R.canonical_json(shuffled), R.canonical_json(g))

    def test_rejects_malformed(self):
        g = R.new_game({"size": 4}, "abc")
        for mutate in (
            lambda s: s.__setitem__("score", "01"),
            lambda s: s.__setitem__("score", 5),
            lambda s: s["board"]["cells"].__setitem__(0, "0"),
            lambda s: s["rng"].__setitem__("words", [0, 0, 0, 0]),
            lambda s: s["rng"].__setitem__("words", [2 ** 32, 0, 0, 0]),
            lambda s: s.__setitem__("schemaVersion", 2),
        ):
            bad = copy.deepcopy(g)
            mutate(bad)
            with self.assertRaises(ValueError):
                R.canonical_json(bad)


class GoldenVectorsFile(unittest.TestCase):
    def test_committed_vectors_are_byte_identical_to_regeneration(self):
        with open(G.VECTORS_PATH, "rb") as fh:
            committed = fh.read().replace(b"\r\n", b"\n")
        self.assertEqual(committed, G.render().encode("utf-8"))

    def test_vectors_self_consistent(self):
        with open(G.VECTORS_PATH, encoding="utf-8") as fh:
            doc = json.load(fh)
        for case in doc["newGame"]:
            self.assertEqual(R.checksum(case["state"]), case["checksum"])
            self.assertEqual(R.canonical_json(case["state"]), case["canonicalJson"])
        for seq in doc["moveSequences"]:
            self.assertTrue(seq["noOpSteps"], "sequence must exercise no-op moves")
            state = seq["initial"]["state"]
            for step in seq["steps"]:
                prev_words = state["rng"]["words"]
                res = R.apply_move(state, step["direction"])
                state = res["state"]
                self.assertEqual(R.checksum(state), step["checksum"])
                self.assertEqual(state["rng"]["words"], step["rngWords"])
                if not step["changed"]:
                    self.assertEqual(step["rngWords"], prev_words)
            self.assertEqual(state, seq["final"]["state"])
        hv = doc["highValue"]
        self.assertEqual(hv["slide"]["scoreDelta"], str(2 ** 54 + 2 ** 4096))
        self.assertEqual(hv["slide"]["cells"][0], "54")
        self.assertEqual(hv["slide"]["cells"][4], "4096")


if __name__ == "__main__":
    unittest.main()
