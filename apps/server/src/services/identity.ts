import type { UserRow } from "@g2048/database";

/**
 * Who is making a request. Accounts and guests are disjoint identity spaces: a guest session can
 * never be resolved as an account (different cookie, `sessions.kind`, and id space) and therefore
 * can never act as a human account or enter human rankings.
 *
 * `anonymous` callers may hold an UNREGISTERED `gid` token issued by GET /auth/me without any
 * database row (`pendingToken`); their CSRF token is bound to it. A guest row + session is created
 * lazily from that same token only when a guest-owned action needs one (SEC-FIX-001 M2).
 */
export type Identity =
  | { kind: "user"; user: UserRow; sessionToken: string; tokenHash: string; csrfToken: string }
  | { kind: "guest"; guestId: string; sessionToken: string; tokenHash: string; csrfToken: string }
  | { kind: "anonymous"; pendingToken: string | null; csrfToken: string | null };

export type UserIdentity = Extract<Identity, { kind: "user" }>;
export type GuestIdentity = Extract<Identity, { kind: "guest" }>;
export type AnonymousIdentity = Extract<Identity, { kind: "anonymous" }>;

export const SESSION_COOKIE = "sid";
export const GUEST_COOKIE = "gid";
