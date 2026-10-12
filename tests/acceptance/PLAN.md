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
| ACC-01 | `tests/acceptance/api-contract.spec.ts` (register/me/logout/login/password change; hash never in responses; other sessions revoked; old credential fails) | written; needs server (harness smoke-tested against a stand-in, not the real server) |
| ACC-02 | `api-contract.spec.ts` (case-variant duplicates, 10k-char username, HTML display name headers) | written; needs server |
| ACC-03 | `tests/acceptance/isolation.spec.ts`: second account and guest cannot GET/POST another user's game, seat, results; guest absent from human boards | planned; needs server |
| ACC-04 | `api-contract.spec.ts` (foreign Origin 403, bounded login attempts -> 429, loopback-only bind); WebSocket foreign-Origin upgrade in `tests/integration/ws.test.ts` | written (HTTP) / planned (WS); needs server |
| ACC-05 | `tests/acceptance/profile-export-delete.spec.ts` (export has no credential/session material; delete anonymizes; replays still verify) | planned; needs server |
| DB-01 | `tests/integration/migrations.test.ts` (fresh boot, repeat boot, tampered checksum surfaces, upgrade-failure recovery) via `npm run db:migrate` | planned; needs database pkg |
| DB-02 | `tests/integration/fault-kill-during-move.test.ts` (SIGKILL during in-flight burst, restart on same DB, oracle replay equals recovered state, acked moves durable, `integrity_check`) | written; needs server |
| DB-03 | `tests/integration/api-authority.test.ts` (duplicate commandId identical; different payload `IDEMPOTENCY_CONFLICT`) | written; needs server |
| DB-04 | `api-authority.test.ts` (two stale clients: one 200, one `REVISION_CONFLICT`, no double spawn) | written; needs server |
| DB-05 | `tests/integration/backup-restore.test.ts` (`db:backup` under write load -> `db:restore` -> state equal; corrupt file leaves active data intact) | planned; needs database pkg CLI |
| DB-06 | `tests/integration/db-busy.test.ts` (hold a write lock from a second connection, expect `DB_BUSY` 503, no lost/phantom move) | planned; needs server |
| DB-07 | `tests/integration/duel-restart.test.ts` (kill mid-duel, restart, seat state resumes, rating events count == 1) | planned; needs competition+server |
| DB-08 | `tests/performance/support/leaderboard-oracle.ts` (self-check written+run) + `ops04-leaderboard.perf.ts` (live) | oracle written+run; live needs seeder |

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
| RANK-01 | `tests/acceptance/ranked.spec.ts` (one attempt/account/challenge, resume, forfeit consumes) | planned; needs server |
| RANK-02 | `ranked.spec.ts` (undo and custom settings rejected 403/400; 500 move cap enforced) | planned; needs server |
| RANK-03 | `ranked.spec.ts` (human/bot/casual boards separate, stable cursor pagination) | planned; needs server |
| RANK-04 | `tests/integration/forged-score.test.ts` (client posts claimed score/state -> ignored; import never ranked) | planned; needs server |
| BOT-01 | `tests/integration/bots.test.ts` (four strategies: legal move, determinism, metadata) | planned; needs bots |
| BOT-02 | `bots.test.ts` + `bot.spec.ts` (budget respected, cancel/pause/step, legal fallback) | planned; needs bots+server |
| BOT-03 | `bots.test.ts` (bot RNG namespace differs; mutate future spawn stream, bot decision unchanged) | planned; needs bots |
| BOT-04 | `bots.test.ts` (league repeat run identical; human Elo unchanged) | planned; needs bots+competition |

## Duels, ratings, replay

| ID | Test | Status / dependency |
| --- | --- | --- |
| DUEL-01..06 | `tests/integration/duels.test.ts` (API with two clients) + `tests/acceptance/duel.spec.ts` (two browser contexts) | planned; needs competition+server+web |
| REP-01 | `tests/integration/replay.test.ts` (every checksum matches the oracle; snapshot seek) | planned; needs server |
| REP-02 | `replay.test.ts` (export/import round trip, exact numbers, no secrets) | planned; needs server |
| REP-03 | `replay.test.ts` (oversize, corrupt, unknown version rejected before install: `IMPORT_INVALID` / `REPLAY_VERSION_UNSUPPORTED`) | planned; needs server |

## Offline, stress, fault (OPS)

| ID | Test | Status / dependency |
| --- | --- | --- |
| OPS-01 | `shell-offline-responsive.spec.ts` (all non-loopback requests aborted and counted; must be 0) + full flows under the same route guard | partly written; needs web |
| OPS-02 | `tests/performance/ops02-engine-throughput.perf.ts` | **written+run against @2048/engine: n=100000, p50 0.0016 ms, p95 0.0019 ms, p99 0.0043 ms (Apple M4, Node 24.21)**; target p95 < 2 ms met |
| OPS-03 | `ops03-concurrent-games.perf.ts` (32 games / 10,000 commands, oracle-exact) | written; harness smoke-tested on a stand-in; needs server |
| OPS-04 | `ops04-leaderboard.perf.ts` + `support/leaderboard-oracle.ts` | oracle written+run; live needs a seeder (question to chief) |
| OPS-05 | `ops05-replay-seek.perf.ts` (>=100k domain events, 220 seeks) | written; needs server |
| OPS-06 | `tests/performance/ops06-bots-vs-interactive.perf.ts` | planned; needs bots+server |
| OPS-07 | `tests/performance/ops07-soak.perf.ts` (RSS baseline/end/peak, env `OPS07_MINUTES`, default 60) | planned; needs server |
| OPS-08 | game half: `fault-kill-during-move.test.ts` (written); rating half: `tests/integration/fault-rating-finish.test.ts` | partly written; rating half needs competition |
| OPS-09 | `tests/integration/flood.test.ts` (slow WS consumer, malformed requests, oversize bodies; `/health` stays < 500 ms) | planned; needs server |
| OPS-10 | `tests/integration/disk-full-restore.test.ts` (quota-limited tmpfs-like dir or injected failing DB path) | planned; needs database pkg |

## Fault-injection helpers

`tests/acceptance/support/server-process.ts` (`startServer`, `kill('SIGKILL')`, `restart()` on the same DB file),
`tests/acceptance/support/client.ts` (cookie-jar client), `tests/integration/support/game-driver.ts` (oracle-driven game player).
Open points with chief are listed in the QUALITY-001 result message (CSRF header, events query parameters, server port env, seeder).
