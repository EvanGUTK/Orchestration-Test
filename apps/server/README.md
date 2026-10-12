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
| `GET /auth/me` | Current identity + `csrfToken`. Without a session it creates a guest (`gid` cookie). Never returns hashes/tokens. |
| `POST /auth/register` | `RegisterRequest`; username ASCII-lowercased + `USERNAME_PATTERN`, unique; display name 1-48 code points, no control characters; logs in (201). |
| `POST /auth/login` | Generic 401 on any failure; 5 failures/username/minute (and 20/client) → 429 `RATE_LIMITED` + `Retry-After`. |
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
  loopback `Host` from the allowed list); `Sec-Fetch-Site: cross-site` is rejected → 403.
- Errors: `{ error: { code, message, requestId, details? } }`, status from `ERROR_HTTP_STATUS`, no
  stack traces. Logs record method/path/status only and redact cookies, tokens, passwords.
- Owner password reset is local only:
  `node --conditions=source --import tsx apps/server/src/cli.ts reset-password <username>`
  (new password from stdin, prompted twice without echo on a terminal). It revokes all sessions.
