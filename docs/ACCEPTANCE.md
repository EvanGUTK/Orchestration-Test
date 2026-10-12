# Acceptance suite — common to every experiment

These cases define product evidence. The baseline harness checks repository tools;
it does NOT certify an unimplemented game. Quality implements the product suite
independently of each implementation. The human may add held-out cases outside
agent context. Keep public fixtures unchanged.

## Engine and exact values (ENG)

| ID | Scenario | Pass evidence |
| --- | --- | --- |
| ENG-01 | All four directions, empty/full/alternating boards | Correct board and exact score; input unchanged |
| ENG-02 | Triple/quadruple merges and collisions | One merge per tile; public slide vectors pass |
| ENG-03 | No-op then changed move | No-op leaves score/moves/revision/PRNG unchanged; valid move spawns once |
| ENG-04 | Seeded games and serialization | Same seed/moves give identical complete state after reload |
| ENG-05 | High values | Exponents 54, 256, 4096 and score >2^53 survive engine/JSON/SQLite/UI |
| ENG-06 | Reach 2048 then continue | One celebration; game remains active if legal moves exist |
| ENG-07 | Game-over detection | Full unequal board dead; full mergeable board active |
| ENG-08 | Property/fuzz checks | Mass conservation before spawn; score delta equals merged values; transpose/rotation consistency |
| ENG-09 | Malformed state/resource pressure | Typed rejection, no mutation/truncation or corrupted save |
| ENG-10 | PRNG golden vectors | Independent reviewer verifies xoshiro output/seed mapping/draw order |

## Accounts, persistence, and authority (ACC / DB)

| ID | Scenario | Pass evidence |
| --- | --- | --- |
| ACC-01 | Create/log in/out/change password | Local only; hash, salt, revoked sessions; old credentials fail after change |
| ACC-02 | Username normalization | Duplicate case variants rejected; input limits; text-safe display names |
| ACC-03 | Two accounts and guest | Other user's saves/seat/results inaccessible; guest never human ranked |
| ACC-04 | CSRF/Origin/Host and rate limits | Mutating foreign-origin requests/socket upgrades rejected; bounded login attempts |
| ACC-05 | Export/delete profile | No credential leaks; private data deleted; history anonymized/replays valid |
| DB-01 | Fresh migration, repeated boot, upgrade | Schema/data intact; migration checksum tracked; upgrade failure recoverable |
| DB-02 | Mid-move process termination | Recovery exposes entire previous/next transaction, no partial score/event |
| DB-03 | Duplicate command ID | Identical result, one move; different payload gives conflict |
| DB-04 | Two stale clients | One accepted command; other conflict; no double spawn/rating |
| DB-05 | Backup then validated restore | Full state recovered, WAL-safe backup; corrupt import leaves active data intact |
| DB-06 | Database busy/disk full | Bounded queue/error, no corrupt state or hidden lost move |
| DB-07 | Restart in-progress duel | Seat state resumes; no extra rating event or false win |
| DB-08 | Huge leaderboard values | Decimal length/lexical ordering; never REAL-cast/float sorting |

## Gameplay, UI, ranked, and bots (UI / SOLO / RANK / BOT)

| ID | Scenario | Pass evidence |
| --- | --- | --- |
| UI-01 | 320px/mobile/tablet/desktop | Playable without horizontal overflow; usable touch targets |
| UI-02 | Keyboard-only run | Mode/account/game/settings/replay reachable; visible focus; board-focused key handling |
| UI-03 | Screen reader/reduced motion/contrast | Meaningful board/score announcements; no color-only values; motion respects setting |
| UI-04 | Rapid mixed input and animation | Accepted sequence matches authority; no dropped/doubled/out-of-order moves |
| UI-05 | Loading/empty/error/reconnect states | Specific recovery actions; no fake rankings or lost game |
| SOLO-01 | New guest/account game; save/resume | Correct initial state and durable progress |
| SOLO-02 | Custom sizes/seed/settings | 3×3 through 8×8; invalid sizes rejected; custom results casual |
| SOLO-03 | Casual undo | Restores score/board/PRNG; history limit; replay remains coherent |
| RANK-01 | Official challenge then retry | One official attempt/account/challenge; interrupted resume; forfeit consumes attempt |
| RANK-02 | Ranked undo / custom rule request | Rejected; official rules/move cap enforced by server |
| RANK-03 | Mode/season/ruleset boards | Human/bot/casual results separated and stable pagination |
| RANK-04 | Client posts forged final score | Server replays/derives result; claimed score not trusted |
| BOT-01 | Four strategies | Legal deterministic move choices; correct difficulty/version metadata |
| BOT-02 | Search budget/cancel/pause/step | Bounded workers; responsive UI/API; legal fallback |
| BOT-03 | Information boundary | Bot cannot read future spawn stream; independent bot randomness |
| BOT-04 | Repeatable bot league | Same seeds/versions/budgets reproduce outcomes; human Elo unchanged |

