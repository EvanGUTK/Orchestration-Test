#!/usr/bin/env python3
"""Validate manifests, fixed fixture structure, local doc links, and required safeguards."""
import json
from pathlib import Path
import re
import sys

ROOT = Path(__file__).resolve().parents[1]


def check():
    errors = []
    required = ["AGENTS.md", "BRANCH_RULES.md", "CLAUDE.md", ".gitignore",
                "docs/PROJECT_SCOPE.md", "docs/ARCHITECTURE.md", "docs/CONTRACTS.md",
                "docs/ACCEPTANCE.md", "docs/BENCHMARK.md", "docs/CONTEXT_POLICY.md",
                "docs/REPOSITORY_OPERATIONS.md", "prompts/CHIEF.md", "prompts/WORKER.md",
                "tools/lab.py", "tools/mailbox.py", "tools/score.py"]
    for name in required:
        if not (ROOT / name).is_file():
            errors.append(f"Missing {name}")
    manifests = [ROOT / "experiments.json", *sorted((ROOT / "benchmark").glob("*.json")),
                 *sorted((ROOT / "examples").glob("*.json")),
                 *sorted((ROOT / "tests/fixtures").glob("*.json"))]
    for path in manifests:
        try:
            json.loads(path.read_text())
        except (ValueError, OSError) as exc:
            errors.append(f"Invalid JSON {path.relative_to(ROOT)}: {exc}")
    exp = json.loads((ROOT / "experiments.json").read_text())
    names = {"conductor", "harmony-desktop", "gas-town", "dmux", "herdr",
             "bridgemind", "native-claude-teams", "paneflow"}
    if set(exp["experiments"]) != names:
        errors.append("Exactly the eight agreed software IDs are required")
    ports = []
    for name, row in exp["experiments"].items():
        if row["branch"] != f"experiment/{name}":
            errors.append(f"Incorrect canonical branch: {name}")
        ports.extend([row["webPort"], row["apiPort"]])
    if len(set(ports)) != len(ports):
        errors.append("Experiment ports must not overlap")
    rubric = json.loads((ROOT / "benchmark/rubric.json").read_text())
    seen = set()
    for group in rubric["categories"]:
        if sum(item["weight"] for item in group["items"]) != group["weight"]:
            errors.append(f"Invalid category weight: {group['id']}")
        for item in group["items"]:
            if item["id"] in seen or item["weight"] <= 0:
                errors.append(f"Duplicate/invalid rubric item: {item['id']}")
            seen.add(item["id"])
    if sum(group["weight"] for group in rubric["categories"]) != 1000 or rubric["maxPoints"] != 1000:
        errors.append("Rubric must total 1000")
    vectors = json.loads((ROOT / "tests/fixtures/slide-v1.json").read_text())["vectors"]
    for vector in vectors:
        if len(vector["before"]) != vector["size"] ** 2 or len(vector["after"]) != vector["size"] ** 2:
            errors.append(f"Invalid board fixture: {vector['id']}")
        for cell in vector["before"] + vector["after"]:
            if cell is not None and (not isinstance(cell, str) or not re.fullmatch(r"[1-9][0-9]*", cell)):
                errors.append(f"Invalid exponent fixture: {vector['id']}")
    # Ignore generated session/dependency folders; scan only the public documentation.
    markdown = [ROOT / "README.md", ROOT / "AGENTS.md", ROOT / "CLAUDE.md", ROOT / "BRANCH_RULES.md"]
    for folder in ("docs", "prompts", "reports", "apps", "packages", "tests"):
        markdown.extend((ROOT / folder).rglob("*.md"))
    for path in markdown:
        for target in re.findall(r"\]\(([^)]+)\)", path.read_text()):
            target = target.split("#", 1)[0].split("?", 1)[0]
            if not target or re.match(r"[a-z]+:", target):
                continue
            target = target.strip("<>")
            if not (path.parent / target).exists():
                errors.append(f"Broken local link in {path.relative_to(ROOT)}: {target}")
    for hook in ("pre-commit", "pre-push", "pre-rebase", "pre-merge-commit"):
        path = ROOT / ".githooks" / hook
        if not path.exists() or "tools/lab.py" not in path.read_text():
            errors.append(f"Missing Git guard: {hook}")
    freeze = json.loads((ROOT / "examples/main-freeze.ruleset.json").read_text())
    if freeze["bypass_actors"] or freeze["enforcement"] != "active":
        errors.append("Baseline freeze must have no bypass actors and active enforcement")
    if set(freeze["conditions"]["ref_name"]["include"]) != {"refs/heads/main", "refs/heads/master"}:
        errors.append("Freeze must cover main and master")
    if errors:
        for error in errors:
            print(error, file=sys.stderr)
        return 1
    print(f"Repository valid: 8 experiments, 16 distinct ports, {len(seen)} rubric items / 1000 points, "
          f"{len(vectors)} public slide vectors, {len(markdown)} Markdown files checked.")
    print("This validates the scaffold, not a finished game or installed orchestration apps.")
    return 0


if __name__ == "__main__":
    sys.exit(check())
