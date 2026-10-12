#!/usr/bin/env python3
"""Provider-neutral experiment preparation and Git guards. Python standard library only."""
import argparse
import json
import os
from pathlib import Path
import re
import shlex
import subprocess
import sys

ROOT = Path(__file__).resolve().parents[1]
MANIFEST = json.loads((ROOT / "experiments.json").read_text())
EXPERIMENTS = MANIFEST["experiments"]
ROLES = MANIFEST["roles"]
ID = re.compile(r"[a-z0-9][a-z0-9-]{0,63}\Z")


def git(*args, cwd=None, check=True):
    return subprocess.run(["git", *args], cwd=ROOT if cwd is None else cwd, check=check, text=True,
                          stdout=subprocess.PIPE, stderr=subprocess.PIPE)


def branch_experiment(branch):
    for name, info in EXPERIMENTS.items():
        if branch == info["branch"]:
            return name
        prefix = f"workers/{name}/"
        if branch.startswith(prefix):
            tail = branch[len(prefix):].split("/")
            if len(tail) == 2 and ID.fullmatch(tail[0]) and tail[1] in ROLES[1:]:
                return name
    return None


def validate_push(experiment, lines, cwd=None):
    for line in lines:
        parts = line.split()
        if len(parts) != 4:
            raise ValueError("Malformed push ref update")
        local_ref, local_sha, remote_ref, remote_sha = parts
        if not remote_ref.startswith("refs/heads/"):
            raise ValueError("Agents may push only assigned branches, never tags or other refs")
        if branch_experiment(remote_ref.removeprefix("refs/heads/")) != experiment:
            raise ValueError(f"Forbidden push destination: {remote_ref}")
        if local_ref == "(delete)" or set(local_sha) == {"0"}:
            raise ValueError("Remote deletion is forbidden")
        if set(remote_sha) != {"0"}:
            if git("merge-base", "--is-ancestor", remote_sha, local_sha,
                   cwd=cwd, check=False).returncode != 0:
                raise ValueError("Non-fast-forward or unknown remote tip; fetch before pushing")


def guard(push=False):
    current = git("branch", "--show-current").stdout.strip()
    experiment = branch_experiment(current)
    if experiment is None:
        raise ValueError(f"Forbidden branch {current or '(detached HEAD)'}; use an assigned experiment")
    assigned = git("config", "--get", "lab.experiment", check=False).stdout.strip()
    if assigned and assigned != experiment:
        raise ValueError(f"Worktree assigned to {assigned}, current branch belongs to {experiment}")
    if push:
        validate_push(experiment, sys.stdin, cwd=ROOT)
    print(f"Guard OK: {experiment} / {current}")


def install_hooks(cwd=None):
    cwd = ROOT if cwd is None else cwd
    hooks = Path(git("rev-parse", "--show-toplevel", cwd=cwd).stdout.strip()) / ".githooks"
    existing = git("config", "--get", "core.hooksPath", cwd=cwd, check=False).stdout.strip()
    if existing and Path(existing).resolve() != hooks.resolve():
        raise ValueError(f"Existing hook path {existing}; human must reconcile it before setup")
    for hook in hooks.iterdir():
        hook.chmod(0o755)
    git("config", "--local", "core.hooksPath", str(hooks), cwd=cwd)
    print(f"Installed guards: {hooks}")


