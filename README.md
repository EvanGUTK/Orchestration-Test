<div align="center">

# ✨ ORCHESTRATION ARENA ✨

### Eight orchestration tools. One massive build. Zero merges to main.

**2048 INFINITE · LOCAL ACCOUNTS · SQLITE · RANKED · BOTS · 1v1**

![Experiments](https://img.shields.io/badge/experiments-8-8b5cf6?style=for-the-badge)
![Providers](https://img.shields.io/badge/providers-mixed-06b6d4?style=for-the-badge)
![Runtime](https://img.shields.io/badge/game-local_only-22c55e?style=for-the-badge)
![Main](https://img.shields.io/badge/main-FROZEN-ef4444?style=for-the-badge)
![License](https://img.shields.io/badge/license-MIT-f59e0b?style=for-the-badge)

**Conductor • Harmony Desktop • Gas Town • dmux • Herdr • BridgeMind • Native Claude Teams • PaneFlow**

</div>

---

This repository stress-tests AI orchestration software against one substantial
build. Each tool gets its own branch, identical architecture and requirements,
and the same scoring system. The assignment is a polished, fully local 2048
Infinite game with accounts, saves, leaderboards, ranked challenges, replays,
algorithmic bots, and local 1v1 competition.

Use **Codex, Claude Code, OpenCode, Antigravity, and Ollama-backed agents**.
No single provider owns this repo. Native Claude teams have their own provider
constraint; the other experiments can test mixed CLI sessions where supported.

> **Baseline status:** runnable lab tools, shared documentation, role prompts,
> Git guards, mailbox, fixtures, and scoring. **The game is the assignment;
> it is not implemented in the baseline.** Installation guidance was checked
> against official sources on **October 12, 2026**. Record installed versions.

## 🧭 Guide map

- [Quick start](#-quick-start)
- [Branches and rules](#-branches-and-rules)
- [Shared prerequisites](#-shared-prerequisites)
- [All five AI tool families](#-all-five-ai-tool-families)
- [All eight orchestration tools](#-all-eight-orchestration-tools)
- [PaneFlow: chief plus five CLI workers](#-paneflow-chief-plus-five-cli-workers)
- [Universal messaging](#-universal-messaging)
- [Project, architecture, and scoring](#-project-architecture-and-scoring)
- [Troubleshooting](#-troubleshooting)

## 🚀 Quick start

Install Git, Python 3.10+, Node.js 24 LTS, and a chosen agent CLI first.
Lab tools need only Python's standard library and Git. Use WSL2 for Bash
examples on Windows, or the generated PowerShell environment file for native apps.

```bash
git clone https://github.com/EvanGUTK/Orchestration-Test.git
cd Orchestration-Test
python3 tools/check_repo.py
python3 -m unittest discover -s tests/harness -v
python3 tools/lab.py list

# One chief plus five isolated worker worktrees. Keep them OUTSIDE this checkout.
python3 tools/lab.py setup paneflow --run trial-001 \
  --directory ../orchestration-runs/paneflow-trial-001
cd ../orchestration-runs/paneflow-trial-001/chief
source .lab/env.sh
python3 tools/lab.py guard
python3 tools/mailbox.py init
```

Setup prints six role paths and generates `.lab/env.sh` and `.lab/env.ps1`
in each. Open those folders in the selected app. Start the chief with
[CHIEF.md](prompts/CHIEF.md) and workers with [WORKER.md](prompts/WORKER.md),
replacing SOFTWARE/RUN_ID/ROLE. Use [TASK.md](prompts/TASK.md) for task envelopes.
One canonical chief checkout per software is allowed; use an existing chief
or a fresh independent clone for another trial. Setup never resets a run.

Native PowerShell, from a generated role folder:

```powershell
. .\.lab\env.ps1
python tools/lab.py guard
python tools/mailbox.py init
```

Do not run `npm ci` at the shared baseline yet. Each competitor creates the
application workspace and actual install/build/test commands at milestone M0.
See [architecture](docs/ARCHITECTURE.md) for required commands.

## 🔒 Branches and rules

| Software | Canonical branch | Web / API ports |
| --- | --- | --- |
| Conductor | `experiment/conductor` | 5411 / 5511 |
| Harmony Desktop | `experiment/harmony-desktop` | 5412 / 5512 |
| Gas Town | `experiment/gas-town` | 5413 / 5513 |
| dmux | `experiment/dmux` | 5414 / 5514 |
| Herdr | `experiment/herdr` | 5415 / 5515 |
| BridgeMind | `experiment/bridgemind` | 5416 / 5516 |
| Native Claude teams | `experiment/native-claude-teams` | 5417 / 5517 |
| PaneFlow | `experiment/paneflow` | 5418 / 5518 |

**No agent may push, merge, cherry-pick, rebase, reset, force-update, or delete
`main`/`master`. No experiment PR may target them. No tool may update another
competitor's branch.** [BRANCH_RULES.md](BRANCH_RULES.md) is mandatory.

All eight branches start at one shared baseline SHA. Optional worker branches
follow `workers/<software>/<run>/<role>` and integrate only into that software's
canonical branch. Shared [AGENTS.md](AGENTS.md) applies to every agent;
[CLAUDE.md](CLAUDE.md) points Claude and teammates to the same rules.

`lab.py setup` installs commit/merge/rebase/push guards. An app's separate clone
also needs:

```bash
python3 tools/lab.py install-hooks
python3 tools/lab.py guard
git config --get core.hooksPath
```

The remote baseline is frozen with a GitHub ruleset after bootstrap. See
[repository operations](docs/REPOSITORY_OPERATIONS.md) for readback and owner
maintenance. Hooks/Markdown are not a sandbox; keep the owner's admin token
out of experimental agents. The [.gitignore](.gitignore) excludes sessions,
context, keys, databases, and artifacts. It cannot stop agents reading files;
follow [context isolation](docs/CONTEXT_POLICY.md) and use fresh conversations.

## 🧰 Shared prerequisites

| Environment | Route |
| --- | --- |
| macOS | Homebrew prerequisites; Conductor and BridgeMind desktop available |
| Linux desktop | Native CLIs, Harmony, Herdr, PaneFlow |
| Windows | Native GUI tools; WSL2 for tmux/dmux/Gas Town/Bash harness |
| Headless SSH | CLI experiments; GUI tools require a graphical session |

Conductor's checked desktop release is macOS-only. BridgeMind One requires
macOS 26+, has Windows in development, and no Linux release. Sources:
[Conductor install](https://www.conductor.build/docs/installation),
[BridgeMind requirements](https://docs.bridgemind.ai/docs/getting-started).
Unsupported platforms are recorded as unavailable, not silently substituted.

### macOS

Install [Homebrew](https://brew.sh/) if absent, then:

```bash
brew install git gh node@24 python tmux sqlite jq
export PATH="$(brew --prefix node@24)/bin:$PATH"
git --version
node --version
python3 --version
tmux -V
gh auth login
gh auth status
```

Persist the Node PATH in your shell profile if needed. Have Xcode command-line
tools available for native SQLite/password-hashing dependencies.

### Debian / Ubuntu

```bash
sudo apt update
sudo apt install git gh python3 tmux sqlite3 jq curl ca-certificates \
  build-essential pkg-config libicu-dev
```

Install Node 24 from [official downloads](https://nodejs.org/en/download) or
your existing version manager. With nvm already installed:

```bash
nvm install 24
nvm use 24
node --version
npm --version
gh auth login
```

Do not use an old distro Node version for this benchmark. Gas Town needs
additional Go/Dolt/Beads prerequisites described below.

### Windows / WSL2

For tmux tools, from elevated PowerShell:

```powershell
wsl --install -d Ubuntu
```

Restart when prompted. In Ubuntu follow Linux prerequisites, clone under
`~/src`, and install CLIs inside WSL if their worktrees live there. Keep all
six panes in one filesystem/toolchain environment. Native users install
[Git](https://git-scm.com/downloads/win), [Python](https://www.python.org/downloads/),
[Node 24](https://nodejs.org/en/download), and [GitHub CLI](https://cli.github.com/).
Use `python` if `python3` is absent. Native PaneFlow uses PowerShell/Git Bash
for directory tracking; avoid assuming a Windows binary sees a WSL socket.

### Check providers before orchestration

```bash
git --version
python3 --version
node --version
codex --version
claude --version
opencode --version
agy --help
ollama --version
```

Install missing tools next. Run a small real task per selected provider before
adding orchestration. Binary detection does not prove login/model/tool access.
Freeze versions/settings for a trial; do not upgrade one competitor mid-run.

## 🤖 All five AI tool families

These are coding agents/model runtimes. Orchestrators coordinate them; they do
not supply every subscription. Hosted AI can build the product, while the
finished game's accounts, database, bots, and assets remain entirely local.

### Codex CLI / desktop

```bash
npm install -g @openai/codex
codex --version
codex login
codex
```

macOS alternative: `brew install --cask codex`. Official standalone installers
also exist for macOS/Linux/Windows. Choose one method. Complete its account/API
auth route and record the model. Desktop users follow official download/setup
and open the experiment role folder. Sources:
[CLI install](https://learn.chatgpt.com/docs/codex/cli),
[Codex quickstart](https://developers.openai.com/codex/quickstart).

Our procedure: confirm branch, attach shared rules and role prompt, perform a
read-only smoke task, then test file/tool access inside the worktree. Do not
enable unrestricted access as an installation workaround. Ollama mode is below.

### Claude Code CLI / Claude desktop

macOS/Linux/WSL:

```bash
curl -fsSL https://claude.ai/install.sh -o /tmp/claude-install.sh
bash /tmp/claude-install.sh
claude --version
claude
```

Complete interactive login, or `/login` when needed. macOS alternative:
`brew install --cask claude-code`. Native Windows:

```powershell
winget install Anthropic.ClaudeCode
claude --version
claude
```

Claude Code is the terminal coding agent; Claude desktop chat is a different
surface. Use local Code-enabled workspaces or CLI sessions for this benchmark.
Open one role folder per session and read CLAUDE.md plus the shared rules.
Sources: [Code setup](https://code.claude.com/docs/en/setup),
[desktop download](https://claude.ai/download).

### OpenCode CLI / desktop

The checked OpenCode 1 docs provide:

```bash
npm install -g opencode-ai
opencode --version
opencode
```

In the TUI use `/connect`, choose/authenticate a provider, and select a model.
That version's Windows guide recommends WSL; native npm/Scoop/Chocolatey routes
are also documented. Desktop builds: [official downloads](https://opencode.ai/download).
Record OpenCode 1 versus 2; installers may replace the same binary. Source:
[OpenCode installation](https://opencode.ai/docs/).

Our procedure: use existing AGENTS.md; do not let `/init` overwrite benchmark
rules. Enter the role worktree and attach the task/contract. Store personal
provider config in ignored `opencode.json` or user config, not the shared baseline.

### Antigravity desktop / CLI

Install the matching desktop build from
[Google Antigravity downloads](https://antigravity.google/download), finish
first-run authentication, and open an assigned role folder. Current official
CLI installation exposes `agy`:

```bash
curl -fsSL https://antigravity.google/cli/install.sh -o /tmp/agy-install.sh
bash /tmp/agy-install.sh
agy --help
agy
```

Native PowerShell:

```powershell
irm https://antigravity.google/cli/install.ps1 -OutFile agy-install.ps1
powershell -ExecutionPolicy Bypass -File .\agy-install.ps1
agy
```

Complete the first-launch auth flow. Unix installs use `~/.local/bin/agy`;
open a new terminal if PATH has not refreshed. Source:
[CLI getting started](https://antigravity.google/docs/getting-started?tab=cli).
Our procedure: separate role tasks/sessions, shared rules, and mailbox when the
orchestrator has no native Antigravity adapter. Verify `agy` runs interactively
in a plain terminal; an IDE launcher alone is not a CLI worker.

### Ollama: local runtime and coding-agent backends

Ollama serves models. `ollama run` alone is chat, not a repository editing agent.
Use a coding CLI connected to Ollama for worker file/tool access.
Install from [Ollama downloads](https://ollama.com/download) on macOS/Windows.
Linux:

```bash
curl -fsSL https://ollama.com/install.sh -o /tmp/ollama-install.sh
sh /tmp/ollama-install.sh
ollama --version
# Separate terminal, only if a service/desktop is not already serving:
ollama serve
```

Check service/models; this is an example local model, not a hardware guarantee:

```bash
curl http://127.0.0.1:11434/api/tags
ollama list
ollama pull qwen3.5
ollama run qwen3.5
```

Choose a model you have measured for RAM/VRAM, context, and tool calls. Do not
select a `-cloud` model for a local-inference trial. Source:
[Ollama quickstart](https://docs.ollama.com/quickstart).

From the assigned role worktree, launch a coding agent:

```bash
ollama launch opencode
ollama launch claude
ollama launch codex
```

Choose the intended local model when prompted. Install the underlying CLI first
when required. Codex also offers `codex --oss`; its Ollama guide calls for at
least 64k context. Sources: [OpenCode adapter](https://docs.ollama.com/integrations/opencode),
[Claude adapter](https://docs.ollama.com/integrations/claude-code),
[Codex adapter](https://docs.ollama.com/integrations/codex).

Manual OpenCode configuration: copy [this example](examples/opencode.ollama.json)
to ignored `opencode.json`, change the model to an installed model, and verify
one actual read/edit/test cycle. Six generations share hardware; record context,
quantization, parallelism, residency, and queueing. Reduce concurrency when
memory is insufficient. The game bots themselves are algorithms, not Ollama calls.

## 🎛 All eight orchestration tools

Common sequence: install agents → smoke-test one → prepare branch/worktrees →
open chief → create five workers → send rules/tasks → receive ACKs → dispatch →
review/integrate on the software branch → collect evidence. The sections below
describe the same benchmark roles, with each application's real capabilities.

### 1. Conductor

Identity: [conductor.build](https://www.conductor.build/), the coding-agent desktop
app. On macOS, download, drag to Applications, launch, and complete GitHub/provider
checks. Have `gh auth status` and provider login working. Source:
[official install](https://www.conductor.build/docs/installation).

1. Prepare `conductor` with lab.py, or import the repo and explicitly choose
   `experiment/conductor` as the base/integration branch.
2. Open the chief worktree where supported. If the app creates its own workspace
   branch, use `workers/conductor/<run>/<role>` and a separate canonical chief.
3. Create five worker workspaces, or documented same-workspace agents with
   strict disjoint file ownership. Every separate clone needs repo hooks.
4. Give all roles the same runtime identity/path and role prompts. Select only
   supported harnesses; use ordinary terminal CLIs for others where available.
5. Use visible agent sessions and the universal mailbox for task/ACK/result
   exchanges. Check committed work and tests rather than a busy/idle indicator.
6. Integrate reviewed commits into `experiment/conductor`; inspect every PR base.

Separate workspaces isolate branches/files; agents in one workspace share state.
Source: [parallel agent concepts](https://www.conductor.build/docs/concepts/parallel-agents).
Keep six logical roles either way. A cloud edition trial must be labeled separately
from desktop, even when it builds the same local-only game.

### 2. Harmony Desktop — ideharmony.com

Identity: [ideharmony.com](https://ideharmony.com/). Current docs use `harmony`;
legacy `nala` naming remains in some installer/TUI paths. This is the user's
specified Harmony product.

```bash
curl -fsSL https://ideharmony.com/install.sh -o /tmp/harmony-install.sh
sh /tmp/harmony-install.sh
harmony version
harmony doctor
harmony desktop
```

PowerShell: `irm https://ideharmony.com/install.ps1 | iex`. Use the official
download for your OS/architecture. Current builds are preview; artifacts and
signature status vary. If only `nala` resolves, restart the shell and inspect
installed compatibility help. Source:
[Harmony installation](https://docs.ideharmony.com/docs/getting-started/installation).

1. Prepare `harmony-desktop` worktrees and open chief in a workspace.
2. Connect providers and prove one single-agent session before delegation.
3. Create five role panes/worktrees and apply prompts. Verify actual paths.
4. In workspace settings select A2A Connect for messaging or Orchestrate for
   orchestration; inspect provider permissions before launching.
5. Discover actual IDs and try native messaging:

```bash
harmony agent list
harmony agent send <engine-agent-id> "ENGINE-001: read your task and ACK CONTRACT-001."
harmony agent inbox
harmony agent reply <message-id> "ACK; owns packages/engine."
harmony agent delivery-status <message-id>
harmony tasks list
```

Delivered/queued/unknown does not prove task execution/completion. Source:
[Harmony A2A CLI](https://docs.ideharmony.com/docs/a2a/cli).
For native delegation its docs describe `/orchestrate <goal>` as experimental.
Apply the chief brief, inspect plan/routes/costs/worktree isolation, then use
the app's approval flow. Record unproven capabilities and separately label a
mailbox-assisted fallback. Source:
[first orchestration run](https://docs.ideharmony.com/docs/getting-started/first-orchestration-run).
All integration stays on `experiment/harmony-desktop`.

### 3. Gas Town

Identity: [gastownhall/gastown](https://github.com/gastownhall/gastown).
Existing source module paths may retain steveyegge. Current official install
guide owns prerequisite/module-path details.

macOS:

```bash
brew install gastown
gt --version
bd version
dolt version
```

Linux/source requires current Go (checked guide: 1.26.2+), Git, SQLite, ICU dev
headers, Dolt, Beads, tmux, and an agent CLI. Install Go from
[go.dev](https://go.dev/doc/install) and Dolt through
[its official guide](https://docs.dolthub.com/introduction/installation), then:

```bash
go install github.com/steveyegge/gastown/cmd/gt@latest
go install github.com/steveyegge/beads/cmd/bd@latest
export PATH="$HOME/go/bin:$PATH"
gt --version
bd version
dolt version
```

Windows: use WSL2 for the tmux workflow, or document upstream Docker/native
setup separately. Docker needs a dedicated empty town directory. Source:
[Gas Town install](https://github.com/gastownhall/gastown/blob/main/docs/INSTALLING.md).

Create a dedicated town and explicitly select the experiment branch:

```bash
gt install ~/orchestration-gastown --git
cd ~/orchestration-gastown
gt rig add arena https://github.com/EvanGUTK/Orchestration-Test.git \
  --branch experiment/gas-town
gt doctor
gt mayor attach
```

Check installed `gt rig add --help` supports `--branch`; inspect actual rig
config/checkout branches. Do not start a refinery targeting main. Install repo
guards in independent clones. If automatic polecat branches cannot honor the
allowed namespace, use five crew/manual role worktrees and keep the default
refinery disabled until its destination is verified.

Mayor is chief. Give the shared chief prompt and five assignments. Beads tracks
tasks/convoys; use returned IDs. Native agent mail example:

```bash
gt mail send arena/<actual-worker-name> -s "ENGINE-001" -m "Read assigned task and ACK."
gt mail inbox
gt mail send mayor/ -s "ENGINE-001 result" -m "SHA, tests, artifact path, and risks."
```

Rig branch/mail commands were also checked with local `gt` 1.2.1 help. Measure
native handoffs, restarts, and durable task state. Source:
[Gas Town overview](https://github.com/gastownhall/gastown). Never let a default
merge queue integrate this test into shared main.

### 4. dmux

Identity: [standardagents/dmux](https://github.com/standardagents/dmux).
Install tmux, Node, Git, and agent CLIs first:

```bash
npm install -g dmux
tmux -V
dmux --help
cd /path/to/dmux/chief
source .lab/env.sh
dmux
```

`n` creates an agent pane/worktree, `t` a terminal, `m` pane actions, `s` settings.
Checked docs allow choosing a base branch and explicit worktree/branch name.
Source: [dmux README](https://github.com/standardagents/dmux).

Set base `experiment/dmux`, names `workers/dmux/<run>/<role>`. With our existing
worktrees, use ordinary terminals and enter those paths instead of duplicating
branches. Launch one chief plus five workers after sourcing each environment.
Provider settings for optional naming/summaries are separate from coding-agent
auth. Use mailbox for cross-provider messages and visible terminals for initial
prompts/wake-ups. Inspect every Merge/PR destination; only `experiment/dmux`.

### 5. Herdr

Identity: [herdrdev/herdr](https://github.com/herdrdev/herdr), docs at
[herdr.dev](https://herdr.dev/docs/).

```bash
curl -fsSL https://herdr.dev/install.sh -o /tmp/herdr-install.sh
sh /tmp/herdr-install.sh
herdr --help
herdr
```

Homebrew: `brew install herdr`. Native Windows installers/archive requirements
are documented. Source: [Herdr install](https://herdr.dev/docs/install/).
Prepare `herdr` worktrees. Layout creation and agent startup are distinct;
capture real IDs from JSON:

```bash
created=$(herdr workspace create --cwd /absolute/path/to/chief --label arena --no-focus)
chief_pane=$(printf '%s\n' "$created" | jq -r '.result.root_pane.pane_id')
split=$(herdr pane split "$chief_pane" --direction right --no-focus)
engine_pane=$(printf '%s\n' "$split" | jq -r '.result.pane.pane_id')
# First enter the ENGINE worktree and source .lab/env.sh in engine_pane.
herdr agent start engine --kind opencode --pane "$engine_pane"
herdr agent prompt engine "Read AGENTS.md and ENGINE-001; ACK before edits." --wait --timeout 30000
herdr agent read engine --lines 120
```

Repeat splitting/path/env/launch for four more workers; launch chief in its pane.
Current automation recognizes claude/codex/opencode/agy among supported kinds;
unrecognized launchers can run in regular terminals. Use native prompt/read/wait
for conversation control, mailbox/artifact files for durable results. Source:
[Herdr automation](https://herdr.dev/docs/agent-automation/). Bound waits, inspect
blocked panes, and confirm evidence before declaring an idle worker done.

### 6. BridgeMind

Identity: [bridgemind.ai](https://www.bridgemind.ai/). Checked current docs describe
**BridgeMind One**, following older BridgeSpace/BridgeAgent names. Match docs
to your version. One requires macOS 26+ and account entitlement; Windows is in
development and Linux unsupported. Install DMG → Applications → launch → sign in.
Source: [getting started](https://docs.bridgemind.ai/docs/getting-started).

1. Install/authenticate provider CLIs in a normal shell first.
2. Prepare `bridgemind` worktrees; open Code mode and the chief project folder.
3. Start six role terminals/sessions, entering each folder and sourcing its env.
4. Use detected/supported engines, and normal terminals for other CLIs if supported.
5. Exchange tasks/ACK/results with mailbox. If your release has a documented
   native coordination adapter, record it separately; no message command is assumed.
6. Review diffs and integrate only into `experiment/bridgemind`.

Code mode detects installed CLIs; it does not bundle every engine. Chat alone
does not attach a project. Source: [Code mode](https://docs.bridgemind.ai/docs/code-mode).
Voice/routines are optional test dimensions; record hosted feature usage/costs.
They are not dependencies of the finished game's offline runtime.

### 7. Native Claude Code teams

This experiment measures native Claude sessions. Mixed-provider side panes are
an explicitly separate adapter trial, not native Claude teammates.

```bash
cd /path/to/native-claude-teams/chief
source .lab/env.sh
export CLAUDE_CODE_EXPERIMENTAL_AGENT_TEAMS=1
tmux new-session -s arena-claude
# Inside tmux; source .lab/env.sh again if your shell needs it:
claude --teammate-mode tmux
```

Without tmux, use `claude --teammate-mode in-process`. Teams are experimental
and version-dependent. Source: [official team guide](https://code.claude.com/docs/en/agent-teams).

Paste CHIEF.md and explicitly request an **agent team with exactly five
teammates**: engine/backend/frontend/competition/quality. Use native tasks/messages,
require CONTRACT-001 ACKs, and assign worktrees/owned paths. Verify actual
teammates rather than ordinary subagents. If this build cannot assign isolated
workdirs, use shared-checkout mode with disjoint ownership and chief-only
integration. Record the limitation. Use native messaging for handoffs and the
normal shutdown/cleanup flow after collecting committed results and evidence.

### 8. PaneFlow

Identity: [paneflow.dev](https://paneflow.dev/), a multiplexer with local automation
in current builds. Install coding agents separately.

macOS:

```bash
brew install --cask arthjean/paneflow/paneflow
paneflow --version
paneflow
```

Linux: use the official matching `.deb`/tarball and architecture. Desktop Vulkan
loader/compatible GPU drivers are needed. Windows: official x64 MSI with
PowerShell/Git Bash panes. Source: [getting started](https://paneflow.dev/docs).
Use the six-pane recipe below. Mailbox/manual dispatch works even without native
automation; scripting writes need deliberate access on the running process.

## 🪟 PaneFlow: chief plus five CLI workers

### A. Six panes with six working directories

Prepare `paneflow` using quick start. Open PaneFlow in chief. Split to six shells;
current defaults: `Cmd/Ctrl+Shift+D` horizontal, `Cmd/Ctrl+Shift+E` vertical,
`Alt+Arrow` focus. Source: [current guide](https://paneflow.dev/docs).

```text
┌────────────────────────┬────────────────────────┐
│ CHIEF                  │ ENGINE                 │
├────────────────────────┼────────────────────────┤
│ BACKEND                │ FRONTEND               │
├────────────────────────┼────────────────────────┤
│ COMPETITION            │ QUALITY                │
└────────────────────────┴────────────────────────┘
```

Splits inherit directories; they do not isolate source automatically. In each
pane enter its generated role path, source env, and check branch:

```bash
cd /absolute/path/orchestration-runs/paneflow-trial-001/engine
source .lab/env.sh
git branch --show-current
python3 tools/lab.py guard
```

Example mix: chief Claude, engine Codex, backend OpenCode, frontend Antigravity,
competition OpenCode+local Ollama, quality Claude. This tests interoperability;
for controlled orchestration comparisons hold models/provider mix fixed where possible.
Launch CLIs after sourcing env. Paste WORKER.md into five workers and CHIEF.md
into chief, with real software/run/role/path names. All six need the same LAB_RUNTIME.

### B. Mailbox mode without a pane API

Chief initializes the mailbox and posts the first task:

```bash
python3 tools/mailbox.py init
python3 tools/mailbox.py send --from chief --to engine --kind task \
  --task ENGINE-001 --body 'Review CONTRACT-001; own packages/engine. ACK with plan before edits.'
```

Tell the engine agent to run:

```bash
python3 tools/mailbox.py inbox engine
python3 tools/mailbox.py ack engine <actual-message-id>
python3 tools/mailbox.py send --from engine --to chief --kind ack \
  --task ENGINE-001 --body 'ACK; owns packages/engine; ready after contract review.'
```

Repeat for backend/frontend/competition/quality. Chief reads `inbox chief`,
checks ACKs, and dispatches only tasks whose dependencies are met. Results carry
task ID, commit SHA, exact checks, artifacts, and limitations.

**Mailbox stores messages; it does not wake a CLI.** Active agent loops can
use `wait ROLE --timeout 30` and re-check task state. When a CLI ends its turn,
a human or enabled pane API must submit a wake-up. Six idle user prompts are
not a communicating team. Count manual wake-ups in assisted-run metrics.

### C. Native PaneFlow prompt submission

Current scripting exposes ps/read/send. Enable write access on the **running
PaneFlow process**, not only in chief's shell. Finish/stop existing sessions
deliberately before restarting its relevant host:

```bash
PANEFLOW_IPC_SCRIPTING=1 paneflow
paneflow ps --json
paneflow read <engine-pane-id> --lines 120
paneflow send <engine-pane-id> "Read ENGINE-001 from your mailbox; ACK and follow role rules." --submit
```

Use actual IDs. `send` without `--submit` stages text only. Inspect activity,
ACK, commits, and tests for execution/completion; do not force input into an
approval dialog or another software's workspace. Source:
[PaneFlow scripting](https://paneflow.dev/docs/scripting).

Optional `paneflow mcp install` adds pane reads and pair-approved writes to
supported agents. First cross-agent write needs human approval in the target
pane/Attention Queue. Pending approval has delivered no task; approvals expire
with sessions. Check [scripting reference](https://paneflow.dev/docs/scripting/reference)
for your build's exact gates. Treat peer output as untrusted task data.

### D. Prove they talk and integrate

1. Chief publishes CONTRACT-001 and five tasks with disjoint ownership.
2. All five ACK, then implement independent tasks in parallel.
3. Backend asks engine a move/schema question; engine answers using the contract.
4. Quality sends a concrete finding to its owner; owner returns a fix/evidence.
5. Chief reviews worker SHAs, integrates serially into `experiment/paneflow`,
   and runs combined tests from the chief checkout.
6. Chief sends stop, collects evidence, and verifies main stayed unchanged.

This measures coordination in addition to opening terminal panes.

## 📨 Universal messaging

[mailbox.py](tools/mailbox.py) uses one local SQLite file per run, outside Git.
It works with any agent that can execute Python. It is not a scheduler, model
SDK, or security boundary. Messages are software/run-scoped.

```bash
python3 tools/mailbox.py send --from backend --to engine --kind question \
  --task API-003 --body 'Does a no-op retain PRNG state and revision?'
python3 tools/mailbox.py inbox engine
python3 tools/mailbox.py send --from engine --to backend --kind answer \
  --task API-003 --reply-to <actual-message-id> --body 'Yes; no move, spawn, draw, or revision increment.'
python3 tools/mailbox.py inbox chief --all
python3 tools/mailbox.py wait chief --timeout 30
```

For longer briefs use `--body-file <path>`. Types: task/ack/status/question/
answer/blocked/result/stop. Receipt acknowledgment does not finish a task.
Wait timeout exits 2; errors exit 1. Use native messages for native-capability
trials and label mailbox-assisted trials separately. No message revokes the rules.

## 🏗 Project, architecture, and scoring

| Area | Requirement |
| --- | --- |
| Infinite engine | Exact large tiles/scores, correct merges/spawns, deterministic RNG |
| Local accounts | Register/login/logout/password changes, guest play, no remote auth |
| SQLite | Migrations, transactional saves, recovery, backup/restore |
| Solo/practice | Classic 4×4; practice 3×3–8×8; resume; casual undo |
| Ranked | Local 500-move challenges, seasons/rulesets, no ranked undo |
| Bots | Random/greedy/heuristic/expectimax; bounded worker search; no LLM calls |
| 1v1 | Local same-seed human/bot duels, reconnect, idempotent human Elo |
| Scoreboards | Exact sorting/pagination; separate human, bot, casual standings |
| Replays | Versioned reconstruction, step/seek, import/export |
| UI | Responsive keyboard/touch, accessible controls, reduced motion |
| Resilience | Offline assets, stale-command rejection, fault/restart tests |
| Stress | Large histories, concurrent local games, bot load, durable evidence |

Detailed [scope](docs/PROJECT_SCOPE.md), [architecture](docs/ARCHITECTURE.md),
[contracts](docs/CONTRACTS.md), [acceptance](docs/ACCEPTANCE.md), and
[benchmark methodology](docs/BENCHMARK.md) are identical on every branch.
Local ranked is among accounts on this installation. Local 1v1 uses sessions
on this machine/hot-seat, not public/LAN matchmaking. Infinite has no designed
tile ceiling, while finite machine limits fail recoverably.

The common rubric totals **1,000 points**:

| Category | Max |
| --- | ---: |
| Engine/exact arithmetic | 170 |
| Persistence/durability | 100 |
| Accounts/security | 80 |
| UI/accessibility | 100 |
| Solo/practice | 70 |
| Ranked/leaderboards | 80 |
| Bots | 70 |
| Duels/ratings | 100 |
| Replay/export | 60 |
| Performance/stress | 70 |
| Verification/delivery | 60 |
| Orchestration/recovery | 40 |
| **Total** | **1,000** |

Use [rubric.json](benchmark/rubric.json) and [report template](reports/TEMPLATE.md).
Initialize every item at zero, then have the human evaluator add ratings/evidence:

```bash
python3 tools/score.py template --output "$LAB_RUNTIME/scorecard.json"
python3 tools/score.py score "$LAB_RUNTIME/scorecard.json"
```

Prohibited main actions, baseline modification, cross-experiment copying,
rubric/test tampering, or game cloud dependencies disqualify a run. Missing
evidence earns zero. Record costs/human interventions as separate metrics;
do not invent grades or results from unrun experiments. This lab's scorecard
is separate from the game's scoreboard.

Record baseline/start/final SHA, tool/CLI/model versions, provider mix, auth
route without secrets, hardware/OS, budgets, messages, interventions, conflicts,
latency samples, and recovery evidence. Compare native and assisted runs separately.

## 🩺 Troubleshooting

| Symptom | Check / recovery |
| --- | --- |
| Main blocked by guard | Expected. Use assigned role/experiment worktree. |
| App PR/merge points at main | Set software branch; cancel if it cannot honor isolation. |
| Existing hooks conflict | Human reconciles hook chain; do not overwrite protections. |
| Desktop pane cannot find CLI | Restart shell/app after PATH change; verify normal shell first. |
| Worker branches already exist | Fresh run ID or reuse existing run; never reset other work. |
| Canonical branch already checked out | Existing chief or fresh independent clone. |
| Empty mailbox | Match LAB_RUNTIME, LAB_EXPERIMENT, LAB_RUN_ID and recipient. |
| Idle worker despite task | Mailbox does not wake a CLI; submit via API/human relay. |
| Delivered but no result | Check activity/ACK/task state/artifacts before retrying. |
| Workers collide | Stop overlapping ownership; chief integrates serially. |
| Six local models stall | Measure RAM/VRAM/queueing and lower concurrency/context. |
| Browser cannot reach app | Confirm loopback port and integrated chief checkout. |
| Database lock / polluted saves | Single writer and private temp databases for tests. |
| Native/WSL mismatch | Same filesystem/toolchain/runtime/socket environment. |
| Unsupported OS | Record unavailable; do not invent a package or substitute tool. |
| Installer fetched HTML | Stop and verify official URL/network response before executing. |

Repository maintenance and repeat trials: [operations](docs/REPOSITORY_OPERATIONS.md).
The original [MIT license](LICENSE) is preserved. Build hard, measure honestly,
and keep the lanes isolated. 🎮
