"""Deterministically generate tests/acceptance/vectors/engine-v1.json.

Usage (from the repository root):
  python3 tests/acceptance/oracle/generate_vectors.py          # (re)write file
  python3 tests/acceptance/oracle/generate_vectors.py --check  # verify only

Output depends only on reference_engine.py and the constants below. It is
written as UTF-8 with LF line endings, 2-space indent, insertion key order.
"""

from __future__ import annotations

import argparse
import hashlib
import json
import os
import sys

HERE = os.path.dirname(os.path.abspath(__file__))
if HERE not in sys.path:
    sys.path.insert(0, HERE)

import reference_engine as R  # noqa: E402

VECTORS_PATH = os.path.normpath(os.path.join(HERE, "..", "vectors", "engine-v1.json"))

SEED_DERIVATION_SEEDS = ["0", "1", "abc", "2048-infinite", "ünïcødé", "challenge:2026-10-12"]
XOSHIRO_SEEDS = ["0", "abc"]
XOSHIRO_OUTPUTS = 20
UNIFORM_SEED = "abc"
UNIFORM_BOUNDS = [1, 2, 3, 10, 16, 15, 4294967295, 2147483649, 4294967296]
UNIFORM_DRAWS = 10
REJECTION_BOUND = 2147483649  # 2^31 + 1: limit = 2^31 + 1, so ~half of raw draws are rejected
REJECTION_SEED_PREFIX = "rejection-"
NEW_GAME_SIZES = [3, 4, 8]
NEW_GAME_SEEDS = ["0", "abc", "2048-infinite"]
MOVE_SEQUENCE_SEEDS = ["0", "abc"]
# 40 directions: the up,right,down,left cycle with deliberate repeats so that
# no-op moves occur (e.g. a second "left" right after "left").
MOVE_SEQUENCE = [
    "up", "right", "down", "left",
    "left", "left", "up", "up",
    "right", "right", "down", "down",
    "left", "up", "right", "down",
    "down", "down", "left", "left",
    "up", "right", "right", "right",
    "down", "left", "up", "up",
    "up", "right", "down", "left",
    "left", "down", "down", "right",
    "up", "left", "left", "up",
]
assert len(MOVE_SEQUENCE) == 40


def _state(size, cells, words, score="0", accepted=0, revision=0, celebrated=False,
           status="active"):
    return {
        "schemaVersion": R.SCHEMA_VERSION,
        "engineVersion": R.ENGINE_VERSION,
        "rulesetVersion": R.ruleset_version(size),
        "board": {"size": size, "cells": list(cells)},
        "score": score,
        "acceptedMoves": accepted,
        "revision": revision,
        "rng": {"algorithm": R.ALGORITHM_ID, "words": list(words)},
        "status": status,
        "celebrated2048": celebrated,
    }


def _state_record(state):
    return {"state": state, "canonicalJson": R.canonical_json(state),
            "checksum": R.checksum(state)}


def gen_seed_derivation():
    out = []
    for seed in SEED_DERIVATION_SEEDS:
        digest = R.seed_digest(seed)
        out.append({
            "seed": seed,
            "hashInputUtf8Hex": (R.SEED_PREFIX + seed).encode("utf-8").hex(),
            "sha256": digest.hex(),
            "words": R.words_from_digest(digest),
        })
    return out


def gen_xoshiro():
    cases = [{"label": "reference-state-1-2-3-4", "seed": None, "initialWords": [1, 2, 3, 4]}]
    cases += [{"label": "seed:" + s, "seed": s, "initialWords": R.derive_words(s)}
              for s in XOSHIRO_SEEDS]
    out = []
    for case in cases:
        rng = R.Xoshiro128ss(case["initialWords"])
        outputs = [rng.next_u32() for _ in range(XOSHIRO_OUTPUTS)]
        out.append({**case, "outputs": outputs, "wordsAfter": rng.words()})
    return out


