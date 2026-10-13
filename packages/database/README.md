# packages/database

Backend owns SQLite migrations/repositories/backup/restore. Exact values remain decimal text. Use transactional moves and exactly-once rating events.

Shared requirements: [architecture](../../docs/ARCHITECTURE.md).

## Schema (migration 1)

Every table in the architecture "Database model" is created as a `STRICT` table (no `REAL`
columns anywhere). Scores and tile exponents are canonical decimal `TEXT` enforced by `GLOB` +
length `CHECK`s; timestamps are ISO-8601 UTC text. Additions beyond the model table, all needed by
the local identity rules: a `guests` table (separate guest identity and preferences),
`sessions.kind` (`account` | `guest`), `games.owner_guest_id`, and `games.rules_json`
(effective rules, required for parameterized `practice-v1`). Ranking contamination guards:
ranked/human-duel games need a human owner and can never be guest-owned; challenge attempts
must reference `ranked` games; seat identity is account XOR bot and must fit the match kind;
`rating_events` are append-only and only for `human-human` matches; `rulesets` are immutable.

Rulesets are seeded from `RULESETS` (+ the `practice-v1` template) as canonical JSON with a
SHA-256 digest on every boot; a stored ruleset whose digest differs fails startup.

Decimal ordering: `decimalOrderBy("score")` → `length(score) DESC, score DESC`. Never `CAST`.

## Later migrations

- 2: `games.undo_available` (bounded undo stack), `game_commands_outcome` index.
- 3: `replay_imports` (verified, never-ranked imported replays) and the `games_casual_best` index.
- 4: `match_events` (per-match event log; `matches.sequence` = max sequence, same transaction) and
  `match_seats.bot_rng_json` (requested by the competition lane for BACKEND-005).
- 5: `match_events` append-only triggers (no UPDATE; DELETE only via the parent match's cascade).

## Writer

`DatabaseWriter` is the single authoritative writer: FIFO, one `BEGIN IMMEDIATE` transaction per
job, synchronous work only (no awaits inside a transaction), bounded by `LIMITS.dbWriterQueueMax`.
A full queue or `SQLITE_BUSY` after the busy timeout raises `DbBusyError` (`DB_BUSY`, HTTP 503).

## Boot, backup, restore rules

- Boot (`prepareDatabase`): refuse unknown (newer) migration versions and checksum mismatches;
  when an existing database has pending migrations, write
  `<db>.pre-migrate-v<from>-to-v<to>-<stamp>` through the backup API first; each migration runs
  in its own transaction, so a failed upgrade leaves the previous schema and data intact.
- The server holds `<db>.lock` (its PID) while running.
- `npm run db:backup [-- <dest>]` uses the SQLite online backup API (WAL-safe; safe while the
  server runs), writes to a temporary name, normalizes to a single self-contained file, verifies
  `integrity_check`, then renames into place.
- `npm run db:restore -- <backup>` is an **offline** operation: it refuses while a live process
  holds `<db>.lock` (stop the server first; a lock left by a dead PID is ignored). It copies the
  input to a staging file and validates `integrity_check`, `foreign_key_check`, and that every
  `schema_migrations` version is known to this build with a matching checksum. Corrupt or foreign
  input is rejected and the active database is not touched. On success the current database is
  checkpointed and saved as `<db>.pre-restore-<stamp>`, then the staged file is renamed over it.
  An older backup's pending migrations apply on the next start / `db:migrate`.
- To undo a restore or a failed upgrade: stop the server, then
  `npm run db:restore -- <db>.pre-restore-<stamp>` (or the `.pre-migrate-…` file).
