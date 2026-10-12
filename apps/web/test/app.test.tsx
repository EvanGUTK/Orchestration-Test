// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { CLASSIC_RULES } from "@2048/contracts";
import type { Challenge, Identity, ReplayView } from "@2048/contracts";
import * as engine from "@2048/engine";
import { ApiClient, ApiRequestError, CSRF_HEADER, describeError } from "../src/api/client.ts";
import { App } from "../src/App.tsx";
import { ReplaySeeker, describeEvents, parseReplayDocument } from "../src/screens/Replay.tsx";
import { AppProvider } from "../src/state/app.tsx";
import { DEFAULT_PREFERENCES } from "../src/state/prefs.ts";
import { jsonResponse } from "./helpers.ts";

const user: Identity = { kind: "user", userId: "u1", username: "alice", displayName: "Alice", preferences: DEFAULT_PREFERENCES, csrfToken: "csrf-1" };

function client(handler: (url: string, init: RequestInit) => Response | Promise<Response>): ApiClient {
  return new ApiClient({ fetchImpl: (async (input: RequestInfo | URL, init?: RequestInit) => handler(String(input), init ?? {})) as typeof fetch });
}

beforeEach(() => {
  window.localStorage.clear();
  window.location.hash = "";
});
afterEach(() => cleanup());

describe("ApiClient", () => {
  it("maps contract error envelopes to typed errors", async () => {
    const api = client(() => jsonResponse({ error: { code: "REVISION_CONFLICT", message: "stale", requestId: "req-9" } }, 409));
    const error = await api.getGame("g1").catch((e: unknown) => e);
    expect(error).toBeInstanceOf(ApiRequestError);
    expect((error as ApiRequestError).code).toBe("REVISION_CONFLICT");
    expect((error as ApiRequestError).requestId).toBe("req-9");
  });

  it("reports network failures distinctly and sends csrf + JSON on mutations only", async () => {
    const calls: { url: string; init: RequestInit }[] = [];
    const api = client((url, init) => {
      calls.push({ url, init });
      if (url.endsWith("/auth/me")) return jsonResponse(user);
      if (url.endsWith("/moves")) return jsonResponse({ game: {}, changed: false, scoreDelta: "0", events: [], sequence: 1 });
      throw new TypeError("fetch failed");
    });
    await api.me();
    await api.move("g1", { commandId: "c1", expectedRevision: 3, direction: "left" });
    const move = calls.find((c) => c.url.endsWith("/moves"));
    expect((move?.init.headers as Record<string, string>)[CSRF_HEADER]).toBe("csrf-1");
    expect(JSON.parse(String(move?.init.body))).toEqual({ commandId: "c1", expectedRevision: 3, direction: "left" });
    expect(move?.url).toBe("/api/v1/games/g1/moves");
    const me = calls.find((c) => c.url.endsWith("/auth/me"));
    expect((me?.init.headers as Record<string, string>)[CSRF_HEADER]).toBeUndefined();
    const failure = await api.health().catch((e: unknown) => e);
    expect((failure as ApiRequestError).isNetwork).toBe(true);
    expect(describeError(failure).action).toMatch(/server is running/);
  });

  it("keeps huge decimal strings intact through JSON", async () => {
    const big = "98765432109876543210987654321098765432109876543210";
    const api = client(() => jsonResponse({ items: [{ rank: 1, displayName: "A", score: big, createdAt: "2026-01-01T00:00:00Z", accountId: null }], nextCursor: null }));
    const page = await api.leaderboard({ kind: "casual" });
    expect(page.items[0]?.score).toBe(big);
  });
});