def setup(name, run, destination):
    if not ID.fullmatch(run):
        raise ValueError("Run ID must be 1-64 lowercase letters, digits, or hyphens")
    destination = Path(destination).expanduser().resolve()
    if destination == ROOT or ROOT in destination.parents:
        raise ValueError("Put experiment worktrees OUTSIDE the baseline checkout")
    info = EXPERIMENTS[name]
    git("fetch", "origin", info["branch"])
    # Do not switch or reset an existing experiment checkout.
    if git("show-ref", "--verify", f"refs/heads/{info['branch']}", check=False).returncode:
        git("branch", info["branch"], f"origin/{info['branch']}")
    if destination.exists():
        raise ValueError(f"Destination already exists: {destination}; choose a fresh run path")
    for role in ROLES[1:]:
        worker = f"workers/{name}/{run}/{role}"
        if git("show-ref", "--verify", f"refs/heads/{worker}", check=False).returncode == 0:
            raise ValueError(f"Worker branch already exists: {worker}; use a new run ID")
    worktree_paths = [Path(entry['path']) for entry in worktrees() if entry.get('branch') == info['branch']]
    if worktree_paths:
        raise ValueError(f"Canonical branch is already checked out at {worktree_paths[0]}; reuse that chief")
    install_hooks()
    git("config", "extensions.worktreeConfig", "true")
    destination.mkdir(parents=True)
    chief = destination / "chief"
    git("worktree", "add", str(chief), info["branch"])
    workers = {}
    for role in ROLES[1:]:
        target = destination / role
        worker = f"workers/{name}/{run}/{role}"
        git("worktree", "add", "-b", worker, str(target), info["branch"])
        workers[role] = str(target)
    runtime = destination / "runtime"
    runtime.mkdir(mode=0o700)
    state = {"schemaVersion": 1, "experiment": name, "run": run,
             "branch": info["branch"], "baselineCommit": git("rev-parse", "origin/main").stdout.strip(),
             "startingCommit": git("rev-parse", info["branch"]).stdout.strip(),
             "chief": str(chief), "workers": workers, "runtime": str(runtime), **info}
    (runtime / "run.json").write_text(json.dumps(state, indent=2) + "\n")
    for role in ROLES:
        target = chief if role == "chief" else Path(workers[role])
        git("config", "--worktree", "lab.experiment", name, cwd=target)
        env = {"LAB_EXPERIMENT": name, "LAB_RUN_ID": run, "LAB_ROLE": role,
               "LAB_RUNTIME": str(runtime), "HOST": "127.0.0.1",
               "WEB_PORT": str(info["webPort"]), "API_PORT": str(info["apiPort"]),
               "DATA_DIR": str(runtime / "data"),
               "DATABASE_PATH": str(runtime / "data" / "game.sqlite3")}
        local = target / ".lab"
        local.mkdir(mode=0o700)
        (local / "env.sh").write_text("\n".join(f"export {k}={shlex.quote(v)}" for k, v in env.items()) + "\n")
        (local / "env.ps1").write_text("\n".join(f"$env:{k} = '{v.replace(chr(39), chr(39)*2)}'" for k, v in env.items()) + "\n")
    print(json.dumps(state, indent=2))
    print("In each pane: cd <role path>; source .lab/env.sh; python3 tools/lab.py guard")


def worktrees():
    rows, row = [], {}
    for line in git("worktree", "list", "--porcelain").stdout.splitlines() + [""]:
        if not line:
            if row:
                rows.append(row)
            row = {}
        elif line.startswith("worktree "):
            row['path'] = line[9:]
        elif line.startswith("branch refs/heads/"):
            row['branch'] = line[len("branch refs/heads/"):]
    return rows


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    sub = parser.add_subparsers(dest="command", required=True)
    sub.add_parser("list")
    sub.add_parser("install-hooks")
    g = sub.add_parser("guard")
    g.add_argument("--push", action="store_true")
    s = sub.add_parser("setup")
    s.add_argument("experiment", choices=EXPERIMENTS)
    s.add_argument("--run", required=True)
    s.add_argument("--directory", required=True)
    args = parser.parse_args()
    try:
        if args.command == "list":
            print(json.dumps(MANIFEST, indent=2))
        elif args.command == "guard":
            guard(args.push)
        elif args.command == "install-hooks":
            install_hooks()
        elif args.command == "setup":
            setup(args.experiment, args.run, args.directory)
    except (ValueError, subprocess.CalledProcessError, OSError) as exc:
        print(f"STOP: {getattr(exc, 'stderr', None) or str(exc)}", file=sys.stderr)
        return 1
    return 0


if __name__ == "__main__":
    sys.exit(main())
