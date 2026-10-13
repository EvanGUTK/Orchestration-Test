# apps/server

Backend owns this workspace. Implement local HTTP/WebSocket services, authority, and accounts. Bind to loopback and wire shared domain/database packages.

Shared requirements: [architecture](../../docs/ARCHITECTURE.md).

## Layout (ports/adapters)

- `app.ts` wires adapters: one `DatabaseWriter` (single authoritative writer), `ServiceContext`
  (`db` for reads, `writer` for transactions, `clock`), services, root security hooks, and feature
  route plugins under `/api/v1`. `app.services` exposes the services to later feature plugins
  (games/moves, leaderboards, matches); register them after `installSecurityHooks` so identity,
  Origin and CSRF checks apply automatically.
- `services/` business logic (no HTTP types): `AuthService`, `FailureRateLimiter`.
- `routes/` thin handlers: validate with `@g2048/contracts` schemas (`parseWith`), call a service.
- `http/` error envelope, cookies, logging, security hooks; `security/` Argon2id, tokens, Origin.

## Accounts and sessions (ACC-01..04)

| Endpoint | Notes |
| --- | --- |
| `GET /auth/me` | Current identity + `csrfToken`. Without a session it sets an unregistered `gid` token (no database write); the guest row is created lazily by the first guest-owned action (e.g. `PATCH /profile`, `POST /games`), adopting that token. Never returns hashes/tokens. |
| `POST /auth/register` | `RegisterRequest`; username ASCII-lowercased + `USERNAME_PATTERN`, unique; display name 1-48 code points, no control characters; 10 per client per minute; logs in (201). |
| `POST /auth/login` | Generic 401 on any failure; 5 attempts/username/minute (and 20/client), reserved before the Argon2 check so parallel requests cannot exceed it → 429 `RATE_LIMITED` + `Retry-After`. A login whose verified hash changed meanwhile fails and never writes a rehash. |
| `POST /auth/logout` | Revokes the current session; body `{ "allSessions": true }` clears every session of the account. |
| `POST /auth/password` | Verifies the current password, stores a new hash, revokes all other sessions. |
| `PATCH /profile` | `PatchProfileRequest` (strict allowlist). Guests may set preferences only. |

- Passwords: Argon2id via `crypto.argon2` (m=19456 KiB, t=2, p=1, 16-byte random salt, 32-byte
  tag), stored as `$argon2id$v=19$pv=<params version>,m=..,t=..,p=..$salt$tag`. Successful login
  rehashes when the stored parameter set differs from the current one. Input is NFC-normalized.
- Sessions: 256-bit random tokens; only their SHA-256 is stored; 30-day expiry; revocable.
  Cookies `sid` (account) and `gid` (guest) are `HttpOnly; SameSite=Strict; Path=/`, `Secure` only
  over TLS. A guest token is never accepted as an account session.
- CSRF: `csrfToken = HMAC-SHA256(sessionToken, "g2048/csrf/v1")`. Every POST/PUT/PATCH/DELETE
  needs `x-csrf-token` matching the active session and a same-origin `Origin` (or, when absent, a
  loopback `Host` from the allowed list). Every `/api` request (GETs too) must carry an allowed
  loopback `Host`, and `Sec-Fetch-Site: cross-site | same-site` is rejected → 403.
- Argon2 work is capped at 2 concurrent derivations; the unknown-user dummy hash is built at boot.
  Housekeeping purges expired/revoked sessions and orphaned guests at startup and hourly.
- All responses carry `Content-Security-Policy: default-src 'self'; frame-ancestors 'none';
  base-uri 'none'; object-src 'none'; form-action 'self'` (the built SPA has no inline script/style).
- Errors: `{ error: { code, message, requestId, details? } }`, status from `ERROR_HTTP_STATUS`, no
  stack traces. Logs record method/path/status only and redact cookies, tokens, passwords.
- Owner password reset is local only:
  `node --conditions=source --import tsx apps/server/src/cli.ts reset-password <username>`
  (new password from stdin: exactly one line, trailing CR/LF removed, spaces kept; prompted twice
  without echo on a terminal). It revokes all sessions and refuses while the server holds the
  database or migrations are pending.

## Authoritative games (BACKEND-003)