describe("App shell", () => {
  it("renders the welcome page for a guest and offers guest play", async () => {
    render(
      <AppProvider skipBootstrap>
        <App />
      </AppProvider>,
    );
    expect(screen.getByRole("heading", { name: "2048 Infinite", level: 1 })).toBeTruthy();
    expect(screen.getByRole("link", { name: "Play as guest" })).toBeTruthy();
    expect(screen.getByRole("navigation", { name: "Main" })).toBeTruthy();
    expect(screen.getByText(/Server offline/)).toBeTruthy();
  });

  it("plays a guest game in the browser with the real engine, keyboard only, and saves it", async () => {
    window.location.hash = "#/play";
    render(
      <AppProvider skipBootstrap>
        <App />
      </AppProvider>,
    );
    const board = await screen.findByTestId("board");
    await waitFor(() => expect(document.querySelectorAll(".tile").length).toBe(2));
    board.focus();
    const user = userEvent.setup();
    await user.keyboard("{ArrowLeft}{ArrowDown}{ArrowRight}{ArrowUp}wasd");
    await waitFor(() => expect(window.localStorage.getItem("2048-infinite:guest-game:v1")).not.toBeNull());
    const saved = JSON.parse(window.localStorage.getItem("2048-infinite:guest-game:v1") ?? "{}") as { state: string };
    const state = engine.deserialize(saved.state);
    expect(state.acceptedMoves).toBeGreaterThan(0);
    expect(state.rulesetVersion).toBe(CLASSIC_RULES.version);
  });

  it("resumes the saved guest game after a reload", async () => {
    window.location.hash = "#/play";
    const first = render(
      <AppProvider skipBootstrap>
        <App />
      </AppProvider>,
    );
    const board = await screen.findByTestId("board");
    board.focus();
    await userEvent.setup().keyboard("{ArrowLeft}{ArrowUp}{ArrowRight}{ArrowDown}");
    await waitFor(() => expect(window.localStorage.getItem("2048-infinite:guest-game:v1")).not.toBeNull());
    await act(async () => {
      await new Promise((r) => setTimeout(r, 20));
    });
    const savedBefore = window.localStorage.getItem("2048-infinite:guest-game:v1");
    first.unmount();
    render(
      <AppProvider skipBootstrap>
        <App />
      </AppProvider>,
    );
    await screen.findByTestId("board");
    expect(window.localStorage.getItem("2048-infinite:guest-game:v1")).toBe(savedBefore);
  });

  it("shows an actionable error state with retry when the server is unreachable", async () => {
    window.location.hash = "#/leaderboards";
    const api = client(() => {
      throw new TypeError("fetch failed");
    });
    render(
      <AppProvider client={api} skipBootstrap>
        <App />
      </AppProvider>,
    );
    expect(await screen.findByText("Cannot reach the game server")).toBeTruthy();
    expect(screen.getByRole("button", { name: "Try again" })).toBeTruthy();
    expect(screen.queryByRole("table")).toBeNull(); // no fake rankings
  });

  it("shows an honest empty state for leaderboards and exact high scores when present", async () => {
    window.location.hash = "#/leaderboards";
    let rows: unknown[] = [];
    const api = client(() => jsonResponse({ items: rows, nextCursor: null }));
    const view = render(
      <AppProvider client={api} skipBootstrap>
        <App />
      </AppProvider>,
    );
    expect(await screen.findByText("No results yet")).toBeTruthy();
    view.unmount();
    rows = [{ rank: 1, accountId: "a", displayName: "Zed", score: "18014398509481985", maxExponent: "4096", createdAt: "2026-01-01T00:00:00Z" }];
    render(
      <AppProvider client={api} skipBootstrap>
        <App />
      </AppProvider>,
    );
    const cell = await screen.findByTitle("18014398509481985");
    expect(cell.textContent?.replace(/\s/g, "")).toBe("18014398509481985");
    expect(screen.getByText("2^4096")).toBeTruthy();
  });

  it("locks account-only screens for guests instead of faking them", async () => {
    window.location.hash = "#/challenges";
    render(
      <AppProvider skipBootstrap>
        <App />
      </AppProvider>,
    );
    expect(await screen.findByText("Ranked play needs a local account")).toBeTruthy();
  });

  it("lists challenges for a signed-in user and starts an official attempt", async () => {
    window.location.hash = "#/challenges/c1";
    const challenge: Challenge = { id: "c1", seasonId: "s1", rulesetVersion: "ranked-v1", title: "Daily 1", moveCap: 500, status: "open" };
    const seen: string[] = [];
    const api = client((url, init) => {
      seen.push(`${init.method} ${url}`);
      if (url.endsWith("/challenges")) return jsonResponse([challenge]);
      return jsonResponse({ error: { code: "NOT_FOUND", message: "no game", requestId: "r" } }, 404);
    });
    render(
      <AppProvider client={api} initialIdentity={user} skipBootstrap>
        <App />
      </AppProvider>,
    );
    const start = await screen.findByRole("button", { name: "Start official attempt" });
    fireEvent.click(start);
    await waitFor(() => expect(seen).toContain("POST /api/v1/challenges/c1/attempts"));
    expect(await screen.findByRole("alert")).toBeTruthy();
  });

  it("validates practice settings inline and starts a local custom game", async () => {
    window.location.hash = "#/practice";
    render(
      <AppProvider skipBootstrap>
        <App />
      </AppProvider>,
    );
    const u = userEvent.setup();
    const size = screen.getByLabelText("Board size");
    await u.clear(size);
    await u.type(size, "9");
    await u.click(screen.getByRole("button", { name: "Start practice" }));
    expect((await screen.findAllByRole("alert")).some((n) => /3 to 8/.test(n.textContent ?? ""))).toBe(true);
    await u.clear(size);
    await u.type(size, "5");
    await u.click(screen.getByRole("button", { name: "Start practice" }));
    await waitFor(() => expect(window.location.hash.startsWith("#/play")).toBe(true));
    await waitFor(() => expect(document.querySelectorAll(".board-cell").length).toBe(25));
  });
});

