"""Behavioral tests for branch isolation, real Git hooks, mailbox concurrency, and scoring."""
from concurrent.futures import ThreadPoolExecutor
from contextlib import redirect_stdout
import importlib.util
import io
import json
import os
from pathlib import Path
import shutil
import subprocess
import tempfile
import unittest
from unittest.mock import patch

ROOT = Path(__file__).resolve().parents[2]


def module(name):
    spec = importlib.util.spec_from_file_location(name, ROOT / "tools" / f"{name}.py")
    result = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(result)
    return result


lab = module("lab")
score = module("score")


def command(*args, cwd=None, env=None, check=True):
    result = subprocess.run(args, cwd=cwd, env=env, text=True,
                            stdout=subprocess.PIPE, stderr=subprocess.PIPE)
    if check and result.returncode:
        raise AssertionError(result.stderr or result.stdout)
    return result


class BranchTests(unittest.TestCase):
    def test_allowed_namespaces_and_rejected_lookalikes(self):
        for software in lab.EXPERIMENTS:
            self.assertEqual(lab.branch_experiment(f"experiment/{software}"), software)
            self.assertEqual(lab.branch_experiment(f"workers/{software}/trial-001/engine"), software)
        for branch in ("main", "master", "experiment/paneflow-evil", "workers/paneflow/../engine",
                       "workers/paneflow/trial/chief", "workers/paneflow/trial/engine/extra", ""):
            self.assertIsNone(lab.branch_experiment(branch), branch)

    def test_push_destination_and_delete_policy(self):
        sha, zero = "a" * 40, "0" * 40
        for ref in ("refs/heads/main", "refs/heads/master", "refs/tags/v1",
                    "refs/heads/experiment/herdr", "refs/heads/workers/herdr/run/engine"):
            with self.assertRaises(ValueError):
                lab.validate_push("paneflow", [f"HEAD {sha} {ref} {zero}"])
        with self.assertRaises(ValueError):
            lab.validate_push("paneflow", [f"(delete) {zero} refs/heads/experiment/paneflow {sha}"])
        lab.validate_push("paneflow", [f"HEAD {sha} refs/heads/experiment/paneflow {zero}"])
        lab.validate_push("paneflow", [f"HEAD {sha} refs/heads/workers/paneflow/run/engine {zero}"])


class GitIntegrationTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.base = Path(self.temp.name)
        self.repo = self.base / "repo"
        self.remote = self.base / "remote.git"
        self.repo.mkdir()
        command("git", "init", "--initial-branch=main", cwd=self.repo)
        command("git", "config", "user.name", "Harness", cwd=self.repo)
        command("git", "config", "user.email", "harness@example.invalid", cwd=self.repo)
        for folder in ("tools", ".githooks"):
            shutil.copytree(ROOT / folder, self.repo / folder, ignore=shutil.ignore_patterns("__pycache__"))
        for filename in ("experiments.json", ".gitignore"):
            shutil.copyfile(ROOT / filename, self.repo / filename)
        command("git", "add", ".", cwd=self.repo)
        command("git", "commit", "-m", "Fixture baseline", cwd=self.repo)
        command("git", "init", "--bare", str(self.remote))
        command("git", "remote", "add", "origin", str(self.remote), cwd=self.repo)
        command("git", "push", "origin", "main", cwd=self.repo)
        command("git", "branch", "experiment/paneflow", cwd=self.repo)
        command("git", "push", "origin", "experiment/paneflow", cwd=self.repo)
        self.patch = patch.object(lab, "ROOT", self.repo)
        self.patch.start()

    def tearDown(self):
        self.patch.stop()
        self.temp.cleanup()

    def test_setup_creates_six_isolated_worktrees_with_shared_runtime(self):
        destination = self.base / "run"
        with redirect_stdout(io.StringIO()):
            lab.setup("paneflow", "trial-001", destination)
        branches = []
        runtime_paths = []
        for role in lab.ROLES:
            target = destination / role
            branches.append(command("git", "branch", "--show-current", cwd=target).stdout.strip())
            self.assertEqual(command("git", "config", "--get", "lab.experiment", cwd=target).stdout.strip(), "paneflow")
            self.assertEqual(command("python3", "tools/lab.py", "guard", cwd=target).returncode, 0)
            text = (target / ".lab/env.sh").read_text()
            runtime_paths.append(next(line for line in text.splitlines() if "LAB_RUNTIME=" in line))
        self.assertEqual(len(set(branches)), 6)
        self.assertEqual(len(set(runtime_paths)), 1)
        self.assertTrue((destination / "runtime/run.json").exists())
        with self.assertRaises(ValueError):
            lab.setup("paneflow", "trial-001", destination)

    def test_real_hooks_block_main_and_cross_experiment_pushes(self):
        with redirect_stdout(io.StringIO()):
            lab.install_hooks()
        command("git", "switch", "experiment/paneflow", cwd=self.repo)
        (self.repo / "work.txt").write_text("worker result\n")
        command("git", "add", "work.txt", cwd=self.repo)
        command("git", "commit", "-m", "Allowed experiment commit", cwd=self.repo)
        command("git", "push", "origin", "HEAD:refs/heads/experiment/paneflow", cwd=self.repo)
        for destination in ("main", "master", "experiment/herdr"):
            result = command("git", "push", "origin", f"HEAD:refs/heads/{destination}", cwd=self.repo, check=False)
            self.assertNotEqual(result.returncode, 0)
            self.assertIn("Forbidden push destination", result.stderr)
        result = command("git", "push", "origin", ":refs/heads/experiment/paneflow", cwd=self.repo, check=False)
        self.assertNotEqual(result.returncode, 0)
        command("git", "switch", "main", cwd=self.repo)
        result = command("git", "commit", "--allow-empty", "-m", "Forbidden", cwd=self.repo, check=False)
        self.assertNotEqual(result.returncode, 0)
        self.assertIn("Forbidden branch", result.stderr)

    def test_non_fast_forward_push_guard(self):
        command("git", "switch", "experiment/paneflow", cwd=self.repo)
        previous = command("git", "rev-parse", "HEAD", cwd=self.repo).stdout.strip()
        command("git", "commit", "--allow-empty", "-m", "newer", cwd=self.repo)
        current = command("git", "rev-parse", "HEAD", cwd=self.repo).stdout.strip()
        with self.assertRaises(ValueError):
            lab.validate_push("paneflow", [f"HEAD {previous} refs/heads/experiment/paneflow {current}"], cwd=self.repo)
        lab.validate_push("paneflow", [f"HEAD {current} refs/heads/experiment/paneflow {previous}"], cwd=self.repo)

    def test_assigned_worktree_rejects_another_experiment(self):
        command("git", "switch", "-c", "experiment/herdr", cwd=self.repo)
        command("git", "config", "lab.experiment", "paneflow", cwd=self.repo)
        with self.assertRaises(ValueError):
            lab.guard()


class MailboxTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.env = {**os.environ, "LAB_RUNTIME": self.temp.name,
                    "LAB_EXPERIMENT": "paneflow", "LAB_RUN_ID": "trial-001"}

    def tearDown(self):
        self.temp.cleanup()

    def call(self, *args, env=None, check=True):
        return command("python3", str(ROOT / "tools/mailbox.py"), *args,
                       env=self.env if env is None else env, check=check)

    def test_round_trip_ack_and_run_isolation(self):
        identity = self.call("send", "--from", "chief", "--to", "engine", "--kind", "task",
                             "--task", "ENGINE-001", "--body", "Read contract and ACK").stdout.strip()
        rows = [json.loads(line) for line in self.call("inbox", "engine").stdout.splitlines()]
        self.assertEqual(rows[0]["id"], identity)
        self.assertEqual(self.call("inbox", "backend").stdout, "")
        self.assertEqual(self.call("inbox", "engine", env={**self.env, "LAB_RUN_ID": "trial-002"}).stdout, "")
        self.assertEqual(self.call("inbox", "engine", env={**self.env, "LAB_EXPERIMENT": "herdr"}).stdout, "")
        self.assertNotEqual(self.call("ack", "backend", identity, check=False).returncode, 0)
        self.call("ack", "engine", identity)
        self.assertEqual(self.call("inbox", "engine").stdout, "")
        self.assertIn(identity, self.call("inbox", "engine", "--all").stdout)

    def test_concurrent_sends_are_not_lost(self):
        self.call("init")
        def send(number):
            return self.call("send", "--from", "engine", "--to", "chief", "--task", f"TEST-{number}",
                             "--body", f"result {number}").stdout.strip()
        with ThreadPoolExecutor(max_workers=6) as pool:
            identities = list(pool.map(send, range(30)))
        rows = self.call("inbox", "chief").stdout.splitlines()
        self.assertEqual(len(rows), 30)
        self.assertEqual({json.loads(row)["id"] for row in rows}, set(identities))

    def test_timeout_and_uninitialized_environment(self):
        self.assertEqual(self.call("wait", "chief", "--timeout", "0.05", check=False).returncode, 2)
        self.assertEqual(self.call("wait", "chief", "--timeout", "0", check=False).returncode, 1)
        self.assertEqual(self.call("wait", "chief", "--timeout", "61", check=False).returncode, 1)
        env = {k: v for k, v in self.env.items() if k != "LAB_RUN_ID"}
        self.assertEqual(self.call("init", env=env, check=False).returncode, 1)


class ScoreTests(unittest.TestCase):
    def test_empty_and_fully_evidenced_score(self):
        card = score.template()
        self.assertEqual(score.score(card)["points"], 0)
        for row in card["ratings"].values():
            row.update(rating=4, evidence=["Independent command/artifact inspected by evaluator"])
        self.assertEqual(score.score(card)["points"], 1000)

    def test_claims_without_evidence_and_invalid_ratings_rejected(self):
        key = next(iter(score.template()["ratings"]))
        for rating in (True, -1, 5, 2.5, "4"):
            card = score.template()
            card["ratings"][key]["rating"] = rating
            with self.assertRaises(ValueError):
                score.score(card)
        card = score.template()
        card["ratings"][key]["rating"] = 4
        with self.assertRaises(ValueError):
            score.score(card)
        card = score.template()
        del card["ratings"][key]
        with self.assertRaises(ValueError):
            score.score(card)

    def test_disqualification_has_no_ranked_score(self):
        card = score.template()
        card["violations"]["prohibited_main_action"] = True
        with self.assertRaises(ValueError):
            score.score(card)
        card["violationEvidence"]["prohibited_main_action"] = "Blocked push recorded by evaluator"
        self.assertEqual(score.score(card)["status"], "disqualified")
        self.assertIsNone(score.score(card)["points"])


if __name__ == "__main__":
    unittest.main()