| Endpoint | Notes |
| --- | --- |
| `POST /games` | `CreateGameRequest`: `classic` (optional seed) or `practice` (`practiceRuleset`, 3x3..8x8). Guests allowed (created lazily); always casual. 201 `GameResponse`. |
| `GET /games` | Caller's resumable (`active`) games, newest activity first, `PageQuery` keyset cursor. |
| `GET /games/:id` | Owner only; any other caller gets 404. |
| `POST /games/:id/moves` | `MoveRequest`. No-op → 200 `changed:false`, `code:"NO_CHANGE"`, nothing but the command recorded. |
| `POST /games/:id/undo` | `RevisionCommandRequest`; only when the ruleset allows undo (classic, practice with `undo:true`), at most `historyLimit` (100) consecutive undos; ranked/duel → 403. |
| `POST /games/:id/forfeit` | Ends an active game exactly once (a repeat with the same `commandId` returns the stored result). |
| `GET /games/:id/events` | `EventsQuery` (`afterRevision`, `limit` ≤ 500): one record per accepted command (`move` / `undo` / `forfeit`) with its post-state checksum. |

- One writer transaction per command: ownership → stored `commandId` (same payload hash → stored
  response; different → 409 `IDEMPOTENCY_CONFLICT`) → `expectedRevision` (409 `REVISION_CONFLICT`,
  `details.currentRevision`) → pure engine transition → `game_commands` + `game_moves` + snapshot +
  `games` row + profile statistics. The client never supplies state or scores.
- Every accepted command increments `revision` (an undo restores board/score/PRNG/`acceptedMoves`
  of the prior state at a new revision; the undone move is kept and marked `undone` so replays of
  the final path exclude it). Snapshots: creation, every `SNAPSHOT_INTERVAL` revisions, every
  undo/forfeit and terminal state. Hence the log after the nearest snapshot is plain moves.
- Restart: before listening, every active game is rebuilt from its nearest snapshot plus the move log
  and compared checksum by checksum (`GameService.verifyIntegrity`); failures are logged, never
  repaired. On demand: `node --conditions=source --import tsx apps/server/src/cli.ts verify-games [id]`.
- A saved state whose checksum does not match is refused (500, logged). Engine `RESOURCE_LIMIT` →
  503 with the game unchanged; writer queue full → 503 `DB_BUSY`.
- Mode policy of the generic routes (SEC-FIX-002 R2-02): commands (`moves`/`undo`/`forfeit`) reach
  only `classic`, `practice` and `ranked`; reads (`GET /games/:id`, `/events`) additionally reach the
  caller's own `bot-exhibition` games (bot-lab results). `duel-*` and `bot-vs-bot` games are 404 on
  every generic route; matches use their own routes (`apps/server/src/matches`). `ranked` is handled
  by **mode-aware delegation**: the same move/forfeit routes apply the ranked ruleset (no undo → 403,
  500-move cap) and the challenge-attempt terminal hook runs in the same transaction.
- `ranked` and `duel-*` responses omit `state.rng` (R2-06); casual modes keep it. Replays of finished
  ranked games are full files.
- Undo is a bounded stack (`games.undo_available`, migration 2): each changed move pushes (capped at
  `historyLimit` = 100, oldest dropped), each undo pops, forfeit clears. Nothing left to undo or the
  cap reached → 400 `VALIDATION_ERROR`; undo not allowed by the mode → 403 (C11).
- At most 25 unfinished classic/practice/ranked games per owner (503 `RESOURCE_LIMIT`). Only the
  newest 100 no-change command rows per game are kept, so retrying an older no-op `commandId`
  re-evaluates it (still a no-op unless the board changed).

### Internal game API (for the matches / realtime / ranked / bot services)

All `*InTransaction` methods run inside the caller's `app.services.ctx.writer.run((tx) => …)` job
(synchronous; never await inside) and take `access: GameAccess = { owner: GameOwnerRef | null;
allowedModes: readonly GameMode[] }`. `owner: null` means the caller already authorized the actor;
a game outside `allowedModes` (or owned by someone else) is `NOT_FOUND`.

```ts
games.createInTransaction(tx, owner: GameOwnerRef | null, spec: { mode; rules: Ruleset; seed: string; id?: string }): GameRecord
games.moveInTransaction(tx, gameId, cmd: { commandId; expectedRevision; direction }, access): MoveResponse
games.undoInTransaction(tx, gameId, cmd: { commandId; expectedRevision }, access): GameResponse
games.forfeitInTransaction(tx, gameId, cmd: { commandId; expectedRevision }, access): GameResponse
games.readInTransaction(db, gameId, access): GameResponse
games.eventsInTransaction(db, gameId, { afterRevision; limit }, access): GameEventsResponse
games.stateAtInTransaction(db, gameId, revision): GameState      // full state incl. rng (server-side only)
games.onTerminal((tx, game: GameRecord, finalState: GameState, reason: "move-cap" | "dead-board" | "forfeit") => void)
```

