# Repository setup, protection, and human maintenance

## Shared baseline

The bootstrap installs common docs/spec/tools on main once, then creates eight
canonical experiment refs at that same SHA. The active GitHub ruleset freezes
main/master after bootstrap. Experiment agents have no permission to undo it.

Ruleset source configuration: `examples/main-freeze.ruleset.json`. Rules:
restrict creation, restrict update (no fetch/merge exception), restrict deletion,
block non-fast-forward updates; no bypass actors. It protects named refs
`refs/heads/main` and `refs/heads/master`, not only the default branch label.
Sources: [GitHub rules API](https://docs.github.com/en/rest/repos/rules),
[available rules](https://docs.github.com/en/repositories/configuring-branches-and-merges-in-your-repository/managing-rulesets/available-rules-for-rulesets).

Check the live remote, not just this document:

```bash
gh api repos/EvanGUTK/Orchestration-Test/rulesets \
  --jq '.[] | {id,name,enforcement}'
gh api repos/EvanGUTK/Orchestration-Test/rules/branches/main \
  --jq '.[] | {type,ruleset_id}'
git ls-remote origin refs/heads/main 'refs/heads/experiment/*'
```

Repository administrators can change rulesets. Never hand experiment agents an
admin token. Non-admin collaborator/token credentials can write allowed lanes
without modifying protections. Local hooks are additional accidental-action
guards and cannot protect against a hostile same-user process.

## Owner-only baseline maintenance

The freeze intentionally blocks ordinary pushes AND merges, including the owner.
When the human wants to revise shared docs/spec, the owner temporarily disables
the ruleset through GitHub Settings, performs the reviewed maintenance, and
reenables it. No automated experiment may do that. Do not teach a worker to
evade protections or add itself as a bypass actor.

After maintenance, record a new benchmark version and baseline SHA. Existing
trials remain tied to their old baseline; do not silently mutate their criteria.
The human may create fresh trial clones from the new baseline. Do not force-push
canonical branches merely to make histories look uniform.

## Preparing worktrees

From the baseline checkout use `lab.py setup SOFTWARE --run RUN --directory OUTSIDE`.
It fetches the chosen experiment branch, creates one canonical chief checkout
and five run-specific worker branches, installs hooks, and generates env files.
It refuses existing destinations/worker branch names or an already checked-out
canonical branch. It does not delete/reset/cherry-pick anything.

Each role's Git worktree config records its experiment. Outgoing destinations
must belong to that same experiment. A push guard rejects tags, deletions,
unknown/non-fast-forward tips, main/master, and another tool's branches.
Fetch remote refs before a push if the guard cannot verify ancestry.

Root hook paths are shared within one repository; copying/checking out a Git
worktree doesn't copy independent Git configuration. Independent app clones
must install hooks separately. If an app owns hooks, the human must integrate
the guard chain before running it. Never overwrite another hook silently.

## Chief integration

After a worker reports an actual commit, the chief reviews its diff and tests,
then merges its branch or cherry-picks reviewed commits onto `experiment/SOFTWARE`.
Check branch/guard first; perform integrations serially. No worker integrates
its own work into main or another software lane. Inspect GitHub PR base branches.
Push only the explicit experiment ref after verification:

```bash
python3 tools/lab.py guard
git fetch origin
git push origin HEAD:refs/heads/experiment/paneflow
```

Use the actual assigned software, not the example's literal branch when another
tool is running. The guard will reject a mismatch.

## Cleanup and repeat trials

Stop CLI/GUI workers and server/bot processes, collect private evidence, and
confirm no uncommitted work is lost. The human may archive run directories and
remove finished worktrees using normal Git worktree commands. Never force-remove
dirty worktrees or delete remote branches as an automatic cleanup step.

Use a new clone for a fully fresh scored repeat. The common worktree object store
is convenient but exposes other branch objects; containers/users/separate clones
provide stronger context isolation. Read `CONTEXT_POLICY.md` before reruns.

## CI

`repository-checks.yml` validates docs/manifests, harness tests, and forbids PR
targets main/master. It does not report unimplemented application tests as passed.
Application CI should be added on each experiment branch when actual M0 commands
exist, preserving baseline checks. The freeze remains the remote update boundary.
