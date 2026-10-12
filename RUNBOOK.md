# 2048 Infinite — runbook (experiment/conductor)

Everything runs on this machine. Installation fetches npm packages; playing needs no network.

## Install, build, run
```bash
npm ci
npm run build          # bundles apps/web into apps/web/dist
npm start              # Fastify on http://127.0.0.1:$API_PORT (default 5511), serves the bundled UI
npm run dev            # API + Vite dev server (WEB_PORT 5411, proxies /api)
```
Env (see `.env.example`, `.lab/env.sh`): `HOST` (loopback only; never 0.0.0.0), `API_PORT`, `WEB_PORT`,
`DATA_DIR`, `DATABASE_PATH`, `LOG_LEVEL`. The server applies pending migrations before it listens.

## Checks
```bash
npm run typecheck && npm run lint
npm test                      # unit (engine, bots, competition, database, server, web)
npm run test:integration      # cross-package + live server oracle checks
npm run test:e2e              # Playwright against the production build on loopback
npm run test:performance      # OPS-02..05 harness (set LAB_RUNTIME to a temp dir)
npm run golden:verify         # PRNG / game / canonical golden vectors
```

## Data
Single SQLite file at `DATABASE_PATH` (WAL mode). Never copy it while the app runs.
```bash
npm run db:migrate
npm run db:backup  -- <dest>      # SQLite backup API, safe while running
npm run db:restore -- <path>      # validates (integrity, schema, checksums); run with the app STOPPED
```
A corrupt or foreign restore file is refused and the active database is left untouched.
See `apps/server/README.md` and `packages/database/README.md` for recovery and limits.

## Policies
- Local rankings are trusted relative to other normal users of the app; an OS administrator can edit the database.
- Ranked challenge seeds are backend-owned; a local user can read app files, so seed secrecy is not a security guarantee.
- Password recovery is an explicit local owner reset (CLI), never an HTTP backdoor.