Post-commit events: `app.services.events` (`EventBus`).
`events.publishAfterCommit({ type: WsEventType, resourceId, sequence, payload })` must be called
inside a writer job and is delivered only after that transaction COMMITs (dropped on rollback);
`events.subscribe(listener) => unsubscribe` is what the realtime hub uses; `events.publishNow(event)`
is for non-database events such as `server.recovering`. GameService publishes `game.updated`
(`sequence` = game revision, payload `{ gameId, kind, revision, status }`) after every create/move/
undo/forfeit. The writer primitive behind it is `writer.afterCommit(callback)`.

## Challenges, leaderboards, replays, bot runs (BACKEND-004)

| Endpoint | Notes |
| --- | --- |
| `GET /challenges` | 200 `Page<ChallengeSummary>` (all seasons' catalog, `myAttempt` for accounts). |
| `POST /challenges/:id/attempts` | Account only (guests/anonymous 403). 201 `GameResponse` + `attempt` when a new official attempt starts, 200 when resuming the in-progress one; completed/forfeited (consumed) or closed → 403. The body is ignored: rules (ranked-v1) and seed come from the catalog. |
| `GET /leaderboards` | `LeaderboardQuery` → `Page<LeaderboardEntry>`; scopes below. |
| `GET /replays/:id` | `ReplayFile` for a game id or an import id (rules below). |
| `POST /replays/import` | ≤ 5 MiB; 201 `{ id, rulesetVersion, moves, finalChecksum, score }`. |
| `POST /bots/runs` | `CreateBotRunRequest` → 201 `BotRunView` (guests allowed). |
| `GET /bots/runs/:id` | `BotRunView` for polling (owner only, C13). |
| `POST /bots/runs/:id/{cancel,pause,resume,step}` | Owner only; on a finished run they return its final view (cancel is idempotent). `step` requires a paused run (400 otherwise). |

- **Seasons/catalog** (C18): first boot creates active seasons `s1` (ranked-v1) and `duel-s1`
  (duel-v1) and the deterministic catalog `ch-s1-1..10` (seed `challenge:s1:n`, 500-move cap) from
  `@g2048/competition`. Other services read seasons; they never create them.
- **Attempts**: `reduceChallengeAttempt` decides start/resume/consumed; the attempt is completed
  (move-cap/dead-board) or forfeited by a GameService terminal listener in the SAME transaction as the
  move/forfeit, from the server's final state (official score = server score, RANK-04).
- **Leaderboards** (all exact: canonical decimal TEXT, `length` then value, never REAL; total order
  score ↓, max exponent ↓, created_at ↑, id ↑; keyset cursors; `rank` is the position in the full
  order, so `account=<id>` returns that account's global rank):
  - `casual`: each human account's best `classic-v1` game (guests, practice, bot games excluded).
    Counts client- and server-seeded games and casual undo, so it is NOT tamper-proof (C19);
  - `challenge`: completed official attempts (`challenge`, `season`, `ruleset` filters optional);
    forfeited attempts consume the attempt but are not ranked;
  - `duel-elo`: `ratings` for the season (default: active duel season) and ruleset (default duel-v1);
  - `bot-league`: `computeBotLeague` over finished bot-vs-bot matches (`displayName` = entrant key,
    `score` = best score); never mixed with human boards.
- **Replay export rule**: the owner may export their own classic/practice/ranked/bot-exhibition game;
  any local user may export a FINISHED ranked or human-duel game (public competitive record);
  ranked/duel games are never exported while active (the file contains the PRNG). The file always
  includes `rules` (C16); `initialState` is the stored revision-0 state; `moves` is the final path
  (accepted, not undone) with canonical revisions 1..n and checksums re-derived by the engine (C12)
  and checked against the saved game. `meta.displayName` is the owning account's display name (null
  for guests); no account id, username, session, or credential data is ever included.
- **Import**: route body limit 5 MiB; unknown `replaySchemaVersion`/`engineVersion` → 400
  `REPLAY_VERSION_UNSUPPORTED`; anything else (malformed JSON, oversize, missing fields, rules that
  differ from the official ruleset, failed `verifyReplay`) → 400 `IMPORT_INVALID` with `atMove` when
  known. Verified files are stored in `replay_imports` (migration 3), owner-only, never a game and
  never ranked.
- **Bot runs**: one `createBotServices()` per process (worker_threads pool; shut down on close).
  `bot_runs` records strategy, bot version, config, node/time budgets, seed, status, moves and metrics.
  A finished bot-v1 run (≤ 5 000 moves) is re-applied through the authoritative transition into a
  `bot-exhibition` game owned by the requester (`gameId`; readable via `GET /games/:id`, never
  commandable, never on human boards or profile stats). A run is reported terminal only after its
  result is persisted. Runs in flight at a crash are marked `cancelled` (`metrics.interruptedByRestart`)
  at the next start, never counted as results. `bot.progress` / `bot.finished` events go to the bus.

## Durability and timeouts (BACKEND-FIX-003)

- SQLite runs in WAL mode with `PRAGMA synchronous = NORMAL` by default. Every acknowledged command
  is committed atomically and survives **process termination** (kill, crash, `Ctrl+C`): the WAL is
  replayed on the next open and the database is never left partially written (DB-02). The window:
  an **operating-system crash or power loss** may drop the most recently committed transactions
  (those not yet checkpointed/fsynced), rolling the game back to an earlier consistent state; it
  never corrupts or half-applies a move. Set `DB_SYNCHRONOUS=FULL` to fsync every commit and close
  that window, at the cost of slower writes (OPS-03).
- HTTP timeouts (OPS-09): headers must arrive within 10 s, a whole request within 30 s, idle
  keep-alive sockets close after 5 s and idle sockets after 120 s; Node enforces them every 1 s.
- Logging: routine requests are logged at `debug` (one line each, method/path/status/ms); 5xx and
  requests slower than 1 s at `warn`. Per-request info lines cost more than the request itself on
  Windows, where stdout pipes are synchronous (OPS-03 p95 210 ms → ~50 ms). `LOG_LEVEL=debug` restores
  the full request log.
- Restore over a corrupt live database (OPS-10): the unreadable file and its `-wal`/`-shm` are moved
  aside byte-for-byte as `<db>.pre-restore-<stamp>` and the validated backup is installed.

## Local-only threat model (security gate 1 notes)

The product binds to loopback and has no remote users. Anyone with OS access to the data directory
can read or edit the database (PROJECT_SCOPE: rankings are not tamper-proof against the machine
owner). Within that model:

- **L2 shared client bucket / targeted lockout.** Every local client is `127.0.0.1`, so the per-client
  login bucket (20/min) is shared by all local browsers, and anyone who can reach the port can lock an
  account for one window (5 failures/min) by guessing wrong. This is accepted: the lockout is short,
  the owner can always reset the password via the CLI, and there is no remote attacker.
- **L5 advisory lock.** `<db>.lock` holds the server PID. A lock whose PID is no longer alive is
  treated as stale; if the OS reuses that PID for an unrelated process, restore/reset refuse until
  the lock file is removed by hand (with the server stopped). Two processes starting in the same
  instant are serialized by the exclusive (`wx`) file creation.
- **L7 file modes.** Database, backups, and lock files are created with the process umask (POSIX)
  or the user profile ACL (Windows). Keep `DATA_DIR` inside the user's home (default
  `~/.2048-infinite`) or `chmod 700` it; the files contain password hashes and session hashes, never
  plaintext passwords or raw tokens.
- Cookies are not port-isolated: another web app on `localhost` could set a `gid` cookie. Pending
  guest tokens are `<random>.<HMAC(per-process secret)>`, so only tokens this server minted are ever
  adopted as a guest session (SEC-R2-03); a tossed value is ignored and replaced. A restart
  invalidates unadopted pending tokens (the client just calls `GET /auth/me` again).
- Every request (API, static files, 404s) must carry an allowed loopback `Host`, and
  `Sec-Fetch-Site: cross-site | same-site` is refused except for a top-level navigation to a UI page.
  API-ness is decided by the matched route (decoded path), never the raw URL (SEC-R2-01).
- Retention: expired/revoked sessions are deleted at startup and hourly; a guest with no remaining
  session whose games were all last touched more than 30 days ago is deleted with its games; at most
  10 000 guest profiles exist (503 `RESOURCE_LIMIT` beyond that; create an account).
