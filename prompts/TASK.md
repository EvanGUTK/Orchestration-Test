# Task envelope

```text
Task: ENGINE-001
From: chief
To: engine
Experiment: SOFTWARE
Run: RUN_ID
Contract: CONTRACT-001 / v1
Branch/workdir: workers/SOFTWARE/RUN_ID/engine / ABSOLUTE_PATH
Owns: packages/engine/**
Depends on: reviewed types and PRNG golden vectors
Outcome: pure immutable slide implementation and deterministic tests
Acceptance: all public merge vectors; no double merge; exact score above 2^53
Budget: HUMAN_DEFINED
Reply: ACK + plan; then RESULT + SHA + commands + artifacts + risks
Forbidden: main/master, other experiments, scope/rubric changes, shared root files
```