## Duels, ratings, and replay (DUEL / REP)

| ID | Scenario | Pass evidence |
| --- | --- | --- |
| DUEL-01 | Two local accounts/browser profiles | Lobby creation/join, seat authority, same seed/rules, split-board display |
| DUEL-02 | Dead seat and continuing seat | Other seat keeps remaining moves; match finalizes after both terminal |
| DUEL-03 | Win/draw/forfeit | Deterministic outcome including double forfeits and exact high scores |
| DUEL-04 | Duplicate finish/restart/concurrent finish | Exactly one rating change/account/match, conserved integer Elo delta |
| DUEL-05 | Human vs bot / bot vs bot | Distinct ranking scope; bot does not alter human Elo |
| DUEL-06 | Browser disconnect/reconnect | Snapshot + sequence catch-up; no duplicate input or timeout win |
| REP-01 | Full replay and snapshot seek | Every checksum/final state matches original; step and pause controls |
| REP-02 | Import/export | Versions validated, exact numbers preserved, no account/session secrets |
| REP-03 | Oversize/corrupt/unknown replay | Actionable rejection before data is installed |

## Offline, stress, and fault cases (OPS)

Targets are reference thresholds, not invented measurements. Record hardware,
versions, sample counts, warmup, dataset, and percentile calculation. A run may
miss a target and earn partial performance credit; correctness cannot be traded
away. Performance tests run against the integrated chief build.

| ID | Workload | Target / correctness gate |
| --- | --- | --- |
| OPS-01 | Production build with internet disconnected | All account/game/ranking/bot/replay/asset operations work on loopback |
| OPS-02 | 100,000 pure 4×4 transitions | Reproducible throughput; p95 <2ms/move on recorded reference host |
| OPS-03 | 32 concurrent synthetic local games, 10,000 accepted commands | p95 <100ms authoritative response; no loss/duplicates/deadlock |
| OPS-04 | 100,000 leaderboard entries with high decimal scores | p95 first/filter page <200ms; exact stable sort and bounded memory |
| OPS-05 | 100,000-event replay/history | p95 seek <250ms using snapshots; no full-history DOM/render explosion |
| OPS-06 | Four simultaneous hard bots plus interactive game | Input remains responsive; budgets/cancel honored; no future-RNG access |
| OPS-07 | One-hour replay/bot soak after warmup | Report RSS baseline/end/peak; <25% sustained growth after equivalent workload |
| OPS-08 | Kill server during game and rating transaction | Atomic recoverable state; one rating event; integrity check passes |
| OPS-09 | Slow consumer + malformed socket/request flood | Bounded queues/body sizes/timeouts and health remains responsive |
| OPS-10 | Disk-full/restore/migration failure injection | Preserved last valid state and documented human recovery |

The 32 games are a synthetic capacity test, not an extra public networking mode.
Use isolated accounts/database copies for load tests. Avoid corrupting real saves.

## Mandatory finish gates

The clean checkout installs, builds, starts, and runs its declared checks.
Every mandatory product feature above has evidence. No secret data is committed.
No runtime internet dependency exists. Every checked result names the final SHA.
The evaluator verifies the baseline main SHA stayed unchanged and no cross-tool
implementation/context was copied. Missing features receive zero relevant points;
disqualifying isolation failures invalidate the result, even if the game is polished.
