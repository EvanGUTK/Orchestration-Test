#!/usr/bin/env python3
"""Validate and score evidence-backed project rubric; no provider dependency."""
import argparse
import json
from pathlib import Path
import sys

ROOT = Path(__file__).resolve().parents[1]
RUBRIC = json.loads((ROOT / "benchmark/rubric.json").read_text())


def template():
    return {"schemaVersion": 1, "experiment": None, "runId": None, "finalSha": None,
            "violations": {key: False for key in RUBRIC["disqualifiers"]},
            "violationEvidence": {},
            "ratings": {item["id"]: {"rating": 0, "evidence": []}
                        for cat in RUBRIC["categories"] for item in cat["items"]}}


def score(card):
    if type(card.get("schemaVersion")) is not int or card.get("schemaVersion") != 1:
        raise ValueError("Unsupported scorecard version")
    expected = set(template()["ratings"])
    ratings = card.get("ratings")
    if not isinstance(ratings, dict) or set(ratings) != expected:
        raise ValueError("Scorecard must contain exactly the rubric item IDs")
    violations = card.get("violations")
    if not isinstance(violations, dict) or set(violations) != set(RUBRIC["disqualifiers"]):
        raise ValueError("All disqualification flags are required")
    if any(type(value) is not bool for value in violations.values()):
        raise ValueError("Violation flags must be booleans")
    reasons = [key for key, value in violations.items() if value]
    for reason in reasons:
        evidence = card.get("violationEvidence", {}).get(reason)
        if not isinstance(evidence, str) or not evidence.strip():
            raise ValueError(f"Disqualification requires evidence: {reason}")
    groups = []
    total_quarters = 0
    for cat in RUBRIC["categories"]:
        quarters = 0
        for item in cat["items"]:
            row = ratings[item["id"]]
            if not isinstance(row, dict):
                raise ValueError(f"Invalid rating entry: {item['id']}")
            rate, evidence = row.get("rating"), row.get("evidence")
            if type(rate) is not int or not 0 <= rate <= 4:
                raise ValueError(f"Rating must be integer 0-4: {item['id']}")
            if not isinstance(evidence, list) or any(not isinstance(e, str) or not e.strip() for e in evidence):
                raise ValueError(f"Evidence must be an array of nonempty strings: {item['id']}")
            if rate and not evidence:
                raise ValueError(f"Positive rating requires observed evidence: {item['id']}")
            quarters += rate * item["weight"]
        total_quarters += quarters
        groups.append({"category": cat["id"], "earned": quarters / 4, "max": cat["weight"]})
    return {"status": "disqualified" if reasons else "scored", "points": None if reasons else total_quarters / 4,
            "rawPoints": total_quarters / 4, "maxPoints": RUBRIC["maxPoints"],
            "categories": groups, "disqualifiers": reasons,
            "note": "Evidence references must still be verified by the human evaluator."}


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    sub = parser.add_subparsers(dest="command", required=True)
    create = sub.add_parser("template")
    create.add_argument("--output", type=Path)
    evaluate = sub.add_parser("score")
    evaluate.add_argument("file", type=Path)
    args = parser.parse_args()
    try:
        if args.command == "template":
            data = json.dumps(template(), indent=2) + "\n"
            if args.output:
                args.output.parent.mkdir(parents=True, exist_ok=True)
                with args.output.open("x") as handle:
                    handle.write(data)
                print(f"Created zero-rated scorecard: {args.output}")
            else:
                print(data, end="")
        else:
            card = json.loads(args.file.read_text())
            if not isinstance(card, dict):
                raise ValueError("Scorecard root must be an object")
            result = score(card)
            print(json.dumps(result, indent=2))
            return 2 if result["status"] == "disqualified" else 0
    except (ValueError, OSError, TypeError, AttributeError) as exc:
        print(f"STOP: {exc}", file=sys.stderr)
        return 1
    return 0


if __name__ == "__main__":
    sys.exit(main())
