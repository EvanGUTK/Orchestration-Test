# Fair orchestration benchmark and 1,000-point project score

## What is being measured

Product completeness/correctness, orchestration quality, failure recovery,
delivery evidence, wall time, resource/cost usage, and human intervention.
The project's game leaderboard is separate from this laboratory score.
Opening six panes is setup; real coordination needs task ownership, dependency
handoffs, message acknowledgments, independently reviewed artifacts, and integration.

## Controlled experiment

1. Record the frozen `origin/main` SHA. All eight canonical branches begin there.
2. Select a budget BEFORE starting: elapsed duration, provider cost limit,
   chief/worker count, context/model settings, allowed human intervention.
3. Keep stack, public requirements, fixtures, and score rubric identical.
4. Keep the provider/model mix constant where tools support it. Native Claude
   teams necessarily use Claude; compare that result as provider-constrained.
5. Use one chief + five workers. Record shared vs isolated checkout mode.
6. Run one experiment at a time on the reference machine for scored performance;
   simultaneous competitors contend for hardware and invalidate latency comparison.
7. Start new conversations and isolated runtime data. Do not share memories,
   transcripts, implementations, or previous competitor outcomes.
8. Record native coordination and mailbox/manual-assisted trials as separate tracks.
   A fallback can prove a tool useful without claiming native features it lacks.
9. At the fixed cutoff, stop dispatch, let already committed work be recorded,
   and evaluate the frozen final SHA. Unfinished work is reported, not erased.
10. Keep raw evidence private in the runtime. Publish redacted reports only after
    the human checks them; do not expose trial findings to later independent runs.

For repeats, use a new independent clone and worker run IDs. Clone the shared
baseline branch, create a run-specific local copy of the software lane in that
clone from the recorded SHA, and keep repeat results local or in a human-approved
archive. Never force-reset a published canonical branch. The human decides which
trial becomes the software's public result; agents cannot erase earlier work.

## Run manifest

Copy `benchmark/run-template.json` into the runtime and fill it in. Required:
experiment/run IDs, baseline/start/final SHA, app/CLI versions, OS/CPU/RAM/GPU,
models/provider route/quantization/context, timestamps, budget, actual usage,
checkout mode, ports/database path, native vs assisted coordination, tasks,
tests/artifacts, interventions, conflicts, and termination reason.
Never put access tokens or live account details in a manifest/report.

Time is measured from first dispatch to last accepted handoff/cutoff. Distinguish
installation/setup, implementation, integration, and evaluation time. Record
inference usage from actual provider receipts/CLI telemetry when available;
unknown cost is unknown, not zero. Local models record GPU time/memory/queueing.

## Evaluation and scoring

`benchmark/rubric.json` contains weighted items totaling 1,000. Rate each item:

| Rating | Meaning | Earned fraction |
| --- | --- | ---: |
| 0 | Absent, unrun, contradicted, or no evidence | 0% |
| 1 | Narrow partial implementation; major failures remain | 25% |
| 2 | Core path works, substantial required cases missing | 50% |
| 3 | Nearly complete; evidenced minor gaps remain | 75% |
| 4 | Complete requirement with independent passing evidence | 100% |

Each positive rating requires an evidence string pointing to a command/result,
artifact, or human-observed flow. Score uses exact integer quarter-points;
displayed total may contain .25/.50/.75. The scorer validates IDs/ratings/evidence
and completeness; it cannot determine whether an artifact is truthful. The human
evaluator checks evidence and signs off on the report.

```bash
python3 tools/score.py template --output "$LAB_RUNTIME/scorecard.json"
python3 tools/score.py score "$LAB_RUNTIME/scorecard.json"
```

No scores are prefilled as successes. Harness pass is not a product pass.
Rubric totals match README: engine170, persistence100, accounts80, UI100,
solo70, ranked80, bots70, duels100, replay60, performance70, delivery60,
orchestration40. Use product acceptance IDs to explain each item.

## Disqualification

Set the corresponding violation to true and describe evidence for any:

- `baseline_modified`: frozen main SHA or fixed baseline requirements changed.
- `prohibited_main_action`: experiment tried to push/merge/update main/master,
  including via API, GUI, or auto-merge queue, even if the guard blocked it.
- `cross_experiment_copy`: implementation/context/results copied from another lane.
- `benchmark_tampered`: shared acceptance/fixtures/guard/rubric changed to pass.
- `cloud_game_dependency`: gameplay/accounts/database/bots/assets require a cloud service.

A disqualified run has no ranked lab score. The scorer displays its raw points
only for diagnosis and exits 2. A malformed scorecard exits 1. A valid ordinary
scorecard exits 0. Human edits to baseline maintenance are outside experiment
runs and require a new version/baseline for all future competitors.

## Coordination evidence

Count tasks assigned/ACKed/completed, blocked duration, messages by type, round
trip questions, overlapping edits, failed integrations, successful recovery,
human nudges, and abandoned worker sessions. Distinguish accepted delivery,
started execution, and verified completion. Native tool state should be backed
by commits/tests, not a roster count or animated activity indicator.

Inject at least one realistic interruption: stop a worker after its committed
handoff, restart with only its own run's task summary, and finish its remaining
task. Separately test a dependency misunderstanding and a failing integration.
The team should correct them without lowering requirements or copying other runs.

## Report

Use `reports/TEMPLATE.md`. Include final SHA, observed install/build commands,
acceptance coverage, scorecard, costs/time, native/assisted limitations, screenshot
or screen recording references, and unresolved issues. Never publish fabricated
measurements. The repo begins with no completed game and no measured tool winner.
