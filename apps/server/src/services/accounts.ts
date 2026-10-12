import { createHash, randomBytes, randomUUID, timingSafeEqual } from "node:crypto";
import { createRepos, isUniqueViolation, type GameDb, type WriteQueue } from "@2048/database";
import { DomainError, type Identity, type Preferences } from "@2048/contracts";
import type { ServerConfig } from "../config.ts";
import { forbidden, unauthenticated } from "../errors.ts";
import { AttemptLimiter } from "../limiter.ts";
import { mergePreferences, normalizeUsername } from "../schemas.ts";
import type { PasswordHasher } from "./passwords.ts";

export type Principal =
  | { kind: "user"; userId: string; username: string; displayName: string; sessionId: number; token: string }
  | { kind: "guest"; userId: string; displayName: string; sessionId: number; token: string };

export type SessionIssue = { principal: Principal; identity: Identity; token: string; maxAgeSec: number };

const sha256 = (s: string) => createHash("sha256").update(s, "utf8").digest("hex");
export const hashToken = (token: string) => sha256(`session-v1:${token}`);
/** CSRF token bound to the session token; unforgeable without the HttpOnly cookie. */
export const csrfTokenFor = (token: string) => sha256(`csrf-v1:${token}`);

export function csrfMatches(token: string, presented: string | undefined): boolean {
  if (typeof presented !== "string" || presented.length !== 64) return false;
  return timingSafeEqual(Buffer.from(csrfTokenFor(token)), Buffer.from(presented));
}

export type AccountDeps = {
  db: GameDb;
  queue: WriteQueue;
  config: ServerConfig;
  hasher: PasswordHasher;
  now?: () => Date;
};

export class AccountService {
  readonly #d: AccountDeps;
  readonly #loginUser: AttemptLimiter;
  readonly #loginIp: AttemptLimiter;
  readonly #registerIp: AttemptLimiter;
  readonly #guestIp: AttemptLimiter;
  readonly #passwordGuess: AttemptLimiter;

  constructor(deps: AccountDeps) {
    this.#d = deps;
    const l = deps.config.limits;
    this.#loginUser = new AttemptLimiter(l.loginFailuresPerUser, l.failureWindowMs);
    this.#loginIp = new AttemptLimiter(l.loginFailuresPerIp, l.failureWindowMs);
    this.#registerIp = new AttemptLimiter(l.registrationsPerIp, l.registrationWindowMs);
    this.#guestIp = new AttemptLimiter(l.guestsPerIp, l.registrationWindowMs);
    this.#passwordGuess = new AttemptLimiter(l.loginFailuresPerUser, l.failureWindowMs);
  }

