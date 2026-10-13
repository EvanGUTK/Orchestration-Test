import { randomBytes, randomUUID } from "node:crypto";
import {
  LIMITS,
  PreferencesSchema,
  USERNAME_PATTERN,
  type MeResponse,
  type Preferences,
  type PublicUser,
} from "@g2048/contracts";
import {
  guestsRepo,
  isSqliteConstraint,
  profilesRepo,
  sessionsRepo,
  usersRepo,
  type UserRow,
} from "@g2048/database";
import { AppError } from "../http/errors.js";
import type { PasswordHasher } from "../security/passwords.js";
import {
  csrfTokenFor,
  hashToken,
  isPendingGuestTokenShape,
  isWellFormedToken,
  newPendingGuestToken,
  newSessionToken,
  verifyPendingGuestToken,
} from "../security/tokens.js";
import type { ServiceContext } from "./context.js";
import { nowIso } from "./context.js";
import type { AnonymousIdentity, GuestIdentity, Identity, UserIdentity } from "./identity.js";
import { FailureRateLimiter, type RateLimitDecision } from "./rate-limiter.js";

/** ASCII-only lowercase; non-ASCII characters are left as-is and then fail USERNAME_PATTERN. */
export function normalizeUsername(raw: string): string {
  return raw.replace(/[A-Z]/g, (c) => c.toLowerCase());
}

/** Display names: 1-48 code points (contract), plus no control characters and not blank. */
export function checkDisplayName(name: string): void {
  if (/\p{Cc}/u.test(name) || /^\s*$/u.test(name)) {
    throw new AppError("VALIDATION_ERROR", "Display name must be visible text without control characters", {
      field: "displayName",
    });
  }
}

const GENERIC_LOGIN_FAILURE = "Invalid username or password";
/** Guests without a session whose games are all older than this are purged with their games. */
export const GUEST_RETENTION_MS = 30 * 24 * 60 * 60 * 1000;

export type NewSession = { token: string; expiresAt: Date };

export type AuthServiceOptions = {
  hasher: PasswordHasher;
  /** Failed logins allowed per username per window (default LIMITS.loginAttemptsPerWindow). */
  loginAttemptsPerWindow?: number;
  loginWindowMs?: number;
  sessionTtlMs?: number;
  /** Registrations per client per window (default 10). */
  registrationsPerWindow?: number;
  /** Guest identities created per client per window (default 30). */
  guestsPerWindow?: number;
  /** Total guest identities kept (default 10_000); creation beyond it is RESOURCE_LIMIT. */
  maxGuests?: number;
};

function rateLimited(decision: RateLimitDecision, message: string): AppError | null {
  if (decision.allowed) return null;
  const seconds = Math.ceil(decision.retryAfterMs / 1000);
  return new AppError(
    "RATE_LIMITED",
    message,
    { retryAfterSeconds: seconds },
    { "retry-after": String(seconds) },
  );
}

export class AuthService {
  readonly #ctx: ServiceContext;
  readonly #hasher: PasswordHasher;
  readonly #sessionTtlMs: number;
  readonly #perAccount: FailureRateLimiter;
  readonly #perClient: FailureRateLimiter;
  readonly #registrations: FailureRateLimiter;
  readonly #guestCreation: FailureRateLimiter;
  /** Per-process key for pending guest tokens; a restart invalidates unpersisted pending tokens. */
  readonly #pendingSecret = randomBytes(32);
  readonly #maxGuests: number;

