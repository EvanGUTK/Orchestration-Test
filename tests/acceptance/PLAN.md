# Acceptance plan — QUALITY-001 (conductor r1)

Maps every ID in `docs/ACCEPTANCE.md` to a concrete test file and command. Quality owns `tests/acceptance|integration|performance/**`.
Status values: **written+run** (executed here, result observed), **written** (authored, needs the named dependency to run),
**planned** (file named, not yet written). Nothing here is a pass until a dated run against a named SHA says so.

Commands: `npm run test:integration` (vitest project `integration`), `npm run test:e2e` (Playwright, boots the production
server on `127.0.0.1:$E2E_PORT` (default 5611) with a private temp DB; needs `npm run build` first),
`npm run test:performance` (vitest project `performance`; reports to `$LAB_RUNTIME/perf/*.json`),
`npm test` (unit, owned by each worker). Oracle: `tests/integration/oracle/*` (independent of `@2048/*`).

## Engine and exact values (ENG)

| ID | Test | Command | Status / dependency |
| --- | --- | --- | --- |
| ENG-01 | `tests/integration/engine-oracle.test.ts` (4 dirs x empty/full/alternating, input-unchanged) | `npm run test:integration` | **written+run against @2048/engine (ENGINE-001 e4f8c64): pass** |
| ENG-02 | same file + public `tests/fixtures/slide-v1.json` (oracle already passes all vectors in `golden-review.test.ts`) | same | **written+run, engine passes** |
| ENG-03 | `golden-review.test.ts` (no-op steps) + `engine-oracle.test.ts` + `api-authority.test.ts` (no-op through HTTP) | same | **engine written+run, passes**; HTTP side needs server |
| ENG-04 | `engine-oracle.test.ts` (seed + moves -> identical state after serialize/deserialize) + `api-authority.test.ts` | same | engine side **written+run, passes**; HTTP side needs server |
| ENG-05 | `engine-oracle.test.ts` high-value section (exponents 54, 256, 4096; score > 2^53 via constructed boards) + `tests/acceptance/high-values.spec.ts` (UI shows `2^n`) | integration, e2e | engine side **written+run, passes** (exponents 53..4096, score > 2^53); DB/UI side planned |
| ENG-06 | `engine-oracle.test.ts` (board constructed to reach exponent 11; one `milestone`, `celebrated2048` flips once, stays active) | integration | **written+run, passes** |
| ENG-07 | `golden-review.test.ts` spot boards + `engine-oracle.test.ts` randomized dead/alive agreement | integration | **written+run, passes** |
| ENG-08 | `engine-oracle.test.ts` property/fuzz (mass conservation, score delta, transpose/rotation symmetry, differential vs oracle) | integration | **written+run, passes** (4000 slide + 3000 legal-move boards, 8 rulesets x 12 seeds x <=400 moves, rotation/mass properties) |
| ENG-09 | `engine-oracle.test.ts` malformed-state table (bad cells, zero rng, leading zeros, huge exponent -> `DomainError` code, input not mutated) | integration | **written+run, passes** (30 malformed-state cases, resource pressure, bad direction) |
| ENG-10 | `golden-review.test.ts` (oracle reproduces all of `prng-v1.json`, `games-v1.json`) | `npx vitest run --project integration` | **written+run: oracle reproduces all goldens (41 pass); engine PRNG/seed/sha256 differential passes** |

## Accounts, persistence, authority (ACC / DB)

