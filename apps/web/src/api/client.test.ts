import { describe, expect, it } from "vitest";
import { ApiClient, ApiError, ConnectionStatus, describeApiError, withRetry } from "./client.js";
import { createFakeServer } from "../test/fake-server.js";

const instant = () => Promise.resolve();

describe("ApiClient", () => {
  it("fetches the CSRF token before the first mutation and sends it with same-origin credentials", async () => {
    const server = createFakeServer();
    const api = new ApiClient({ fetch: server.fetch });
    await api.logout();
    expect(server.requests.map((r) => `${r.method} ${r.path}`)).toEqual([
      "GET /auth/me",
      "POST /auth/logout",
    ]);
    expect(server.requests[1]!.csrf).toBe("csrf-guest-1");
    expect(server.requests.every((r) => r.credentials === "same-origin")).toBe(true);
  });

  it("adopts the rotated CSRF token returned by login (C8)", async () => {
    const server = createFakeServer();
    const api = new ApiClient({ fetch: server.fetch });
    const me = await api.login({ username: "ada", password: "correct horse battery" });
    expect(me.user?.displayName).toBe("Ada");
    await api.patchProfile({ displayName: "Ada L." });
    expect(server.requests.at(-1)!.csrf).toBe(me.csrfToken);
    expect(server.user?.displayName).toBe("Ada L.");
  });

  it("parses the error envelope with code, requestId and Retry-After", async () => {
    const server = createFakeServer();
    server.faults.rateLimitSeconds = 30;
    const api = new ApiClient({ fetch: server.fetch });
    const err = await api.login({ username: "ada", password: "x" }).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(ApiError);
    const e = err as ApiError;
    expect(e.code).toBe("RATE_LIMITED");
    expect(e.status).toBe(429);
    expect(e.requestId).toMatch(/^req-/);
    expect(e.retryAfterMs).toBe(30_000);
    expect(describeApiError(e)).toBe("Too many attempts. Try again in 30 seconds.");
  });

  it("refreshes a stale CSRF token once and retries", async () => {
    const server = createFakeServer();
    const api = new ApiClient({ fetch: server.fetch });
    await api.me();
    // Another tab signed in and rotated the token.
    await createFakeServerLoginRotation(server);
    await api.logout();
    const paths = server.requests.map((r) => `${r.method} ${r.path}`);
    expect(paths.slice(-3)).toEqual(["POST /auth/logout", "GET /auth/me", "POST /auth/logout"]);
  });

  it("maps network failures to NETWORK_ERROR and unknown bodies safely", async () => {
    const down = new ApiClient({ fetch: () => Promise.reject(new TypeError("Failed to fetch")) });
    await expect(down.me()).rejects.toMatchObject({ code: "NETWORK_ERROR", status: 0 });
    const html = new ApiClient({
      fetch: async () => new Response("<html>bad gateway</html>", { status: 502 }),
    });
    await expect(html.me()).rejects.toMatchObject({ code: "INTERNAL_ERROR", status: 502 });
  });
});

async function createFakeServerLoginRotation(server: ReturnType<typeof createFakeServer>) {
  const other = new ApiClient({ fetch: server.fetch });
  await other.login({ username: "ada", password: "correct horse battery" });
}

describe("withRetry", () => {
  it("retries transient failures with backoff and reports reconnect progress", async () => {
    const connection = new ConnectionStatus();
    const seen: string[] = [];
    connection.subscribe(() => seen.push(connection.get().kind));
    let calls = 0;
    const value = await withRetry(
      async () => {
        calls++;
        if (calls < 3) throw new ApiError("DB_BUSY", "busy", 503, "r1");
        return "ok";
      },
      connection,
      instant,
    );
    expect(value).toBe("ok");
    expect(calls).toBe(3);
    expect(seen).toEqual(["retrying", "retrying", "online"]);
  });

  it("does not retry non-transient errors", async () => {
    let calls = 0;
    await expect(
      withRetry(
        async () => {
          calls++;
          throw new ApiError("REVISION_CONFLICT", "stale", 409, "r2");
        },
        new ConnectionStatus(),
        instant,
      ),
    ).rejects.toMatchObject({ code: "REVISION_CONFLICT" });
    expect(calls).toBe(1);
  });

  it("goes offline after the last attempt", async () => {
    const connection = new ConnectionStatus();
    await expect(
      withRetry(
        () => Promise.reject(new ApiError("NETWORK_ERROR", "down", 0, null)),
        connection,
        instant,
        [1, 1],
      ),
    ).rejects.toMatchObject({ code: "NETWORK_ERROR" });
    expect(connection.get().kind).toBe("offline");
  });
});
