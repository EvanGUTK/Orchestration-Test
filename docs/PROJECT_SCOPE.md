# 2048 Infinite — shared project scope, v1

This is the implementation target for EVERY experiment branch. The baseline
contains requirements, fixtures, and orchestration tools; it contains no finished
game. Each tool must build this product independently from the same starting SHA.

## Product promise

A polished, fast, accessible 2048 game that keeps going after 2048, stores all
accounts and results on the user's machine, and supports solo play, local ranked
challenges, deterministic bots, and local human/bot duels. Installation may fetch
dependencies. Once built and installed, playing the game requires no internet,
external account, cloud database, AI service, analytics, or hosted assets.

"Infinite" means there is no designed winning tile or numeric score ceiling.
It does not mean a finite machine can store unlimited data. Exact large values
must never become floats, overflow, wrap, become Infinity, or silently truncate.
Resource exhaustion must return a recoverable error and preserve the last valid
state. Test tiles through exponent 4096 and scores far above 2^53. Display large
tiles as `2^n` when full decimal rendering stops being useful.

## Modes and rules

| Mode | Board | Undo / restart | Ranking | Opponents |
| --- | --- | --- | --- | --- |
| Classic infinite | 4×4 | Optional, history capped at 100 moves | Casual only | None |
| Custom practice | 3×3 through 8×8 | Yes; explicit seed and spawn options | Never ranked | None |
| Ranked challenge | Fixed 4×4, v1 rules | No undo; abandoning forfeits that attempt | Local challenge leaderboard | None |
| Bot exhibition | 4×4; custom board optional | User controls speed / pause | Bot-only board | Algorithms |
| Human 1v1 | Same-seed 4×4, 500 accepted moves per seat | No undo / pause advantage | Local Elo if two humans | Two local accounts |
| Human vs bot | Same-seed 4×4, 500 accepted moves per seat | Casual; no human Elo | Separate bot result board | One account and bot |
| Bot vs bot | Same-seed 4×4 | Step, run, stop, inspect | Bot league only | Two algorithms |

Ranked challenge ends at 500 accepted moves, a dead board, or forfeit. A 1v1 seat
ends at the same move cap, a dead board, or forfeit. No speed race is used in v1;
ranking rewards decisions rather than typing speed. A session may be resumed
after a browser/server restart. A duel in which a participant is absent remains
pending until explicit forfeit; elapsed wall time alone never awards a win.

For challenge standings, sort score descending, maximum exponent descending,
then attempt creation order ascending. For a duel, compare score, then maximum
exponent; equal results are a draw. A forfeiting seat loses regardless of score;
two forfeits are a draw. One participant's dead board does not stop the other's
remaining moves. Matches are rated only once after both seats are terminal.

## Engine requirements

- Arrow keys and WASD slide tiles in four directions. Compression happens
  before merging; each tile participates in at most one merge per move.
- Equal exponents merge to exponent + 1. Add the exact resulting tile value
  to score. `[2,2,2,2]` moving left becomes `[4,4,empty,empty]`, not `[8,...]`.
- New classic games start with two randomly positioned tiles. After each
  changed move, spawn exactly one tile in an empty cell. 90% are 2, 10% are 4.
- No-op moves do not spawn, add score, increment the accepted move counter,
  or advance PRNG state. They return a typed `NO_CHANGE` response.
- Game over means no empty cell and no adjacent equal exponents. Reaching
  2048 celebrates once and offers "Keep playing" without ending the run.
- Use deterministic, versioned PRNG and serialized PRNG state. Specify cell
  iteration order and random draw order in the engine contract before implementation.
- Pure engine functions do not access browser APIs, clocks, network, database,
  account state, or filesystem. Inputs are immutable; outputs include ordered
  events for movement, merge, spawn, milestones, and game-over.

## Local identity and privacy

Create accounts with username, display name, and password; no email, phone,
OAuth, remote identity, or external verification. Guest play is available but
cannot enter a human ranked ladder. Username normalization is ASCII lowercase,
3–24 characters `[a-z0-9_]`, unique after normalization. Display names are 1–48
Unicode characters, rendered as text. Passwords are 12–128 characters.

Passwords use Argon2id with per-user salt, versioned parameters, and a rehash
path. Store no plaintext or reversible password. Persist sessions as hashes of
random 256-bit tokens, with HttpOnly SameSite=Strict cookies. Local HTTP cookies
may omit Secure only for loopback development; TLS uses Secure. Login failures
have a generic response and a local rate limit. Logout revokes the session.
Support changing passwords and clearing an account's sessions. Password recovery
is an explicit local owner reset; never implement a hidden backdoor.

Separate browser profiles/cookie jars hold different accounts for 1v1. On one
browser profile, hot-seat mode uses explicit seat handoffs with reauthentication
when needed; never imply cookies can hold two independent browser sessions.

Users may export their own profile/results, delete their account, and inspect
the data location. Exports omit passwords and session tokens. Deletion removes
private fields and anonymizes referenced match history without breaking replays.
Local rankings are trusted relative to other normal users of this app; an OS
administrator can edit the database. Do not claim tamper-proof online competition.

