# Context isolation and ignore policy

`.gitignore` keeps files out of ordinary Git commits. It does **not** prevent an
agent from reading them, change its global memory, or control a provider's data
handling. This policy supplies the behavioral boundary; OS permissions and
separate users/containers are needed when a hard read boundary is required.

## Allowed context

The shared baseline README, agent rules, architecture/scope/contracts,
acceptance criteria, public fixtures, prompt templates, the current task, and
source/results created in this experiment's current run. Pull relevant files
on demand; do not feed entire transcripts or node_modules into a model.

## Forbidden context

Other competitors' code, reports, git diffs, runtime databases, memories,
transcripts, task boards, hidden evaluator cases, credentials, and local
account data. Agents must not inspect sibling experiment worktrees or run
`git show experiment/<other-software>:...` to copy another solution. The common
Git object store makes that technically possible; the no-copy rule is explicit.
For stronger separation, give each software a separate clone/container and
non-admin credentials, and mount only its own workdir.

## Start fresh

1. Choose software, fresh run ID, models, context limits, and a fixed baseline SHA.
2. Create six role worktrees or configure the app's equivalent isolation.
3. Start new agent conversations. Do not use "resume last", inherited global
   project memory, or another tool's conversation import for baseline comparison.
4. Give every agent `AGENTS.md`, its role/task, and required public contracts.
5. Keep generated memory/transcripts/mailbox under the run's ignored runtime
   path. Store only short, factual task summaries for restarts within that run.
6. Keep keys in the provider's normal user credential store/environment; never
   put them in game config, shared prompts, reports, or committed files.

The ignore list covers provider/orchestrator session directories, `.context/`,
databases, secrets, dependencies, artifacts, and local config. `AGENTS.md`,
`CLAUDE.md`, `prompts/`, public `tests/fixtures/`, and shared docs stay tracked.
If an app needs configuration, use a redacted template under `examples/` and
an ignored local copy. Do not ignore the rules that agents need to follow.

Only the human may compare competitor results or unblind held-out tests.
Publish a redacted report after the run; during independent trials, keep it in
the runtime directory so later agents do not consume earlier trial findings.