  #now(): Date {
    return this.#d.now?.() ?? new Date();
  }

  #identity(p: Principal, preferences: Preferences): Identity {
    return {
      kind: p.kind,
      userId: p.userId,
      ...(p.kind === "user" ? { username: p.username } : {}),
      displayName: p.displayName,
      preferences,
      csrfToken: csrfTokenFor(p.token),
    };
  }

  /** Resolve a session cookie value to a live principal, or null. Never throws for unknown/expired tokens. */
  resolve(token: string | undefined, kind: "user" | "guest"): Principal | null {
    if (!token || token.length < 20 || token.length > 128) return null;
    const nowIso = this.#now().toISOString();
    return this.#d.db.read((raw) => {
      const r = createRepos(raw).accounts;
      const s = r.sessionByTokenHash(hashToken(token));
      if (!s || s.revokedAt !== null || s.expiresAt <= nowIso) return null;
      if (kind === "user" && s.userId) {
        const u = r.userById(s.userId);
        if (!u || u.deletedAt) return null;
        return { kind: "user", userId: u.id, username: u.usernameNormalized, displayName: u.displayName, sessionId: s.id, token } satisfies Principal;
      }
      if (kind === "guest" && s.guestId) {
        const g = r.guestById(s.guestId);
        if (!g) return null;
        return { kind: "guest", userId: g.id, displayName: g.displayName, sessionId: s.id, token } satisfies Principal;
      }
      return null;
    });
  }

  identityOf(p: Principal): Identity {
    if (p.kind === "guest") return this.#identity(p, mergePreferences(null));
    const profile = this.#d.db.read((raw) => createRepos(raw).accounts.profile(p.userId));
    return this.#identity(p, mergePreferences(profile?.preferencesJson ?? null));
  }

  #sessionExpiry(): { createdAt: string; expiresAt: string; maxAgeSec: number } {
    const now = this.#now();
    const ttl = this.#d.config.sessionTtlMs;
    return { createdAt: now.toISOString(), expiresAt: new Date(now.getTime() + ttl).toISOString(), maxAgeSec: Math.floor(ttl / 1000) };
  }

  async register(input: { username: string; displayName: string; password: string }, ip: string, replacing?: Principal): Promise<SessionIssue> {
    this.#registerIp.assertAllowed(ip);
    this.#registerIp.hit(ip);
    const passwordHash = await this.#d.hasher.hash(input.password);
    const token = randomBytes(32).toString("base64url");
    const exp = this.#sessionExpiry();
    const id = randomUUID();
    const prefs = JSON.stringify(mergePreferences(null));
    try {
      await this.#d.queue.submit((raw) => {
        const r = createRepos(raw).accounts;
        r.createUser({ id, usernameNormalized: input.username, displayName: input.displayName, passwordHash, createdAt: exp.createdAt, preferencesJson: prefs });
        r.createSession({ tokenHash: hashToken(token), userId: id, createdAt: exp.createdAt, expiresAt: exp.expiresAt });
        if (replacing?.kind === "user") r.revokeSession(replacing.sessionId, exp.createdAt);
      });
    } catch (err) {
      if (isUniqueViolation(err, "users.username_normalized")) {
        throw new DomainError("VALIDATION_ERROR", "That username is not available", { issues: [{ path: "username", message: "username is not available" }] });
      }
      throw err;
    }
    const principal: Principal = { kind: "user", userId: id, username: input.username, displayName: input.displayName, sessionId: 0, token };
    return { principal, identity: this.#identity(principal, mergePreferences(prefs)), token, maxAgeSec: exp.maxAgeSec };
  }

  async login(input: { username: string; password: string }, ip: string, replacing?: Principal): Promise<SessionIssue> {
    const username = normalizeUsername(input.username);
    this.#loginIp.assertAllowed(ip);
    this.#loginUser.assertAllowed(username);
    const user = this.#d.db.read((raw) => createRepos(raw).accounts.userByUsername(username));
    let ok = false;
    if (user && !user.deletedAt) ok = await this.#d.hasher.verify(user.passwordHash, input.password);
    else await this.#d.hasher.verifyDummy(input.password);
    if (!ok || !user) {
      this.#loginIp.hit(ip);
      this.#loginUser.hit(username);
      throw unauthenticated("Invalid username or password");
    }
    this.#loginUser.reset(username);
    const upgraded = this.#d.hasher.needsRehash(user.passwordHash) ? await this.#d.hasher.hash(input.password) : null;
    const token = randomBytes(32).toString("base64url");
    const exp = this.#sessionExpiry();
    await this.#d.queue.submit((raw) => {
      const r = createRepos(raw).accounts;
      if (upgraded) r.setPasswordHash(user.id, upgraded);
      r.createSession({ tokenHash: hashToken(token), userId: user.id, createdAt: exp.createdAt, expiresAt: exp.expiresAt });
      if (replacing?.kind === "user") r.revokeSession(replacing.sessionId, exp.createdAt);
    });
    const principal: Principal = { kind: "user", userId: user.id, username: user.usernameNormalized, displayName: user.displayName, sessionId: 0, token };
    return { principal, identity: this.identityOf(principal), token, maxAgeSec: exp.maxAgeSec };
  }

  async createGuest(ip: string): Promise<SessionIssue> {
    this.#guestIp.assertAllowed(ip);
    this.#guestIp.hit(ip);
    const id = randomUUID();
    const token = randomBytes(32).toString("base64url");
    const exp = this.#sessionExpiry();
    const displayName = `Guest ${id.slice(0, 4).toUpperCase()}`;
    await this.#d.queue.submit((raw) => {
      const r = createRepos(raw).accounts;
      r.createGuest({ id, displayName, createdAt: exp.createdAt });
      r.createSession({ tokenHash: hashToken(token), guestId: id, createdAt: exp.createdAt, expiresAt: exp.expiresAt });
    });
    const principal: Principal = { kind: "guest", userId: id, displayName, sessionId: 0, token };
    return { principal, identity: this.#identity(principal, mergePreferences(null)), token, maxAgeSec: exp.maxAgeSec };
  }

  async logout(p: Principal): Promise<void> {
    const at = this.#now().toISOString();
    await this.#d.queue.submit((raw) => void createRepos(raw).accounts.revokeSession(p.sessionId, at));
  }

  #requireUser(p: Principal): Extract<Principal, { kind: "user" }> {
    if (p.kind !== "user") throw forbidden("This action requires a registered account");
    return p;
  }

  /** Verify the current password for re-authentication, throttling guesses per account. */
  async #reauthenticate(p: Extract<Principal, { kind: "user" }>, password: string): Promise<void> {
    const key = `re:${p.userId}`;
    this.#passwordGuess.assertAllowed(key);
    const user = this.#d.db.read((raw) => createRepos(raw).accounts.userById(p.userId));
    const ok = !!user && !user.deletedAt && (await this.#d.hasher.verify(user.passwordHash, password));
    if (!ok) {
      this.#passwordGuess.hit(key);
      throw unauthenticated("Invalid password");
    }
    this.#passwordGuess.reset(key);
  }

  async changePassword(p: Principal, oldPassword: string, newPassword: string): Promise<void> {
    const user = this.#requireUser(p);
    await this.#reauthenticate(user, oldPassword);
    const hash = await this.#d.hasher.hash(newPassword);
    const at = this.#now().toISOString();
    await this.#d.queue.submit((raw) => {
      const r = createRepos(raw).accounts;
      r.setPasswordHash(user.userId, hash);
      r.revokeOtherSessions(user.userId, user.sessionId, at);
    });
  }

  async patchProfile(p: Principal, patch: { displayName?: string | undefined; preferences?: Partial<Preferences> | undefined }): Promise<Identity> {
    const user = this.#requireUser(p);
    const at = this.#now().toISOString();
    await this.#d.queue.submit((raw) => {
      const r = createRepos(raw).accounts;
      if (patch.displayName !== undefined) r.setDisplayName(user.userId, patch.displayName);
      if (patch.preferences) {
        const current = r.profile(user.userId);
        const merged = mergePreferences(current?.preferencesJson ?? null, patch.preferences);
        r.setPreferences(user.userId, JSON.stringify(merged), at);
      }
    });
    const refreshed = this.#d.db.read((raw) => createRepos(raw).accounts.userById(user.userId));
    return this.identityOf({ ...user, displayName: refreshed?.displayName ?? user.displayName });
  }

  async deleteProfile(p: Principal, password: string): Promise<void> {
    const user = this.#requireUser(p);
    await this.#reauthenticate(user, password);
    const at = this.#now().toISOString();
    await this.#d.queue.submit((raw) => createRepos(raw).accounts.anonymizeUser(user.userId, at));
  }

  purgeExpiredSessions(): number {
    const now = this.#now();
    const cutoff = new Date(now.getTime() - 7 * 86_400_000).toISOString();
    return this.#d.db.write((raw) => createRepos(raw).accounts.purgeExpiredSessions(now.toISOString(), cutoff));
  }
}