## Persistence and durability

SQLite is the only game database. Use versioned migrations, foreign keys, WAL,
busy timeouts, transactional updates, and a single authoritative writer. Store
exact scores as canonical decimal strings and tiles as exponents, never SQLite
REAL. Persist PRNG state, engine/ruleset version, and current sequence number.

Every accepted move, event log update, snapshot update, and related statistic
change commits atomically. Two commands with the same idempotency key return
the same result. Two stale clients cannot apply a move twice. Saving must
survive process termination without partially rated matches or lost scores.
Offer backup/export and a validated restore path; do not copy a live SQLite file
without its WAL. Restore happens with the application stopped or through a
tested SQLite backup API. Corrupted imports do not replace the active database.

## Leaderboards, seasons, ranked play

Provide separate views for casual best score, challenge standings, human duel
Elo, and bot exhibition/league results. Never blend custom/practice/bot scores
into human ranked standings. Filter by ruleset, season, challenge, and account.
Paginate large datasets and implement stable numeric ordering of decimal scores.

Human Elo starts at 1000. Use standard expected score
`1 / (1 + 10^((opponentRating - rating)/400))`, K=24, outcome 1/0.5/0.
Compute one rounded integer delta for seat A and the opposite delta for B, so
the combined rating is conserved. Bots never modify human Elo. Record before,
after, delta, season, ruleset, match ID, and idempotent rating-event key.
Version this algorithm; seasons archive the old ladder and initialize new ratings.

Ranked challenge seeds are owned by the backend, bound to a local challenge ID,
and shared consistently among attempts. One completed official attempt per
account/challenge; interrupted attempts resume, forfeit consumes the attempt.
Practice with the same seed stays casual. Local users can inspect app files,
so seed confidentiality is not a security guarantee. Record the policy honestly.

## Bots

Implement four difficulty levels: random legal move, greedy merge score,
heuristic search, and bounded expectimax. Tie-breaking uses a bot-specific
deterministic stream, never the game's PRNG or future spawn state. Hard bots
see the current board and public rules only; no peeking at the next random tile.

Run search in a worker/thread, with explicit time/node budget, cancellation,
pause/step controls, and safe fallback to a legal move. Record bot version,
parameters, node budget, difficulty, and seed in results. Show its chosen move
and a short explanation. A slow bot cannot stall input, server health, or another
duel seat. No LLM calls are part of game-bot decision making.

## User experience

Required screens: welcome/login/create account, mode picker, solo board, custom
practice settings, save/resume list, challenge list/detail, leaderboards, profile
statistics, duel lobby, split-board duel, bot laboratory, replay browser/player,
settings, data export/backup, and actionable error states.

Use responsive layouts from 320px wide through desktop. Support keyboard-only
play, touch swipes with sensible thresholds, visible focus, labeled controls,
reduced motion, high contrast, and screen-reader score/move announcements that
do not spam every animation frame. Tile colors cannot be the only indication
of value. Prevent page scrolling for game keys only while the board is focused.
Input buffering and animations must not reorder, drop, or double-apply moves.

Settings include theme, sound mute, motion preference, tile display style,
keyboard bindings, and bot speed. Preferences persist per local account or guest.
Bundle fonts, icons, sounds, and scripts; use no CDN or tracking pixel.

## Replay, analytics, and operations

Replays include initial state/seed, accepted moves, engine/ruleset version,
sequence numbers, and checksums. A replay reproduces the exact final state.
Controls support step, seek, playback speed, pause, and explanation of merges.
Reject unsupported replay versions and malformed/import-too-large files.

Show personal bests, score distribution, max tiles, win/draw/loss, ranked history,
and bot statistics. Benchmarks capture latency, memory, throughput, recovery,
and agent coordination evidence. No fake numbers or optimistic empty states.
Structured local logs must redact passwords, cookies, and identity tokens.

## Milestones and task graph

| Milestone | Required outcome | Blocking dependencies |
| --- | --- | --- |
| M0 | Contract review, toolchain, runnable shell app, actual test commands | Baseline read |
| M1 | Pure engine and fixed fixtures; UI board with local guest play | M0 |
| M2 | Migrations, accounts/sessions, authoritative moves, durable saves | M0 + engine contract |
| M3 | Local rankings, challenge rules, replays, bot workers | M1 + M2 |
| M4 | Two-seat lobbies, reconnect, transactional human Elo, bot duels | M2 + M3 |
| M5 | Accessibility, exports, failure recovery, offline build | M1–M4 |
| M6 | Stress suite, fault injection, evidence report and final scoring | M5 |

Parallelize disjoint files after agreeing on contracts. Quality begins writing
independent checks at M0; it is not a last-minute task. Dependency upgrades,
schema changes, and root build files have one writer: the chief.

## Definition of done

All mandatory acceptance cases pass on a clean checkout. The human can install,
build, disconnect from the internet, create two local accounts, play/resume,
run bots, complete a rated local duel, inspect rankings, export/restore data,
and replay the result. The run includes versioned evidence and a scorecard.
Missing features remain visibly incomplete and receive zero rubric points.
