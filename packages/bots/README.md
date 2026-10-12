# packages/bots

Competition owns four deterministic bounded bot strategies and worker search. Never call a cloud service or peek at future RNG.

Shared requirements: [architecture](../../docs/ARCHITECTURE.md).

## API (COMP-001, CONTRACT-001/v1)

- `chooseMove(board, config, options?)` returns `{ direction, explanation, nodes, stopReason, depthReached, strategy, botVersion }`.
  Board only (cloned), tie-breaks from `createBotStream(seed, moveIndex)` in the `2048-infinite/v1/bot` namespace, node budget,
  optional wall-time budget (`ignoreTimeBudget` for deterministic modes), `AbortSignal`-style cancellation, legal-move fallback.
- Strategies: `random` (1), `greedy` (2), `heuristic` alpha-beta with pessimistic spawn (3), `expectimax` with chance nodes (4);
  iterative deepening, a deeper pass replaces the previous result only if it completed.
- `startBotRun(options)` runs a game in a `worker_threads` worker (`src/worker.ts`) with `pause/resume/step/cancel/terminate`
  (SharedArrayBuffer flags, so cancel is seen inside a running search; pause takes effect between moves).
- `runTournament(options)` is the repeatable league: same entries, seeds, versions and node budgets give an identical `resultsChecksum`.
- `src/sim.ts` is a fast exponent-space simulator used only inside search; tests cross-check it against `@2048/engine.slide`.