def gen_uniform():
    seq = []
    for n in UNIFORM_BOUNDS:
        rng = R.Xoshiro128ss.from_seed(UNIFORM_SEED)
        trace = []
        draws = [R.uniform(rng, n, trace) for _ in range(UNIFORM_DRAWS)]
        seq.append({
            "n": n,
            "limit": R.uniform_limit(n),
            "initialWords": R.derive_words(UNIFORM_SEED),
            "results": draws,
            "rawDraws": [t["raw"] for t in trace],
            "rejectedRawDraws": [t["raw"] for t in trace if not t["accepted"]],
            "rawDrawsConsumed": rng.draws,
            "wordsAfter": rng.words(),
        })
    # Hand-picked rejection: first seed "rejection-<i>" whose FIRST raw draw
    # is >= limit for n = 2^31 + 1.
    limit = R.uniform_limit(REJECTION_BOUND)
    i = 0
    while True:
        seed = REJECTION_SEED_PREFIX + str(i)
        probe = R.Xoshiro128ss.from_seed(seed)
        if probe.next_u32() >= limit:
            break
        i += 1
    rng = R.Xoshiro128ss.from_seed(seed)
    trace = []
    result = R.uniform(rng, REJECTION_BOUND, trace)
    rejection = {
        "description": ("uniform(n) where the first raw draw(s) are >= limit and are "
                        "rejected; every rejected draw still advances the PRNG"),
        "seed": seed,
        "n": REJECTION_BOUND,
        "limit": limit,
        "initialWords": R.derive_words(seed),
        "rawDraws": trace,
        "rejectedRawDraws": [t["raw"] for t in trace if not t["accepted"]],
        "result": result,
        "rawDrawsConsumed": rng.draws,
        "wordsAfter": rng.words(),
    }
    return {"seed": UNIFORM_SEED, "sequences": seq, "rejectionCase": rejection}


def gen_new_game():
    out = []
    for size in NEW_GAME_SIZES:
        for seed in NEW_GAME_SEEDS:
            trace = []
            state = R.new_game({"size": size, "fourWeight": R.DEFAULT_FOUR_WEIGHT}, seed, trace)
            spawns = trace[-1]["spawns"]
            out.append({"size": size, "seed": seed,
                        "initialWords": R.derive_words(seed),
                        "spawns": spawns, **_state_record(state)})
    return out


def gen_move_sequences():
    out = []
    for seed in MOVE_SEQUENCE_SEEDS:
        state = R.new_game({"size": 4}, seed)
        initial = _state_record(state)
        steps = []
        for idx, direction in enumerate(MOVE_SEQUENCE):
            res = R.apply_move(state, direction)
            state = res["state"]
            steps.append({
                "step": idx,
                "direction": direction,
                "changed": res["changed"],
                "scoreDelta": res["scoreDelta"],
                "spawn": None if res["spawn"] is None else
                {"index": res["spawn"]["index"], "exponent": res["spawn"]["exponent"]},
                "rawDrawsConsumed": res["draws"],
                "score": state["score"],
                "acceptedMoves": state["acceptedMoves"],
                "revision": state["revision"],
                "status": state["status"],
                "rngWords": list(state["rng"]["words"]),
                "checksum": R.checksum(state),
            })
        out.append({
            "seed": seed,
            "size": 4,
            "directions": list(MOVE_SEQUENCE),
            "initial": initial,
            "steps": steps,
            "noOpSteps": [s["step"] for s in steps if not s["changed"]],
            "final": _state_record(state),
        })
    return out


def gen_high_value():
    cells = [None] * 16
    cells[0] = "53"
    cells[1] = "53"
    cells[4] = "4095"
    cells[5] = "4095"
    words = R.derive_words("high-value")
    before = _state(4, cells, words, score="0")
    slid = R.slide(before["board"], "left")
    res = R.apply_move(before, "left")
    return {
        "description": ("hand-built 4x4 state; tiles 53,53 (row 0) and 4095,4095 (row 1) "
                        "slide left; rng words = derive('high-value')"),
        "direction": "left",
        "before": _state_record(before),
        "slide": {
            "cells": slid["board"]["cells"],
            "changed": slid["changed"],
            "merges": slid["merges"],
            "scoreDelta": slid["scoreDelta"],
            "scoreDeltaSha256": hashlib.sha256(slid["scoreDelta"].encode("ascii")).hexdigest(),
            "scoreDeltaDigits": len(slid["scoreDelta"]),
        },
        "applyMove": {
            "changed": res["changed"],
            "scoreDelta": res["scoreDelta"],
            "spawn": {"index": res["spawn"]["index"], "exponent": res["spawn"]["exponent"]},
            "after": _state_record(res["state"]),
        },
    }


