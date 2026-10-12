# CONTRACT-001 / v1 — frozen by chief (experiment/conductor, run r1)

Authoritative sources: `docs/CONTRACTS.md` (shared oracle) plus the typed implementation in
`packages/contracts/src/` and the golden vectors in `packages/contracts/golden/`.
This file adds only the decisions the shared docs left open. A breaking change needs
CONTRACT-001/v2 published by chief; workers never edit `packages/contracts/`.

## Toolchain (locked at M0)
Node 24 (type-stripping runtime: `.ts` files run directly with `node`; imports use `.ts` extensions,
erasable syntax only: no enums / parameter properties / namespaces). TypeScript 5.9.3 `noEmit`,
Vitest 5.0.4, Vite 8.3.4, React 19.3.0, Fastify 5.12.5, better-sqlite3 13.0.3, argon2 0.45.1, zod 4.6.7,
Playwright 1.64.0. Workspaces: `@2048/{contracts,engine,bots,competition,database,server,web}`.
Commands: `npm ci`, `npm run typecheck|lint|test|test:integration|test:e2e|test:performance|build|start|dev`,
`db:migrate|db:backup|db:restore`, `golden:verify`. Ports/DB path come from `.lab/env.sh`.

## Decisions on open points
1. **PRNG**: step function, seed derivation, bounded draw (`limit = 2^32 - (2^32 mod n)`, redraw while `x >= limit`,
   return `x mod n`) are frozen in `golden/prng-v1.json`. Bot streams use namespace `2048-infinite/v1/bot`.
2. **Spawn**: empties listed row-major; draw 1 = position `below(emptyCount)`; draw 2 = `below(10)`, value
   `< spawnFourTenths` => exponent "2" (tile 4) else "1" (tile 2). `newGame` performs `startTiles` spawns.
   No-op = zero draws, no revision/acceptedMoves/score change; `applyMove` returns the SAME state object and `changed:false`.
3. **Slide**: line processed from the leading edge of the direction; compress, then merge adjacent equal pairs
   once each (`[1,1,1,1]` => `[2,2]`); score delta = sum of 2^(merged exponent).
4. **Status**: `completed` when dead board OR `acceptedMoves >= rules.moveCap`. Moves on a non-active state throw
   `DomainError("FORBIDDEN"...)`. `forfeited` is set only by service code (not the engine).
5. **Events**: exactly as documented on `DomainEvent` in `src/state.ts`. Milestones: one `milestone` event per
   exponent e >= 11 in (previousMax, newMax]; `celebrated2048` flips true at e = 11.
6. **Checksum**: `canonicalStateJson` in `src/checksum.ts` + SHA-256 hex. Engine implements a synchronous pure
   SHA-256 (also needed by seed derivation) so it works in browser, worker, and Node. `revision` is included.
7. **Revision vs acceptedMoves**: both +1 per changed move. Undo (service-level, casual only) restores a full
   earlier `GameState` (including PRNG) and records an undo marker; `revision` keeps INCREASING on undo (service
   writes a new revision whose state equals the restored state except `revision`), so optimistic concurrency stays monotone.
8. **Resource limits**: exponents must be `isExponent` and <= `MAX_EXPONENT_DIGITS` (default 7 digits) on
   deserialize; engine adds at most 1 per merge so growth is bounded by moves. `RESOURCE_LIMIT` via `DomainError`.

## Engine public API (`@2048/engine`, all pure, inputs never mutated)
```ts
newGame(rules: Ruleset, seed: string): GameState
slide(board: Board, direction: Direction): SlideResult
applyMove(state: GameState, direction: Direction, rules: Ruleset): MoveResult
legalMoves(board: Board): Direction[]            // order: up,right,down,left
isGameOver(board: Board): boolean
serialize(state: GameState): string              // canonical JSON (== canonicalStateJson)
deserialize(json: string): GameState             // validates versions, cells, rng, throws DomainError
validateState(state: unknown): GameState
stateChecksum(state: GameState): string          // sha256 hex of canonicalStateJson
sha256Hex(utf8: string): string
deriveSeedWords(seed: string, namespace?: string): [number, number, number, number]
createRng(words): { next(): number; below(n: number): number; state(): RandomState }   // bots/tests
replay(initial: GameState, moves: Direction[], rules: Ruleset): { state: GameState; steps: { direction; changed; checksum }[] }
```
Bots (`@2048/bots`) and competition (`@2048/competition`) import ONLY these exports.

## Ownership (unchanged from docs/ARCHITECTURE.md)
chief: root files, lockfile, package.json files, `packages/contracts/`, TASKS.md, integration.
engine: `packages/engine/**`. backend: `apps/server/**`, `packages/database/**`. frontend: `apps/web/**`.
competition: `packages/bots/**`, `packages/competition/**`. quality: `tests/acceptance|integration|performance/**`.
Workers needing a new dependency or contract change message chief via `tools/mailbox.py` (kind `question`).

## Message protocol
`tools/mailbox.py` with `LAB_*` env from `.lab/env.sh`. Chief sends `task`; worker replies `ack` (+ plan in a
`status` message) before coding, then `result` with commit SHA, commands run, evidence paths, risks.

## Addendum A1 (additive, 2026-10-12) — answers to FRONTEND-001 questions
1. CSRF: modifying requests send header `x-csrf-token` = `Identity.csrfToken` (`CSRF_HEADER`).
2. Guests: server guest sessions. `POST /auth/guest` (no body) sets an opaque HttpOnly guest cookie and returns `Identity{kind:"guest"}`.
   Guests may create classic/practice/bot-exhibition games only; no ranked, no human Elo, no leaderboards writes. Local-only guest play stays as offline fallback.
3. `GET /replays/:id` takes the GAME id (owner, or a match seat game after the match is finished). `GET /replays` lists own finished games (`Page<ReplaySummary>`).
4. `GET /challenges` returns `Page<Challenge>` (`{items,nextCursor}`).
5. Bot runs: `GET /bots/runs/:id` (BotRunView), `POST /bots/runs/:id/{pause|resume|step|cancel}` all idempotent.
6. WS payload shapes: see `WsPayloads` in `src/api.ts`. `GameView` in `game.updated` is authoritative; clients ignore `sequence <= last seen`.
7. `GET /profile/stats` returns `ProfileStats`.
