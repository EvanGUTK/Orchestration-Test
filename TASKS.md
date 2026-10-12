# TASKS — experiment/conductor, run r1 (chief ledger)

Milestones M0–M6 per docs/PROJECT_SCOPE.md. States: assigned → ACKed → in-progress → result → integrated → verified.

| Task | Role | Milestone | Depends on | State |
| --- | --- | --- | --- | --- |
| CONTRACT-001 | chief | M0 | baseline | frozen (this commit) |
| ENGINE-001 | engine | M1 | CONTRACT-001 | assigned |
| BACKEND-001 | backend | M2 | CONTRACT-001 (+ ENGINE-001 for moves) | assigned |
| FRONTEND-001 | frontend | M1 | CONTRACT-001 (+ ENGINE-001) | assigned |
| COMP-001 | competition | M3 | CONTRACT-001 (+ ENGINE-001) | assigned |
| QUALITY-001 | quality | M0 | CONTRACT-001 | assigned |
