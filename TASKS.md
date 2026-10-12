# TASKS — experiment/conductor, run r1 (chief ledger)

Milestones M0–M6 per docs/PROJECT_SCOPE.md. States: assigned → ACKed → in-progress → result → integrated → verified.

| Task | Role | Milestone | Depends on | State |
| --- | --- | --- | --- | --- |
| CONTRACT-001 | chief | M0 | baseline | frozen (this commit) |
| ENGINE-001 | engine | M1 | CONTRACT-001 | integrated (2e27c7c; 58 tests, golden ok, bench p95 0.0024ms) |
| BACKEND-001 | backend | M2 | CONTRACT-001 (+ ENGINE-001 for moves) | Phase A+B integrated (941226f; 281 tests green; live health/ready/static ok); Phase C in progress |
| FRONTEND-001 | frontend | M1 | CONTRACT-001 (+ ENGINE-001) | integrated (2c184f0; 211 tests total green; build ok; needs backend wiring) |
| COMP-001 | competition | M3 | CONTRACT-001 (+ ENGINE-001) | integrated (d17f158; 163 tests total green; note bots sim uses Number exponents with limit guard) |
| QUALITY-001 | quality | M0 | CONTRACT-001 | integrated part 1 (28ebef4; independent oracle: no golden mismatch; server suites pending apps) |