def gen_transitions():
    """Small hand-built cases for celebration and completion rules."""
    out = []
    words = R.derive_words("transitions")

    # 1) first celebration: 10+10 -> 11 (2048).
    cells = [None] * 16
    cells[0], cells[1] = "10", "10"
    s = _state(4, cells, words, score="100")
    r = R.apply_move(s, "left")
    out.append({"id": "first-2048-celebrates", "direction": "left",
                "before": _state_record(s), "changed": r["changed"],
                "scoreDelta": r["scoreDelta"], "after": _state_record(r["state"])})

    # 2) already celebrated: 11+11 -> 12 keeps celebrated2048 true, stays active.
    cells = [None] * 16
    cells[0], cells[1] = "11", "11"
    s = _state(4, cells, words, score="5000", accepted=7, revision=7, celebrated=True)
    r = R.apply_move(s, "left")
    out.append({"id": "already-celebrated-stays-true", "direction": "left",
                "before": _state_record(s), "changed": r["changed"],
                "scoreDelta": r["scoreDelta"], "after": _state_record(r["state"])})

    # 3) move fills the last cell and leaves no merges -> completed.
    #    Checkerboard of 1/2 with cell 15 empty and a 3 at 14 that slides right.
    cells = ["1", "2", "1", "2",
             "2", "1", "2", "1",
             "1", "2", "1", "2",
             "3", "4", "5", None]
    # Search the fixed list of candidate rng seeds for one whose spawn makes
    # the board dead, so the vector demonstrates "completed".
    chosen = None
    for k in range(1000):
        w = R.derive_words("completion-%d" % k)
        cand = _state(4, cells, w)
        r = R.apply_move(cand, "right")
        if r["changed"] and r["state"]["status"] == "completed":
            chosen = (cand, r)
            break
    if chosen is None:
        raise RuntimeError("no completion seed found")
    s, r = chosen
    out.append({"id": "move-completes-game", "direction": "right",
                "before": _state_record(s), "changed": r["changed"],
                "scoreDelta": r["scoreDelta"], "after": _state_record(r["state"])})

    # 4) completed board: every direction is a no-op; isGameOver true.
    dead = r["state"]
    out.append({"id": "completed-board-all-noop",
                "board": dead["board"],
                "isGameOver": R.is_game_over(dead["board"]),
                "legalMoves": R.legal_moves(dead["board"])})

    # 5) full but mergeable board is NOT game over.
    full = ["1", "2", "1", "2",
            "2", "1", "2", "1",
            "1", "2", "1", "2",
            "2", "1", "2", "2"]
    b = {"size": 4, "cells": full}
    out.append({"id": "full-mergeable-board-active", "board": b,
                "isGameOver": R.is_game_over(b), "legalMoves": R.legal_moves(b)})
    return out


def build_document() -> dict:
    return {
        "schemaVersion": 1,
        "contract": "CONTRACT-001",
        "contractVersion": "v1",
        "generator": "tests/acceptance/oracle/generate_vectors.py",
        "conventions": {
            "seedDerivation": ("SHA-256(UTF-8('2048-infinite/v1:' + seed)); first 16 bytes -> "
                               "4 little-endian uint32 words; all-zero -> [1,0,0,0]"),
            "prng": "xoshiro128** (xoshiro128ss-v1), words [s0,s1,s2,s3], output uint32",
            "uniform": ("limit = 2^32 - (2^32 mod n); draw until x < limit; return x mod n; "
                        "each raw draw (incl. rejected, and the single draw for n=1) "
                        "advances the PRNG"),
            "spawn": ("empties row-major; pos = empties[uniform(len)]; v = uniform(10); "
                      "exponent '2' if v < fourWeight else '1'; default fourWeight = 1"),
            "newGame": "two spawns on empty board; rulesetVersion classic-v1 for 4x4 else practice-v1",
            "checksum": "lowercase hex SHA-256 of UTF-8 canonical JSON (fixed key order, no whitespace)",
            "engineVersion": R.ENGINE_VERSION,
        },
        "seedDerivation": gen_seed_derivation(),
        "xoshiro": gen_xoshiro(),
        "uniform": gen_uniform(),
        "newGame": gen_new_game(),
        "moveSequences": gen_move_sequences(),
        "highValue": gen_high_value(),
        "transitions": gen_transitions(),
    }


def render() -> str:
    return json.dumps(build_document(), indent=2, ensure_ascii=False) + "\n"


def main(argv=None) -> int:
    parser = argparse.ArgumentParser(description=__doc__.splitlines()[0])
    parser.add_argument("--check", action="store_true",
                        help="exit 1 if the committed file differs from a fresh render")
    parser.add_argument("--output", default=VECTORS_PATH)
    args = parser.parse_args(argv)
    text = render()
    data = text.encode("utf-8")
    if args.check:
        try:
            with open(args.output, "rb") as fh:
                current = fh.read().replace(b"\r\n", b"\n")
        except FileNotFoundError:
            print("missing: %s" % args.output)
            return 1
        if current != data:
            print("DIFFERS: %s (re-run generate_vectors.py)" % args.output)
            return 1
        print("OK: %s is byte-identical (sha256 %s)" % (args.output, hashlib.sha256(data).hexdigest()))
        return 0
    os.makedirs(os.path.dirname(args.output), exist_ok=True)
    with open(args.output, "wb") as fh:
        fh.write(data)
    print("wrote %s (%d bytes, sha256 %s)" % (args.output, len(data), hashlib.sha256(data).hexdigest()))
    return 0


if __name__ == "__main__":
    sys.exit(main())