describe("replay", () => {
  function buildReplay(seed: string, moveCount: number): ReplayView {
    const initial = engine.newGame(CLASSIC_RULES, seed);
    const directions = ["left", "up", "right", "down"] as const;
    let state = initial;
    const moves: ReplayView["moves"] = [];
    const snapshots: ReplayView["snapshots"] = [];
    for (let i = 0; i < moveCount; i++) {
      let direction = directions[i % 4] as "left";
      let result = engine.applyMove(state, direction, CLASSIC_RULES);
      for (let k = 1; !result.changed && k < 4; k++) {
        direction = directions[(i + k) % 4] as "left";
        result = engine.applyMove(state, direction, CLASSIC_RULES);
      }
      if (!result.changed) break;
      state = result.state;
      moves.push({ sequence: state.revision, direction, checksum: engine.stateChecksum(state) });
      if (moves.length % 10 === 0) snapshots.push({ sequence: state.revision, checksum: engine.stateChecksum(state), state });
    }
    return {
      schemaVersion: 1,
      engineVersion: initial.engineVersion,
      rulesetVersion: CLASSIC_RULES.version,
      ruleset: CLASSIC_RULES,
      seed,
      moves,
      snapshots,
      finalChecksum: engine.stateChecksum(state),
      finalScore: state.score,
      undoMarkers: [],
    };
  }

  it("seeks to any position and reproduces recorded checksums, using snapshots", () => {
    const replay = buildReplay("replay-seed", 45);
    expect(replay.moves.length).toBeGreaterThan(20);
    const seeker = new ReplaySeeker(replay);
    for (const n of [0, 1, 17, 44 > replay.moves.length ? replay.moves.length : 44, replay.moves.length, 5, 31]) {
      const position = seeker.at(n);
      if (n > 0) expect(position.checksum).toBe(seeker.expectedChecksum(n));
    }
    expect(seeker.at(replay.moves.length).state.score).toBe(replay.finalScore);
    expect(seeker.at(replay.moves.length).checksum).toBe(replay.finalChecksum);
  });

  it("explains merges and rejects malformed, oversize or unsupported documents", () => {
    const lines = describeEvents([
      { type: "move", from: 1, to: 0, exponent: "1" },
      { type: "merge", sources: [0, 1], to: 0, exponent: "2", value: "4" },
      { type: "spawn", index: 7, exponent: "1" },
    ]);
    expect(lines.join(" ")).toMatch(/Two 2 tiles merged into 4 \(\+4 points\)/);
    expect(() => parseReplayDocument("not json")).toThrow(/valid JSON/);
    expect(() => parseReplayDocument(JSON.stringify({ schemaVersion: 2 }))).toThrow(/not supported/);
    expect(() => parseReplayDocument(JSON.stringify({ schemaVersion: 1, seed: "x", ruleset: {}, moves: [{ direction: "diagonal" }] }))).toThrow(/invalid move/);
    expect(() => parseReplayDocument("x".repeat(9 * 1024 * 1024))).toThrow(/too large/);
    const ok = buildReplay("ok", 5);
    expect(parseReplayDocument(JSON.stringify(ok)).moves.length).toBe(ok.moves.length);
  });

  it("drives the player controls", async () => {
    const replay = buildReplay("player-seed", 12);
    const { ReplayPlayer } = await import("../src/screens/Replay.tsx");
    render(
      <AppProvider skipBootstrap>
        <ReplayPlayer replay={replay} />
      </AppProvider>,
    );
    const u = userEvent.setup();
    expect(screen.getByText("Initial position")).toBeTruthy();
    await u.click(screen.getByRole("button", { name: "Step" }));
    expect(screen.getByText(/^Move 1:/)).toBeTruthy();
    await u.click(screen.getByRole("button", { name: "End" }));
    expect(screen.getByText(new RegExp(`^Move ${replay.moves.length}:`))).toBeTruthy();
    expect(screen.getByText(/Checksum: matches the recorded value/)).toBeTruthy();
    await u.click(screen.getByRole("button", { name: "Start" }));
    expect(screen.getByText("Initial position")).toBeTruthy();
    vi.useRealTimers();
  });
});
