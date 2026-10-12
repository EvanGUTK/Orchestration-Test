import { randomUUID } from "node:crypto";
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
import { csrfTokenFor, hashToken, isWellFormedToken, newSessionToken } from "../security/tokens.js";
import type { ServiceContext } from "./context.js";
import { nowIso } from "./context.js";
import type { GuestIdentity, Identity, UserIdentity } from "./identity.js";
import { FailureRateLimiter } from "./rate-limiter.js";

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

export type NewSession = { token: string; expiresAt: Date };

export type AuthServiceOptions = {
  hasher: PasswordHasher;
  /** Failed logins allowed per username per window (default LIMITS.loginAttemptsPerWindow). */
  loginAttemptsPerWindow?: number;
  loginWindowMs?: number;
  sessionTtlMs?: number;
};

export class AuthService {
  readonly #ctx: ServiceContext;
  readonly #hasher: PasswordHasher;
  readonly #sessionTtlMs: number;
  readonly #perAccount: FailureRateLimiter;
  readonly #perClient: FailureRateLimiter;

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
    if (isWellFormedToken(gidCookie)) {
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
    }
    return { kind: "anonymous" };
  }

  #newSession(): { token: string; tokenHash: string; expiresAt: Date } {
    const token = newSessionToken();
    return {
      token,
      tokenHash: hashToken(token),
      expiresAt: new Date(this.#ctx.clock().getTime() + this.#sessionTtlMs),
    };
  }

  /** Creates a separate guest identity with its own opaque session. */
  async createGuest(): Promise<GuestIdentity & { expiresAt: Date }> {
    const guestId = randomUUID();
    const session = this.#newSession();
    await this.#ctx.writer.run((db) => {
      const now = nowIso(this.#ctx);
      guestsRepo.insert(db, guestId, now);
      sessionsRepo.insert(db, {
        tokenHash: session.tokenHash,
        kind: "guest",
        guestId,
        now,
        expiresAt: session.expiresAt.toISOString(),
      });
    });
    return {
      kind: "guest",
      guestId,
      sessionToken: session.token,
      tokenHash: session.tokenHash,
      csrfToken: csrfTokenFor(session.token),
      expiresAt: session.expiresAt,
    };
  }

  // ---------- accounts ----------

  async register(
    input: { username: string; displayName: string; password: string },
    replacedSessionHash: string | null,
  ): Promise<{ user: UserRow; session: NewSession }> {
    const username = normalizeUsername(input.username);
    if (!USERNAME_PATTERN.test(username)) {
      throw new AppError("VALIDATION_ERROR", "Username must be 3-24 characters: a-z, 0-9 or underscore", {
        field: "username",
      });
    }
    checkDisplayName(input.displayName);
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
    for (const decision of [this.#perAccount.check(accountKey), this.#perClient.check(clientLimitKey)]) {
      if (!decision.allowed) {
        const seconds = Math.ceil(decision.retryAfterMs / 1000);
        throw new AppError(
          "RATE_LIMITED",
          "Too many login attempts; try again later",
          { retryAfterSeconds: seconds },
          { "retry-after": String(seconds) },
        );
      }
    }
    const user = USERNAME_PATTERN.test(username) ? usersRepo.findByUsername(this.#ctx.db, username) : null;
    const ok = user
      ? await this.#hasher.verify(input.password, user.passwordHash)
      : await this.#hasher.verifyDummy(input.password);
    if (!user || !ok) {
      this.#perAccount.fail(accountKey);
      this.#perClient.fail(clientLimitKey);
      throw new AppError("UNAUTHENTICATED", GENERIC_LOGIN_FAILURE);
    }
    this.#perAccount.reset(accountKey);
    const upgraded = this.#hasher.needsRehash(user.passwordHash)
      ? await this.#hasher.hash(input.password)
      : null;
    const session = this.#newSession();
    await this.#ctx.writer.run((db) => {
      const now = nowIso(this.#ctx);
      if (upgraded) usersRepo.updatePasswordHash(db, user.id, upgraded, now);
      if (replacedSessionHash) sessionsRepo.revoke(db, replacedSessionHash, now);
      sessionsRepo.insert(db, {
        tokenHash: session.tokenHash,
        kind: "account",
        userId: user.id,
        now,
        expiresAt: session.expiresAt.toISOString(),
      });
    });
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
    const decision = this.#perAccount.check(key);
    if (!decision.allowed) {
      const seconds = Math.ceil(decision.retryAfterMs / 1000);
      throw new AppError(
        "RATE_LIMITED",
        "Too many password attempts; try again later",
        { retryAfterSeconds: seconds },
        { "retry-after": String(seconds) },
      );
    }
    const current = usersRepo.findById(this.#ctx.db, identity.user.id);
    if (!current || !(await this.#hasher.verify(input.currentPassword, current.passwordHash))) {
      this.#perAccount.fail(key);
      throw new AppError("VALIDATION_ERROR", "Current password is incorrect", { field: "currentPassword" });
    }
    this.#perAccount.reset(key);
    const passwordHash = await this.#hasher.hash(input.newPassword);
    return this.#ctx.writer.run((db) => {
      const now = nowIso(this.#ctx);
      usersRepo.updatePasswordHash(db, identity.user.id, passwordHash, now);
      return sessionsRepo.revokeAllForUser(db, identity.user.id, now, identity.tokenHash);
    });
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

  me(identity: UserIdentity | GuestIdentity): MeResponse {
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
    return {
      user: null,
      guest: { id: identity.guestId },
      csrfToken: identity.csrfToken,
      preferences: sanitizePreferences(guestsRepo.get(db, identity.guestId)?.preferences ?? {}),
    };
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
