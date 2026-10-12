# Frozen public contracts, v1

These are design contracts to implement at M0. This file and public fixtures are
the shared benchmark oracle, not generated output from one competitor.

## Exact data

```ts
type Decimal = string; // canonical nonnegative base-10 integer; /^0$|^[1-9][0-9]*$/
type Exponent = string; // positive Decimal; actual tile value is 2 ** exponent
type Cell = Exponent | null; // null is empty; "1" means 2, "2" means 4
type Direction = "up" | "right" | "down" | "left";
type Board = { size: number; cells: readonly Cell[] }; // row-major, length=size²
type RandomState = { algorithm: "xoshiro128ss-v1"; words: [number, number, number, number] };
type GameState = {
  schemaVersion: 1; engineVersion: string; rulesetVersion: string;
  board: Board; score: Decimal; acceptedMoves: number; revision: number;
  rng: RandomState; status: "active" | "completed" | "forfeited";
  celebrated2048: boolean;
};
type MoveCommand = { commandId: string; expectedRevision: number; direction: Direction };
type MoveResult = { state: GameState; changed: boolean; scoreDelta: Decimal; events: DomainEvent[] };
```

Exponent and score arithmetic uses BigInt internally; JSON and SQLite use decimal
strings. Never feed their values into Number, bitwise 32-bit shifts, parseInt,
SQLite REAL, or approximate browser formatting. Turn/resource counters are
bounded safe integers with validated operational limits, separate from tile values.
Resource guards check allocations before computing huge powers; they preserve
the current game on `RESOURCE_LIMIT` and do not declare a winning cap.

## Engine API

`newGame(rules, seed)` creates two tiles and returns the full state.
`slide(board, direction)` compresses/merges without randomness and returns board,
merge/motion events, changed, and exact score delta.
`applyMove(state, direction, rules)` returns a fresh state and, on a changed
move, exactly one spawn. `legalMoves(board)` has stable ordering
`up,right,down,left`. `isGameOver(board)` and `serialize/deserialize(state)`
validate versions and preserve values. `replay(initial, moves)` validates the
same transition sequence. No function mutates its inputs.

Event order is all slide motions in destination row-major order, then merges in
destination row-major order, one spawn, newly reached milestones ascending, then
game-over if any. Include source/destination cell indexes for animation/review.

### Deterministic random protocol

PRNG is xoshiro128** over four uint32 words; algorithm ID `xoshiro128ss-v1`.
Zero state is invalid. Freeze verified PRNG golden vectors at M0 and have quality
review them before anyone implements dependent systems. Seed derivation is
SHA-256 of UTF-8 `2048-infinite/v1:<seed>`, first 16 bytes decoded as four
little-endian uint32s; substitute `[1,0,0,0]` only if all four are zero.

For each spawn: list empty cell indexes in row-major order; select the position
using unbiased rejection sampling of uint32 draws into `[0, emptyCount)`;
then select a value using unbiased integer sampling into `[0,10)` (0 means 4,
1–9 mean 2). Initial tiles follow the same protocol twice. A no-op consumes
zero draws. Use unsigned operations with specified wraparound. Save all words
after each move. Bot randomness comes from a different derived seed namespace.

## HTTP

Base `/api/v1`. JSON errors have `{ error: { code, message, requestId, details? } }`.
Exclude stack traces and private state from public responses. Prefer typed codes
`VALIDATION_ERROR`, `UNAUTHENTICATED`, `FORBIDDEN`, `NOT_FOUND`, `REVISION_CONFLICT`,
`IDEMPOTENCY_CONFLICT`, `NO_CHANGE`, `RATE_LIMITED`, `DB_BUSY`, `RESOURCE_LIMIT`,
`REPLAY_VERSION_UNSUPPORTED`, `IMPORT_INVALID`, and `INTERNAL_ERROR`.

| Verb/path | Request / behavior |
| --- | --- |
| GET `/health` | Liveness, no secrets |
| GET `/ready` | Migration/database readiness |
| POST `/auth/register` | Username, displayName, password; local user |
| POST `/auth/login` | Username/password; secure local session |
| POST `/auth/logout` | Revoke current session |
| GET `/auth/me` | Current identity, no hash/token |
| PATCH `/profile` | Allowlisted preferences/displayName |
| POST `/auth/password` | Verify old password, set new, revoke other sessions |
| DELETE `/profile` | Reauthenticate, anonymize retained competitive records |
| POST `/games` | Mode/ruleset; custom settings allowed only in practice |
| GET `/games` | Owned resumable games, cursor pagination |
| GET `/games/:id` | Authorized state and revision |
| POST `/games/:id/moves` | MoveCommand; authoritative transition |
| POST `/games/:id/undo` | Casual only; expected revision/idempotency |
| POST `/games/:id/forfeit` | End own game/seat exactly once |
| GET `/games/:id/events` | Events after cursor/revision, bounded page size |
| GET `/leaderboards` | Mode/ruleset/season/challenge filters + stable pagination |
| GET `/challenges` | Local challenge catalog |
| POST `/challenges/:id/attempts` | Official attempt or resume existing one |
| POST `/matches` | Ruleset/opponent kind, create lobby |
| POST `/matches/:id/join` | Different authorized account, no occupied seat |
| GET `/matches/:id` | Authorized seat states/status/outcome |
| POST `/bots/runs` | Validated strategy/config/budget; cancellable job |
| POST `/bots/runs/:id/cancel` | Idempotent stop |
| GET `/replays/:id` | Versioned replay, redacted account metadata |
| POST `/replays/import` | Size-limited validated data, never ranked |
| GET `/profile/export` | Own data, excludes credential/session material |

Backup/restore are local owner CLI operations at M0; do not expose unauthenticated
filesystem paths through HTTP. Guest games use a separate signed/opaque guest
session and cannot access account games or rankings as a human identity.

Expected statuses: 400 validation/import, 401 auth, 403 ownership/mode,
404 missing/inaccessible resource, 409 stale revision/idempotency conflict,
429 rate limit, 503 database/resource pressure. A valid no-op can return 200
with `changed:false`; do not turn it into an accepted/ranked move.

## WebSocket

Endpoint `/api/v1/events` authenticates the browser session and Origin before
upgrade. Client subscribes to owned/authorized game/match IDs, with last sequence.
Envelope `{ protocolVersion:1, type, resourceId, sequence, payload }`.
Events: `game.updated`, `match.seat-ended`, `match.finished`, `rating.updated`,
`bot.progress`, `bot.finished`, `server.recovering`. Duplicate/out-of-order events
do not regress state. Reconnect fetches authoritative snapshot + missing events.
Heartbeat and bounded backpressure disconnect slow consumers explicitly.

## Canonical replay checksums

SHA-256 over UTF-8 canonical JSON with fixed key order, row-major cells, decimal
strings as strings, no whitespace, and uint32 PRNG words as numbers. The chief
freezes the exact key order/schema and golden examples at M0. Hash state includes
board, score, PRNG, counters, status, ruleset/engine version; no display preference,
wall clock, username, or animation progress. Record versioned checksums per move.
Quality must independently verify canonical serialization and PRNG vectors.

## Integration handshake

At M0 chief sends `CONTRACT-001` to all workers with reviewed types, error codes,
PRNG/golden vectors, schema version, and ownership list. Every worker acknowledges
that version. A breaking contract change blocks dependent tasks until chief
publishes a reviewed replacement. No worker silently edits public contracts.