| ID | Test | Status / dependency |
| --- | --- | --- |
| ACC-01 | `tests/integration/accounts-security.test.ts` (cookie flags, salted Argon2id, token never stored raw, logout revokes replayed cookie, password change revokes other sessions incl. DB, no user enumeration) + `api-contract.spec.ts` | **written+run against real server: pass** |
| ACC-02 | `accounts-security.test.ts` (case/whitespace/fullwidth duplicates, 12 invalid-input cases, unicode names) + `api-contract.spec.ts` | **written+run against real server: pass** |
| ACC-03 | `accounts-security.test.ts` (user B and guest get 404 on get/events/moves/undo/forfeit/list of A's game; foreign vs nonexistent indistinguishable; guest limits; guest cannot create ranked/duel) ; guest absent from human boards needs `/leaderboards` | **written+run: pass**; leaderboard part blocked (route missing) |
| ACC-04 | `accounts-security.test.ts` (CSRF missing/wrong/other-user token, foreign/null/https Origin, cross-site fetch metadata, Host spoof, no CORS, per-account login limit 429+Retry-After, oversize/malformed/wrong-content-type bodies, headers) + `api-contract.spec.ts` (loopback-only bind); WebSocket upgrade Origin planned | **written+run: pass** (HTTP); WS planned |
| ACC-05 | `accounts-security.test.ts` (delete needs password; delete removes hash/username/display name from every table, revokes sessions, blocks login; export has no credential material) | delete **pass**; **export FAILS: `GET /profile/export` is 404 (repro filed)** |
| DB-01 | `tests/integration/database.test.ts` (CLI migrate fresh/idempotent/checksums/integrity/FK; 3 repeated server boots keep data and migration history byte-identical; tampered checksum refuses boot and leaves data untouched; newer-schema DB refused) | **written+run: pass**; upgrade-from-old-version path untestable until migration 0002 exists |
| DB-02 | `tests/integration/fault-kill-during-move.test.ts` (SIGKILL during in-flight burst, restart on same DB, oracle replay equals recovered state, acked moves durable, `integrity_check`) | written; needs server |
| DB-03 | `tests/integration/api-authority.test.ts` (duplicate commandId identical; different payload `IDEMPOTENCY_CONFLICT`) | written; needs server |
| DB-04 | `api-authority.test.ts` (two stale clients: one 200, one `REVISION_CONFLICT`, no double spawn) | written; needs server |
| DB-05 | `database.test.ts` (online backup while moves are in flight = consistent prefix verified by oracle replay; restore returns exactly that state and the game keeps working; corrupt/truncated/empty/foreign/missing files refused with active DB byte-identical) | **written+run: pass** |
| DB-06 | `database.test.ts` (second connection holds the write lock: move waits then succeeds or returns DB_BUSY 503 with Retry-After; 120-request flood returns only 200/409/429/503; /health stays up; state equals acknowledged stream) ; disk-full is OPS-10 | **written+run: pass** (observed: single move waited ~1.5 s then 200; flood 1x200, 118x409, 1x503) |
| DB-07 | `tests/integration/duel-restart.test.ts` (kill mid-duel, restart, seat state resumes, rating events count == 1) | planned; needs competition+server |
| DB-08 | `database.test.ts` (schema rejects float-ish/non-canonical decimals; 3000 rows incl. 2^53 neighbours: stored as text, round-trip exact, SQL ranking order == BigInt oracle) + `ops04-leaderboard.perf.ts` (HTTP) | schema part **written+run: pass**; HTTP part blocked (`/leaderboards` missing) |

## Gameplay, UI, ranked, bots

| ID | Test | Status / dependency |
| --- | --- | --- |
| UI-01 | `tests/acceptance/shell-offline-responsive.spec.ts` (320/768/1280 no horizontal overflow, 44px touch / 24px pointer targets) + `gameplay.spec.ts` board at 320 | shell part written (passes against a trivial stand-in page only); needs web |
| UI-02 | `shell-offline-responsive.spec.ts` (Tab reach + visible focus) + `gameplay.spec.ts` (arrow/WASD board focus, menu/settings/replay reachable) | written (shell) / planned; needs web |
| UI-03 | `shell-offline-responsive.spec.ts` (lang, main landmark, reduced-motion) + `a11y.spec.ts` (live-region announcements, no colour-only values, contrast check) | partly written; needs web |
| UI-04 | `gameplay.spec.ts` rapid mixed key/touch input: sequence from `GET /games/:id/events` equals the sequence of accepted inputs, no doubles | planned; needs web+server |
| UI-05 | `states.spec.ts` (server down -> specific recovery action, WS reconnect, empty leaderboard, no fake ranks) | planned; needs web+server |
| SOLO-01 | `api-authority.test.ts` (create, move, re-read) + `gameplay.spec.ts` (guest and account, reload resumes) | API written; UI planned |
| SOLO-02 | `api-authority.test.ts` (sizes 3-8 accepted by oracle parity, 2/9/0/-1/4.5 -> 400) | written; needs server |
| SOLO-03 | `tests/integration/undo.test.ts` (undo restores board/score/PRNG, limit 100, replay stays coherent) | planned; needs server |
| RANK-01 | `competition-bots.test.ts` (attempt policy truth table) + `tests/acceptance/ranked.spec.ts` | policy **written+run, passes**; HTTP/UI planned; needs server |
| RANK-02 | `competition-bots.test.ts` (undo/custom FORBIDDEN, exact official-rules predicate, 500 cap) + `ranked.spec.ts` | policy **written+run, passes**; HTTP planned; needs server |
| RANK-03 | `competition-bots.test.ts` (6000 adversarial standings vs BigInt oracle, ladder order) + `ranked.spec.ts` (boards separated, cursor pagination) | ordering **written+run, passes**; HTTP planned; needs server |
| RANK-04 | `tests/integration/forged-score.test.ts` (client posts claimed score/state -> ignored; import never ranked) | planned; needs server |
| BOT-01 | `tests/integration/competition-bots.test.ts` (four strategies: oracle-legal, deterministic, metadata, config validation, whole BotGame replayed in the oracle) | **package side written+run, passes**; API side (`/bots/runs`) planned; needs server |
| BOT-02 | `competition-bots.test.ts` (aborted signal, node budget bounds, injected clock, 150 ms real-time budget) + `bot.spec.ts` (UI pause/step/cancel) | **package side written+run, passes**; API/UI planned; needs server+web |
| BOT-03 | `competition-bots.test.ts` (bot stream == independently derived BOT-namespace stream, differs from game stream; determinism; entry point takes board only) | **written+run, passes** (black-box limit documented in the test) |
| BOT-04 | `competition-bots.test.ts` (runTournament repeat checksum, exact BigInt table arithmetic; bot matches never produce rating events) | **package side written+run, passes**; API league planned |

## Duels, ratings, replay

| ID | Test | Status / dependency |
| --- | --- | --- |
| DUEL-02..05 | `competition-bots.test.ts` (exhaustive 784-case resolver table with scores > 2^53, dead-seat continuation, duplicate/replayed events idempotent, exactly-once rating, conserved integer Elo, bots never rated, double forfeit) ; DUEL-01/06 and the HTTP/WS side in `tests/integration/duels.test.ts` + `tests/acceptance/duel.spec.ts` | **pure side written+run, passes**; DUEL-01/06 + HTTP planned; needs server+web |
| REP-01 | `tests/integration/replay.test.ts` (every checksum matches the oracle; snapshot seek) | planned; needs server |
| REP-02 | `replay.test.ts` (export/import round trip, exact numbers, no secrets) | planned; needs server |
| REP-03 | `replay.test.ts` (oversize, corrupt, unknown version rejected before install: `IMPORT_INVALID` / `REPLAY_VERSION_UNSUPPORTED`) | planned; needs server |

## Offline, stress, fault (OPS)

| ID | Test | Status / dependency |
| --- | --- | --- |
| OPS-01 | `shell-offline-responsive.spec.ts` (all non-loopback requests aborted and counted; must be 0) + full flows under the same route guard | partly written; needs web |
| OPS-02 | `tests/performance/ops02-engine-throughput.perf.ts` | **written+run against @2048/engine: n=100000, p50 0.0016 ms, p95 0.0019 ms, p99 0.0043 ms (Apple M4, Node 24.21)**; target p95 < 2 ms met |
| OPS-03 | `ops03-concurrent-games.perf.ts` (32 games / 10,016 accepted commands, every response oracle-exact) | **written+run on real server: p50 27.7 ms, p95 65.0 ms, p99 85.2 ms (target p95 < 100 ms met); zero mismatches** |
| OPS-04 | `ops04-leaderboard.perf.ts` + `support/leaderboard-oracle.ts` + `support/seed-leaderboard.ts` | seeder + ordering self-checks **pass**; live part **blocked: `GET /leaderboards` is 404 (repro filed)** |
| OPS-05 | `ops05-replay-seek.perf.ts` (>=100k domain events, 220 seeks) | **blocked: `GET /replays/:id` is 404 (repro filed)** |
| OPS-06 | `tests/performance/ops06-bots-vs-interactive.perf.ts` | planned; needs bots+server |
| OPS-07 | `tests/performance/ops07-soak.perf.ts` (RSS baseline/end/peak, env `OPS07_MINUTES`, default 60) | planned; needs server |
| OPS-08 | game half: `fault-kill-during-move.test.ts` (written); rating half: `tests/integration/fault-rating-finish.test.ts` | partly written; rating half needs competition |
| OPS-09 | `tests/integration/flood.test.ts` (slow WS consumer, malformed requests, oversize bodies; `/health` stays < 500 ms) | planned; needs server |
| OPS-10 | `tests/integration/disk-full-restore.test.ts` (quota-limited tmpfs-like dir or injected failing DB path) | planned; needs database pkg |

## Fault-injection helpers

`tests/acceptance/support/server-process.ts` (`startServer`, `kill('SIGKILL')`, `restart()` on the same DB file),
`tests/acceptance/support/client.ts` (cookie-jar client), `tests/integration/support/game-driver.ts` (oracle-driven game player).
Open points with chief are listed in the QUALITY-001 result message (CSRF header, events query parameters, server port env, seeder).
