# TASKS — experiment/conductor, run r1 (chief ledger)

Milestones M0–M6 per docs/PROJECT_SCOPE.md. States: assigned → ACKed → in-progress → result → integrated → verified.

| Task | Role | Milestone | Depends on | State |
| --- | --- | --- | --- | --- |
| CONTRACT-001 | chief | M0 | baseline | frozen (this commit) |
| ENGINE-001 | engine | M1 | CONTRACT-001 | integrated (2e27c7c; 58 tests, golden ok, bench p95 0.0024ms) |
| BACKEND-001 | backend | M2 | CONTRACT-001 (+ ENGINE-001 for moves) | ACKed + plan received |
| FRONTEND-001 | frontend | M1 | CONTRACT-001 (+ ENGINE-001) | ACKed + plan received |
| COMP-001 | competition | M3 | CONTRACT-001 (+ ENGINE-001) | integrated (d17f158; 163 tests total green; note bots sim uses Number exponents with limit guard) |
| QUALITY-001 | quality | M0 | CONTRACT-001 | ACKed + plan received |
