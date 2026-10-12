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
- `startTournament(options)` runs a league in a worker thread (`src/tournament-worker.ts`) with per-game progress and cancellation
  that is observed inside the running search; `done` resolves with `finished`, `cancelled` (partial result) or `error`.

## Number safety of `sim.ts`

Search uses exponents as `Int32Array` cells (`Number`), never tile values or scores. Every board enters through `toGrid`, which rejects any
exponent above `MAX_SIM_EXPONENT = 10^7 - 1` (the engine's stored-cell cap) with `RESOURCE_LIMIT`. A search adds at most 1 per merge and
at most `2 * maxDepth = 16` plies, so cells never exceed `MAX_SIM_EXPONENT + 64 < 2^31 - 1`, far below 2^53. Real games stay at or below
1,000,000 (the engine refuses larger merges). Exact scores for greedy come from `BigInt` of the merged exponents.
`test/sim-limits.test.ts` checks the bound, the guard on every entry point, and `sim.slide` against `engine.slide` with exponents up to 999,999.

## Information boundary (BOT-03)

`chooseMove(board, config, options)` has no parameter that can carry game state. `test/boundary.test.ts` checks (a) statically that the decision
modules import only `createRng`, `deriveSeedWords`, `legalMoves` from the engine and never mention `GameState`, `RandomState`, `applyMove`,
`newGame`, `.rng` fields, `Math.random` or `Date`, and that every source file is classified; (b) dynamically that for the same board, twelve
different game PRNG states (which really do produce different spawns) give identical decisions for all four strategies.

## Strength benchmark

`node packages/bots/test/benchmark.ts [--games N] [--max-moves M] [--node-budget B] [--concurrency C] [--json]` (not run by vitest).
Official `duel-v1` rules (4x4, 500 accepted-move cap), node budgets only (time budget ignored), game seeds `bench-game-0..N-1`, bot seed `bench-bot`,
each game in a worker thread. Observed on Apple M4, Node v24.21.0, bots-1.0.0, `--games 20 --node-budget 20000`; the whole run was repeated and gave the
identical `resultsChecksum c9f95d5183e1739ca0f7104bdfcff97ff8b92f3bbc8fc3d178a001c9dd3ee879` (ms/move varies by run and machine and is excluded from the checksum).

| strategy | games | mean score | median | min | max | mean moves | hit move cap | nodes/move | ms/move |
| --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: |
| random | 20 | 999.4 | 1184 | 140 | 1924 | 110.5 | 0/20 | 3.5 | 0.48 |
| greedy | 20 | 2235.6 | 2368 | 1388 | 3220 | 194.8 | 0/20 | 3.5 | 0.39 |
| heuristic | 20 | 7858.8 | 7496 | 5148 | 9348 | 492.4 | 19/20 | 4379.2 | 3.04 |
| expectimax | 20 | 8102.6 | 7692 | 7248 | 9256 | 500.0 | 20/20 | 19877.0 | 16.56 |

Max tile reached, games per tile:

| strategy | 16 | 32 | 64 | 128 | 256 | 512 | 1024 |
| --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: |
| random | 3 | 3 | 1 | 13 | | | |
| greedy | | | | 6 | 14 | | |
| heuristic | | | | | | 14 | 6 |
| expectimax | | | | | | 13 | 7 |

Reading it honestly: the 500-move cap ends almost every search-bot game while the board is still alive, so scores are capped by game length
and heuristic and expectimax are close under these rules. Random and greedy lose by dying early. With 2000 nodes and 3 games the same script gave
expectimax 7441 vs heuristic 6624 (smaller sample, different budget).
