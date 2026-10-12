# packages/competition

Competition owns challenge/duel/Elo/season policies. Keep pure logic separate from persistence and HTTP.

Shared requirements: [architecture](../../docs/ARCHITECTURE.md).

## API (COMP-001, CONTRACT-001/v1)

Pure and synchronous; no HTTP, SQL, clocks or randomness.

- `standings.ts`: `compareStanding`, `rankStandings` (score desc via `compareDecimal`, max exponent desc, creation order asc).
- `duel.ts`: `resolveDuel` (pending until both seats terminal; forfeit loses; double forfeit draw; score then max exponent).
- `elo.ts`: Elo `elo-v1` (start 1000, K=24), `applyElo`, `rateMatch` -> two `RatingEvent`s with idempotency keys `elo-v1:<match>:<account>`.
- `match.ts`: `createMatch` / `reduceMatch` state machine, `canRate`, `ratingEventsFor` (bots never rated, once per match via the `rated` event).
- `ranked.ts`: `decideAttempt` (create / resume / reject), `isOfficialRankedRules`, `assertRankedRequestAllowed`.
- `season.ts`: season ids/bounds from explicit instants, ladder ordering, rollover.