  constructor(ctx: ServiceContext, options: AuthServiceOptions) {
    this.#ctx = ctx;
    this.#hasher = options.hasher;
    this.#sessionTtlMs = options.sessionTtlMs ?? LIMITS.sessionTtlMs;
    const limit = options.loginAttemptsPerWindow ?? LIMITS.loginAttemptsPerWindow;
    const windowMs = options.loginWindowMs ?? LIMITS.loginWindowMs;
    const now = () => ctx.clock().getTime();
    this.#perAccount = new FailureRateLimiter({ limit, windowMs, now });
    // All local clients share 127.0.0.1, so the per-client cap is looser; it bounds username spraying.
    this.#perClient = new FailureRateLimiter({ limit: limit * 4, windowMs, now });
    this.#registrations = new FailureRateLimiter({
      limit: options.registrationsPerWindow ?? 10,
      windowMs,
      now,
    });
    this.#guestCreation = new FailureRateLimiter({ limit: options.guestsPerWindow ?? 30, windowMs, now });
    this.#maxGuests = options.maxGuests ?? 10_000;
  }

  /** Eagerly prepares the dummy hash so unknown-user timing matches from the first request. */
  async warmup(): Promise<void> {
    await this.#hasher.warmup();
  }

  // ---------- identity resolution ----------

  resolve(sidCookie: string | undefined, gidCookie: string | undefined): Identity {
    const { db } = this.#ctx;
    const now = nowIso(this.#ctx);
    if (isWellFormedToken(sidCookie)) {
      const tokenHash = hashToken(sidCookie);
      const session = sessionsRepo.findActive(db, tokenHash, "account", now);
      const user = session?.userId ? usersRepo.findById(db, session.userId) : null;
      if (user) {
        return { kind: "user", user, sessionToken: sidCookie, tokenHash, csrfToken: csrfTokenFor(sidCookie) };
      }
    }
    if (isWellFormedToken(gidCookie) || isPendingGuestTokenShape(gidCookie)) {
      const tokenHash = hashToken(gidCookie);
      const session = sessionsRepo.findActive(db, tokenHash, "guest", now);
      if (session?.guestId) {
        return {
          kind: "guest",
          guestId: session.guestId,
          sessionToken: gidCookie,
          tokenHash,
          csrfToken: csrfTokenFor(gidCookie),
        };
      }
      // Not a session: only a pending token minted by this server process is honoured.
      if (isPendingGuestTokenShape(gidCookie) && verifyPendingGuestToken(this.#pendingSecret, gidCookie)) {
        return { kind: "anonymous", pendingToken: gidCookie, csrfToken: csrfTokenFor(gidCookie) };
      }
    }
    return { kind: "anonymous", pendingToken: null, csrfToken: null };
  }

  /** A fresh unregistered `gid` token for an anonymous caller; nothing is written to the database. */
  issuePendingGuestToken(): { token: string; csrfToken: string; expiresAt: Date } {
    const token = newPendingGuestToken(this.#pendingSecret);
    return {
      token,
      csrfToken: csrfTokenFor(token),
      expiresAt: new Date(this.#ctx.clock().getTime() + this.#sessionTtlMs),
    };
  }

  #newSession(): { token: string; tokenHash: string; expiresAt: Date } {
    const token = newSessionToken();
    return {
      token,
      tokenHash: hashToken(token),
      expiresAt: new Date(this.#ctx.clock().getTime() + this.#sessionTtlMs),
    };
  }

  /**
   * Creates the guest identity for an anonymous caller, adopting its pending `gid` token so the
   * CSRF token it already holds stays valid. Throttled per client. If the pending token was used
   * before (an expired/revoked row exists) a fresh token is minted instead.
   */
  async createGuest(
    anonymous: AnonymousIdentity,
    clientKey: string,
  ): Promise<GuestIdentity & { expiresAt: Date; tokenChanged: boolean }> {
    const limited = rateLimited(
      this.#guestCreation.reserve(`guest:${clientKey}`),
      "Too many new guest sessions; try again later",
    );
    if (limited) throw limited;
    const guestId = randomUUID();
    const expiresAt = new Date(this.#ctx.clock().getTime() + this.#sessionTtlMs);
    // Only a token this server process minted (MAC-verified in resolve) is adopted (SEC-R2-03).
    const adoptable =
      anonymous.pendingToken !== null && verifyPendingGuestToken(this.#pendingSecret, anonymous.pendingToken);
    let token = adoptable ? (anonymous.pendingToken as string) : newPendingGuestToken(this.#pendingSecret);
    const tokenHash = await this.#ctx.writer.run((db) => {
      const now = nowIso(this.#ctx);
      const guests = (db.prepare("SELECT COUNT(*) AS n FROM guests").get() as { n: number }).n;
      if (guests >= this.#maxGuests) {
        throw new AppError("RESOURCE_LIMIT", "Too many guest profiles on this machine; create an account");
      }
      let hash = hashToken(token);
      const reused =
        db.prepare("SELECT 1 AS used FROM sessions WHERE token_hash = ?").get(hash) !== undefined;
      if (reused) {
        token = newPendingGuestToken(this.#pendingSecret);
        hash = hashToken(token);
      }
      guestsRepo.insert(db, guestId, now);
      sessionsRepo.insert(db, {
        tokenHash: hash,
        kind: "guest",
        guestId,
        now,
        expiresAt: expiresAt.toISOString(),
      });
      return hash;
    });
    return {
      kind: "guest",
      guestId,
      sessionToken: token,
      tokenHash,
      csrfToken: csrfTokenFor(token),
      expiresAt,
      tokenChanged: token !== anonymous.pendingToken,
    };
  }

  // ---------- accounts ----------

  async register(
    input: { username: string; displayName: string; password: string },
    clientKey: string,
    replacedSessionHash: string | null,
  ): Promise<{ user: UserRow; session: NewSession }> {
    const username = normalizeUsername(input.username);
    if (!USERNAME_PATTERN.test(username)) {
      throw new AppError("VALIDATION_ERROR", "Username must be 3-24 characters: a-z, 0-9 or underscore", {
        field: "username",
      });
    }
    checkDisplayName(input.displayName);
    const limited = rateLimited(
      this.#registrations.reserve(`register:${clientKey}`),
      "Too many new accounts; try again later",
    );
    if (limited) throw limited;
    const passwordHash = await this.#hasher.hash(input.password);
    const id = randomUUID();
    const session = this.#newSession();
    const taken = new AppError("VALIDATION_ERROR", "That username is not available", { field: "username" });
    try {
      await this.#ctx.writer.run((db) => {
        const now = nowIso(this.#ctx);
        if (usersRepo.usernameTaken(db, username)) throw taken;
        usersRepo.insert(db, {
          id,
          usernameNormalized: username,
          displayName: input.displayName,
          passwordHash,
          now,
        });
        profilesRepo.insert(db, id, now);
        if (replacedSessionHash) sessionsRepo.revoke(db, replacedSessionHash, now);
        sessionsRepo.insert(db, {
          tokenHash: session.tokenHash,
          kind: "account",
          userId: id,
          now,
          expiresAt: session.expiresAt.toISOString(),
        });
      });
    } catch (error) {
      if (isSqliteConstraint(error)) throw taken;
      throw error;
    }
    const user = usersRepo.findById(this.#ctx.db, id);
    if (!user) throw new Error("registered user not found");
    return { user, session: { token: session.token, expiresAt: session.expiresAt } };
  }

  async login(
    input: { username: string; password: string },
    clientKey: string,
    replacedSessionHash: string | null,
  ): Promise<{ user: UserRow; session: NewSession }> {
    const username = normalizeUsername(input.username);
    const accountKey = `login:${username}`;
    const clientLimitKey = `login-client:${clientKey}`;
    // Reserve the attempt BEFORE the async verification so parallel requests cannot exceed the limit.
    const accountDecision = this.#perAccount.reserve(accountKey);
    const accountLimited = rateLimited(accountDecision, "Too many login attempts; try again later");
    if (accountLimited) throw accountLimited;
    const clientLimited = rateLimited(
      this.#perClient.reserve(clientLimitKey),
      "Too many login attempts; try again later",
    );
    if (clientLimited) {
      this.#perAccount.release(accountKey);
      throw clientLimited;
    }

    const user = USERNAME_PATTERN.test(username) ? usersRepo.findByUsername(this.#ctx.db, username) : null;
    const ok = user
      ? await this.#hasher.verify(input.password, user.passwordHash)
      : await this.#hasher.verifyDummy(input.password);
    if (!user || !ok) throw new AppError("UNAUTHENTICATED", GENERIC_LOGIN_FAILURE);

    const upgraded = this.#hasher.needsRehash(user.passwordHash)
      ? await this.#hasher.hash(input.password)
      : null;
    const session = this.#newSession();
    const committed = await this.#ctx.writer.run((db) => {
      const now = nowIso(this.#ctx);
      // The password may have changed while we were hashing: never open a session (or write a
      // rehash) for credentials that are no longer current.
      if (usersRepo.currentPasswordHash(db, user.id) !== user.passwordHash) return false;
      if (upgraded) usersRepo.updatePasswordHashIfUnchanged(db, user.id, user.passwordHash, upgraded, now);
      if (replacedSessionHash) sessionsRepo.revoke(db, replacedSessionHash, now);
      sessionsRepo.insert(db, {
        tokenHash: session.tokenHash,
        kind: "account",
        userId: user.id,
        now,
        expiresAt: session.expiresAt.toISOString(),
      });
      return true;
    });
    if (!committed) throw new AppError("UNAUTHENTICATED", GENERIC_LOGIN_FAILURE);
    this.#perAccount.reset(accountKey);
    this.#perClient.release(clientLimitKey);
    return { user, session: { token: session.token, expiresAt: session.expiresAt } };
  }

  /** Revokes the current session, or every session of the account when `allSessions`. */
  async logout(identity: UserIdentity, allSessions: boolean): Promise<number> {
    return this.#ctx.writer.run((db) => {
      const now = nowIso(this.#ctx);
      if (allSessions) return sessionsRepo.revokeAllForUser(db, identity.user.id, now);
      return sessionsRepo.revoke(db, identity.tokenHash, now) ? 1 : 0;
    });
  }

  /** Verifies the current password, stores a fresh hash, and revokes every OTHER session. */
  async changePassword(
    identity: UserIdentity,
    input: { currentPassword: string; newPassword: string },
  ): Promise<number> {
    const key = `password:${identity.user.id}`;
    const limited = rateLimited(this.#perAccount.reserve(key), "Too many password attempts; try again later");
    if (limited) throw limited;
    const current = usersRepo.findById(this.#ctx.db, identity.user.id);
    if (!current || !(await this.#hasher.verify(input.currentPassword, current.passwordHash))) {
      throw new AppError("VALIDATION_ERROR", "Current password is incorrect", { field: "currentPassword" });
    }
    const passwordHash = await this.#hasher.hash(input.newPassword);
    const revoked = await this.#ctx.writer.run((db) => {
      const now = nowIso(this.#ctx);
      const stillActive = sessionsRepo.findActive(db, identity.tokenHash, "account", now) !== null;
      if (!stillActive) return null;
      if (
        !usersRepo.updatePasswordHashIfUnchanged(
          db,
          identity.user.id,
          current.passwordHash,
          passwordHash,
          now,
        )
      ) {
        return null;
      }
      return sessionsRepo.revokeAllForUser(db, identity.user.id, now, identity.tokenHash);
    });
    if (revoked === null) {
      throw new AppError("VALIDATION_ERROR", "The password was changed concurrently; sign in again", {
        field: "currentPassword",
      });
    }
    this.#perAccount.reset(key);
    return revoked;
  }

  /** Local owner reset (CLI only): sets a new password and revokes every session of the account. */
  async ownerResetPassword(rawUsername: string, newPassword: string): Promise<{ revokedSessions: number }> {
    const username = normalizeUsername(rawUsername);
    const user = usersRepo.findByUsername(this.#ctx.db, username);
    if (!user) throw new AppError("NOT_FOUND", `No active account named ${username}`);
    const passwordHash = await this.#hasher.hash(newPassword);
    const revokedSessions = await this.#ctx.writer.run((db) => {
      const now = nowIso(this.#ctx);
      usersRepo.updatePasswordHash(db, user.id, passwordHash, now);
      return sessionsRepo.revokeAllForUser(db, user.id, now);
    });
    return { revokedSessions };
  }

  // ---------- housekeeping ----------

  /**
   * Retention (documented in apps/server/README.md): deletes expired/revoked sessions, guests left
   * with no session and no games, and guests with no session whose games were all last touched more
   * than GUEST_RETENTION_MS ago (their games cascade).
   */
  async purgeInactive(): Promise<{ sessions: number; guests: number }> {
    return this.#ctx.writer.run((db) => {
      const now = this.#ctx.clock();
      const sessions = sessionsRepo.purgeInactive(db, now.toISOString());
      const orphans = guestsRepo.purgeOrphans(db);
      const abandoned = guestsRepo.purgeAbandoned(
        db,
        new Date(now.getTime() - GUEST_RETENTION_MS).toISOString(),
      );
      return { sessions, guests: orphans + abandoned };
    });
  }

  // ---------- profile ----------

  async updateProfile(
    identity: UserIdentity | GuestIdentity,
    patch: { displayName?: string | undefined; preferences?: Preferences | undefined },
  ): Promise<void> {
    if (patch.displayName !== undefined) {
      if (identity.kind !== "user") {
        throw new AppError("FORBIDDEN", "Guests do not have a display name; create an account");
      }
      checkDisplayName(patch.displayName);
    }
    await this.#ctx.writer.run((db) => {
      const now = nowIso(this.#ctx);
      if (identity.kind === "user") {
        if (patch.displayName !== undefined)
          usersRepo.updateDisplayName(db, identity.user.id, patch.displayName, now);
        if (patch.preferences) {
          const current = profilesRepo.get(db, identity.user.id)?.preferences ?? {};
          profilesRepo.setPreferences(
            db,
            identity.user.id,
            mergePreferences(current, patch.preferences),
            now,
          );
        }
      } else if (patch.preferences) {
        const current = guestsRepo.get(db, identity.guestId)?.preferences ?? {};
        guestsRepo.setPreferences(db, identity.guestId, mergePreferences(current, patch.preferences), now);
      }
    });
  }

  me(identity: Identity): MeResponse {
    const { db } = this.#ctx;
    if (identity.kind === "user") {
      const user = usersRepo.findById(db, identity.user.id) ?? identity.user;
      return {
        user: publicUser(user),
        guest: null,
        csrfToken: identity.csrfToken,
        preferences: sanitizePreferences(profilesRepo.get(db, user.id)?.preferences ?? {}),
      };
    }
    if (identity.kind === "guest") {
      return {
        user: null,
        guest: { id: identity.guestId },
        csrfToken: identity.csrfToken,
        preferences: sanitizePreferences(guestsRepo.get(db, identity.guestId)?.preferences ?? {}),
      };
    }
    return { user: null, guest: null, csrfToken: identity.csrfToken ?? "", preferences: {} };
  }

  meForNewSession(user: UserRow, sessionToken: string): MeResponse {
    return {
      user: publicUser(user),
      guest: null,
      csrfToken: csrfTokenFor(sessionToken),
      preferences: sanitizePreferences(profilesRepo.get(this.#ctx.db, user.id)?.preferences ?? {}),
    };
  }
}

export function publicUser(user: UserRow): PublicUser {
  return {
    id: user.id,
    username: user.usernameNormalized,
    displayName: user.displayName,
    createdAt: user.createdAt,
  };
}

function sanitizePreferences(stored: Record<string, unknown>): Preferences {
  const parsed = PreferencesSchema.safeParse(stored);
  if (parsed.success) return parsed.data;
  // Keep only individually valid keys if an older build stored something no longer allowed.
  const kept: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(stored)) {
    if (PreferencesSchema.safeParse({ [key]: value }).success) kept[key] = value;
  }
  return PreferencesSchema.parse(kept);
}

function mergePreferences(current: Record<string, unknown>, patch: Preferences): Preferences {
  return { ...sanitizePreferences(current), ...patch };
}
