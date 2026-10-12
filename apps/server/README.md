# apps/server

Backend owns this workspace: local HTTP + WebSocket services, authority, and accounts.
Binds to loopback only (`HOST` must be `127.0.0.1` or `::1`; anything else aborts boot).

```
npm start                       # node apps/server/src/main.ts (migrates, then listens on $HOST:$API_PORT)
npm run db:migrate|db:backup|db:restore -- <file>   # see packages/database/README.md
```

Environment: `HOST`, `API_PORT`, `WEB_PORT`, `DATABASE_PATH` (from `.lab/env.sh`); optional `WEB_DIST`
(defaults to `apps/web/dist` when it exists), `EXTRA_ORIGINS`, `COOKIE_SECURE=1`, `SESSION_TTL_HOURS`,
`BODY_LIMIT_BYTES`, `LOG_LEVEL`, and the throttling knobs in `src/config.ts` (`LOGIN_FAILURES_PER_USER`,
`REQUESTS_PER_MINUTE`, `MAX_ACTIVE_GAMES`, `WRITE_QUEUE_MAX`, `ARGON2_*`).

## Security model

- Argon2id (per-hash random salt, versioned params, rehash on login). Sessions are random 256-bit tokens;
  only `sha256` hashes are stored. Cookies: `sid` (account) / `gsid` (guest), HttpOnly, SameSite=Strict.
- Mutating requests need the session-bound CSRF token in `x-csrf-token` (returned as `Identity.csrfToken`),
  a trusted `Origin` (or no Origin and no cross-site `Sec-Fetch-Site`), JSON bodies only, and a trusted `Host`.
- No CORS headers are ever sent. Login failures, registrations, guests and total request rate are throttled.
- WebSocket `/api/v1/events`: session + Origin + Host are checked before the upgrade; subscriptions are
  authorized per resource; slow consumers are closed with code 1013; malformed clients with 1003.

## Authority

Every game command (move / undo / forfeit / system end) runs in ONE `BEGIN IMMEDIATE` transaction through a
bounded write queue: stored-response replay by `commandId` -> ownership -> `expectedRevision` -> pure engine
transition -> game row + move log + snapshot (every 50 accepted moves) + command response -> competition hooks
(challenge attempt result, duel seat/match/Elo). WebSocket events are published only after COMMIT.
Scores and exponents are TEXT decimals everywhere; boards order by (length, lexical).

## Endpoints beyond the frozen table (additive)

`POST /auth/guest`, `DELETE /auth/sessions` (sign out everywhere else), `GET /profile/stats`,
`GET /matches?scope=mine|lobby`, `GET /replays`, `GET /bots/runs/:id`, `POST /bots/runs/:id/{pause|resume|step|cancel}`.
`GET /games/:id/events` accepts `cursor` or `after`. Forfeit returns the same `MoveResponse` as moves/undo.
