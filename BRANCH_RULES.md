# HARD RULE: experiment agents cannot push to main

**No agent, chief, orchestration service, merge queue, or experiment may update
`main` or `master` by ANY route. No experiment PR may target them.**

| Software | Only canonical integration branch | Allowed worker prefix |
| --- | --- | --- |
| Conductor | `experiment/conductor` | `workers/conductor/` |
| Harmony Desktop | `experiment/harmony-desktop` | `workers/harmony-desktop/` |
| Gas Town | `experiment/gas-town` | `workers/gas-town/` |
| dmux | `experiment/dmux` | `workers/dmux/` |
| Herdr | `experiment/herdr` | `workers/herdr/` |
| BridgeMind | `experiment/bridgemind` | `workers/bridgemind/` |
| Native Claude teams | `experiment/native-claude-teams` | `workers/native-claude-teams/` |
| PaneFlow | `experiment/paneflow` | `workers/paneflow/` |

There are eight canonical experiment branches plus the shared `main` baseline.
Worker branches are temporary implementation lanes, not extra competitors.
Never merge one competitor into another. Never use `git push --all`, `--mirror`,
`--force`, `--force-with-lease`, or delete remote branches during a run.

## Controls

- `AGENTS.md`: shared behavioral policy; `CLAUDE.md` points to the same policy.
- `.githooks/`: commit, merge, rebase, and push guards, installed by `lab.py setup`.
- `tools/lab.py guard`: validates the current experiment and outgoing ref updates.
- GitHub ruleset `Freeze shared baseline`: prohibits updates, deletion, creation
  of `main` and `master`, with no bypass actors. It freezes the remote baseline,
  including merges and direct API writes. See `docs/REPOSITORY_OPERATIONS.md`.
- CI runs harness checks and refuses experimental pull requests aimed at the baseline.

Markdown and local hooks are not a security sandbox: a process with filesystem
access can alter hooks. A GitHub administrator can edit repository rulesets.
For strong enforcement, experimental agents must use non-admin credentials;
keep the owner's admin token out of their environment. `main` staying unchanged
is checked before and after each benchmark run.

Install guards in EVERY independent clone. `lab.py setup` installs them for its
worktrees; an app that creates its own clone needs `python3 tools/lab.py install-hooks`.
Never allow an app to overwrite the guard path with its own hooks.

If a prohibited action is attempted: stop, record the command/tool/target, tell
the human, and disqualify the run. Do not retry through a different tool.
