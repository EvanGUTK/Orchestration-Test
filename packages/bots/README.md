# packages/bots

Competition owns four deterministic bounded bot strategies and worker search. Never call a cloud service or peek at future RNG.

Shared requirements: [architecture](../../docs/ARCHITECTURE.md).

## Server integration contract (COMP-004, COMP-005)

Entry points: `@g2048/bots` (pure, browser-safe) and `@g2048/bots/runner` (Node only, `worker_threads`).
Bot version: `BOT_VERSION` (`bots-1.1.0`). Record it, the `BotConfig`, the difficulty (`difficultyOf`), and
the bot seed with every bot run, bot seat, and league result.

### One factory, one worker pool

Call this once at server startup and keep the result for the process lifetime:

```ts
import { createBotServices } from "@g2048/bots/runner";
const bots = createBotServices(); // { pool, runner, seats, shutdown }
// on shutdown: await bots.shutdown();
```

- `bots.pool` is the only `BotWorkerPool` in the process. It has `LIMITS.concurrentBotRunsMax` (8)
  `worker_threads` in total. Every bot search (bot-lab runs and duel bot seats) runs there and never on
  the API event loop.
- Fairness: duel seats submit `"seat"` jobs and bot-lab runs submit `"lab"` jobs. Seat jobs are always
  dispatched first. Lab jobs may occupy at most `size - reservedSeatSlots` workers (default 8 - 2 = 6),
  so at least 2 workers stay free of lab searches and an interactive seat never waits behind bot-lab work.
  FIFO within each priority; each queue is bounded (`RUNNER_BUSY`).
- `bots.pool.stats()` gives `{ size, reservedSeatSlots, workers, busySeat, busyLab, queuedSeat, queuedLab }`
  for `/health` or metrics.
- Do not construct `BotRunner`/`BotSeatDriver` without `pool` in the server: without it each creates a
  private pool (for tests and tools only), which would exceed the process-wide thread limit.

### Bot seats in matches (`human-bot`, `bot-bot`)

Each bot seat owns its own game (`newGame(duel-v1, match seed)`) and its own bot RNG
`deriveBotRng(engineAdapter, botSeed)` (persist the returned `RandomState` after every move). The server
uses `bots.seats` (a `BotSeatDriver` on the shared pool) and, for each bot seat that may act:

1. Load the current `MatchState` (competition reducer), the seat's `GameState`, the ruleset, the seat's
   `BotConfig`, and the seat's bot `RandomState`.
2. `const action = await bots.seats.decide({ match, seat, game, rules, config, botRng }, { signal })`.
   `planBotSeat` runs first on the caller's thread (no search); only real decisions go to a worker.
3. Act on `action.kind` in one database transaction:
   - `"move"`: submit `action.direction` through the same authoritative move command path as a human
     (idempotent command ID, expected revision), store `action.rng` as the seat's bot RNG, and record
     `action.decision` (direction, explanation, nodesSearched, fallback) for the bot lab/replay.
     Then apply `seat-progress` to the match if you track progress.
   - `"terminal"`: apply `action.command` (a `seat-terminal` `MatchCommand`) to the match reducer once.
     When the event says `readyToFinish`, apply `{ type: "finish" }` **without ratings**: bot matches never
     touch human Elo (`RATINGS_FORBIDDEN` otherwise).
   - `"idle"`: nothing to do (match not active, or this seat already ended).
4. Schedule the next decision for that seat (for example on `setImmediate` or after the WebSocket
   broadcast). Never `await` a bot decision inside a human's request handler.

Guarantees and rules:

- Searches run in the shared pool as `"seat"` jobs; the API event loop only plans and applies moves, so a
  slow bot cannot delay a human seat, another match, or `/health` (OPS-06).
- One decision per seat key `matchId:seat` at a time (`DUPLICATE_RUN`); the wait queue is bounded
  (`RUNNER_BUSY`, map to `DB_BUSY`/503-style busy responses).
- `bots.seats.cancel("matchId:seat")` or aborting the `AbortSignal` stops the search at its next node and
  rejects with `CANCELLED`; a cancelled decision is never applied. Cancel on match finish, server
  shutdown (`bots.shutdown()`), or when the seat's game changes.
- Time budgets use `performance.now` inside the worker; node budgets always apply. On budget exhaustion the
  bot plays its fallback (first legal move), flagged `fallback: true`.
- Bots never forfeit, never time out, and never read `GameState.rng`; an absent human seat keeps the match
  `active` until that human forfeits explicitly.
- After a server restart, rebuild state from the database and call `decide` again; in-flight decisions are
  simply recomputed (decisions are deterministic for a given board, config, and bot RNG under node budgets).

### Bot lab runs

`bots.runner` (a `BotRunner` on the shared pool, `"lab"` priority): `start({ runId, config, seed, rules, maxMoves, startPaused })`
returns a handle with `pause`, `resume`, `step`, `cancel`, and `result`. Use the progress callback for
`bot.progress` WebSocket events and persist `BotRunResult` into `bot_runs`. A cancelled run has
`status: "cancelled"` and is never counted as a result.

### Bot league

`runTournament(engineAdapter, { seeds, pairings })` plays deterministic node-budget games on duel-v1.
`computeBotLeague(leagueGamesFromTournament(result))` (or bot-vs-bot match results mapped to
`BotLeagueGame`) gives the `bot-league` standings. Human-vs-bot results belong on their own board and are
rejected by `computeBotLeague`.

### Human-vs-bot board

`computeHumanVsBotBoard(games)` from `@g2048/competition`: one row per account and opponent bot
(`strategy@botVersion`) with W/D/L and the exact best human score. It is its own scope: never rated, never
part of the bot league.

### OPS-06 stress hook

`stressBots({ games: 4, strategy: "expectimax-v1", budget: { nodeBudget, timeBudgetMs }, durationMs })`
from `@g2048/bots/runner` runs simultaneous hard bots on a private pool and returns raw measurements only:
the `monitorEventLoopDelay` histogram (nanoseconds, percentiles), raw setInterval lag samples (ms), and
per-slot decision latencies, moves, and nodes. Thresholds and pass/fail belong to the performance suite.
