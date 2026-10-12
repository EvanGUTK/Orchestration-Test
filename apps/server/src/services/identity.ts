import type { UserRow } from "@g2048/database";

/**
 * Who is making a request. Accounts and guests are disjoint identity spaces: a guest session can
 * never be resolved as an account (different cookie, `sessions.kind`, and id space) and therefore
 * can never act as a human account or enter human rankings.
 */
export type Identity =
  | { kind: "user"; user: UserRow; sessionToken: string; tokenHash: string; csrfToken: string }
  | { kind: "guest"; guestId: string; sessionToken: string; tokenHash: string; csrfToken: string }
  | { kind: "anonymous" };

export type UserIdentity = Extract<Identity, { kind: "user" }>;
export type GuestIdentity = Extract<Identity, { kind: "guest" }>;

export const SESSION_COOKIE = "sid";
export const GUEST_COOKIE = "gid";
