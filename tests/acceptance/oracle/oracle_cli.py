"""JSON stdin/stdout front end to the reference oracle (differential fuzzing).

Input (UTF-8 JSON on stdin), either one case object or {"cases": [case, ...]}:
  {"id": any, "seed": str, "size": int, "fourWeight": int (default 1),
   "rulesetVersion": str (default classic-v1 for 4x4 else practice-v1),
   "moveCap": int | null (default null), "directions": ["up", ...]}

Output (UTF-8 JSON on stdout), always {"results": [...]} in input order:
  {"id", "initial": {"checksum", "canonicalJson"},
   "steps": [{"direction", "changed", "scoreDelta", "checksum", "rngWords",
              "status", "error": null | EngineError code}],
   "final": {"checksum", "canonicalJson"}}
A step that raises EngineError (e.g. GAME_NOT_ACTIVE after the game ended)
records the code, leaves the state unchanged, and continues.

Usage: python3 tests/acceptance/oracle/oracle_cli.py < cases.json
"""

from __future__ import annotations

import json
import os
import sys

HERE = os.path.dirname(os.path.abspath(__file__))
if HERE not in sys.path:
    sys.path.insert(0, HERE)

import reference_engine as R  # noqa: E402


def run_case(case: dict) -> dict:
    size = case["size"]
    rules = {
        "size": size,
        "fourWeight": case.get("fourWeight", R.DEFAULT_FOUR_WEIGHT),
        "version": case.get("rulesetVersion") or R.ruleset_version(size),
        "moveCap": case.get("moveCap"),
    }
    state = R.new_game(rules, case["seed"])
    initial = {"checksum": R.checksum(state), "canonicalJson": R.canonical_json(state)}
    steps = []
    for direction in case["directions"]:
        try:
            res = R.apply_move(state, direction, rules)
        except R.EngineError as err:
            steps.append({"direction": direction, "changed": False, "scoreDelta": "0",
                          "checksum": R.checksum(state), "rngWords": list(state["rng"]["words"]),
                          "status": state["status"], "error": err.code})
            continue
        state = res["state"]
        steps.append({"direction": direction, "changed": res["changed"],
                      "scoreDelta": res["scoreDelta"], "checksum": R.checksum(state),
                      "rngWords": list(state["rng"]["words"]), "status": state["status"],
                      "error": None})
    return {"id": case.get("id"), "initial": initial, "steps": steps,
            "final": {"checksum": R.checksum(state), "canonicalJson": R.canonical_json(state)}}


def main() -> int:
    raw = sys.stdin.buffer.read().decode("utf-8")
    doc = json.loads(raw)
    cases = doc["cases"] if isinstance(doc, dict) and "cases" in doc else [doc]
    out = {"results": [run_case(c) for c in cases]}
    sys.stdout.buffer.write(json.dumps(out, ensure_ascii=False, separators=(",", ":")).encode("utf-8"))
    sys.stdout.buffer.write(b"\n")
    return 0


if __name__ == "__main__":
    sys.exit(main())
