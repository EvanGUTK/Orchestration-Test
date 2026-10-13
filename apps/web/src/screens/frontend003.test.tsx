import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, fireEvent, render, screen, within } from "@testing-library/react";
import { RULESETS } from "@g2048/contracts";
import type { ChallengeSummary, Direction, GameResponse, LeaderboardEntry, Page } from "@g2048/contracts";
import { App } from "../App.js";
import { ApiError } from "../api/client.js";
import { createAppServices } from "../app/create-services.js";
import type { ServiceOptions } from "../app/create-services.js";
import { localEngine } from "../game/local-engine.js";
import { silentSoundPlayer } from "../lib/sound.js";
import { buildReplayFile } from "../replay/replay.js";
import { apiRankingSource, isUnavailable, leaderboardQueryString } from "../ranking/source.js";
import type { LeaderboardFilters, RankingSource } from "../ranking/source.js";
import { memoryStorage } from "../test/fake-engine.js";
import { ADA, createFakeServer } from "../test/fake-server.js";
import { inlineDecisionService } from "../test/inline-decisions.js";

async function go(path: string) {
  await act(async () => {
    window.location.hash = `#${path}`;
    window.dispatchEvent(new HashChangeEvent("hashchange"));
  });
}
const flush = () => act(async () => new Promise((r) => setTimeout(r, 0)));

async function boot(options: Partial<ServiceOptions> = {}, signedIn = false) {
  const server = createFakeServer({ user: signedIn ? ADA : null });
  const services = createAppServices({
    engine: localEngine,
    storage: memoryStorage(),
    sound: silentSoundPlayer,
    fetch: (i, init) => server.fetch(i, init),
    sleep: () => Promise.resolve(),
    retryDelays: [1],
    settingsDebounceMs: 0,
    ...options,
  });
  render(<App services={services} />);
  await act(async () => {
    await services.auth.refresh();
  });
  return { services, server };
}

const notFound = () => Promise.reject(new ApiError("NOT_FOUND", "Not found", 404, null));
const BIG = "123456789012345678901234567890123456789"; // 39 digits: beyond any float

function entry(rank: number, patch: Partial<LeaderboardEntry> = {}): LeaderboardEntry {
  return {
    rank,
    accountId: `acc-${rank}`,
    displayName: `Player ${rank}`,
    botStrategy: null,
    score: String(10_000 - rank),
    maxExponent: "11",
    rating: null,
    gameId: `g-${rank}`,
    createdAt: "2026-10-12T00:00:00.000Z",
    ...patch,
  };
}

function fakeRanking(overrides: Partial<RankingSource> = {}) {
  const calls: Array<{ filters: LeaderboardFilters; cursor: string | null }> = [];
  const source: RankingSource = {
    leaderboard: async (filters, cursor) => {
      calls.push({ filters, cursor });
      return cursor === null
        ? { items: [entry(1, { score: BIG, maxExponent: "4096" }), entry(2)], nextCursor: "c2" }
        : { items: [entry(3, { accountId: null, displayName: "Former player" })], nextCursor: null };
    },
    challenges: notFound,
    startAttempt: notFound,
    ...overrides,
  };
  return { source, calls };
}

beforeEach(() => {
  window.location.hash = "";
});
afterEach(cleanup);

describe("ranking source (contract-first)", () => {
  it("builds LeaderboardQuery strings with only the set filters and the cursor", () => {
    expect(leaderboardQueryString({ scope: "challenge", challenge: " c-1 ", season: "" }, "abc", 25)).toBe(
      "scope=challenge&limit=25&challenge=c-1&cursor=abc",
    );
  });

  it("calls the CONTRACT-001 endpoints and treats only 404 NOT_FOUND as 'not available yet'", async () => {
    const seen: string[] = [];
    const server = createFakeServer({ user: ADA });
    const api = createAppServices({
      engine: localEngine,
      storage: memoryStorage(),
      sound: silentSoundPlayer,
      fetch: (i, init) => {
        seen.push(`${init?.method ?? "GET"} ${i}`);
        return server.fetch(i, init);
      },
    }).api;
    const source = apiRankingSource(api);
    const failure = await source.leaderboard({ scope: "duel-elo" }, null).catch((e: unknown) => e);
    expect(isUnavailable(failure)).toBe(true);
    await source.challenges("next").catch(() => undefined);
    await source.startAttempt("weekly/1").catch(() => undefined);
    expect(seen).toContain("GET /api/v1/leaderboards?scope=duel-elo&limit=25");
    expect(seen).toContain("GET /api/v1/challenges?cursor=next");
    expect(seen).toContain("POST /api/v1/challenges/weekly%2F1/attempts");
    expect(isUnavailable(new ApiError("NETWORK_ERROR", "x", 0, null))).toBe(false);
  });
});

describe("Leaderboards screen", () => {
  it("shows exact decimal scores, separate scopes, filters and cursor pagination", async () => {
    const { source, calls } = fakeRanking();
    await boot({ ranking: source });
    await go("/leaderboards");
    await flush();
    const table = screen.getByRole("table");
    expect(within(table).getByText("Player 1")).toBeTruthy();
    // The 39-digit score is never rounded: the exact value is kept for title and screen readers.
    expect(table.innerHTML).toContain(BIG);
    expect(calls[0]).toEqual({ filters: { scope: "casual" }, cursor: null });

    fireEvent.click(screen.getByRole("button", { name: "Load more" }));
    await flush();
    expect(calls[1]!.cursor).toBe("c2");
    expect(screen.getByText("Former player")).toBeTruthy();
    expect(screen.getByText(/deleted account/)).toBeTruthy();
    expect(screen.queryByRole("button", { name: "Load more" })).toBeNull();

    fireEvent.click(screen.getByRole("tab", { name: "Challenges" }));
    await flush();
    fireEvent.change(screen.getByLabelText("Challenge ID"), { target: { value: "weekly-1" } });
    fireEvent.change(screen.getByLabelText("Ruleset"), { target: { value: "ranked-v1" } });
    fireEvent.click(screen.getByRole("button", { name: "Apply filters" }));
    await flush();
    expect(calls.at(-1)!.filters).toMatchObject({
      scope: "challenge",
      challenge: "weekly-1",
      ruleset: "ranked-v1",
    });
  });

  it("shows ratings for duel Elo and a bot badge, never mixing people and bots", async () => {
    const { source } = fakeRanking({
      leaderboard: async (filters) => ({
        items:
          filters.scope === "duel-elo"
            ? [entry(1, { score: null, maxExponent: null, rating: 1024 })]
            : [entry(1, { displayName: "Expectimax", accountId: null, botStrategy: "expectimax-v1" })],
        nextCursor: null,
      }),
    });
    await boot({ ranking: source });
    await go("/leaderboards");
    fireEvent.click(screen.getByRole("tab", { name: "Duel Elo" }));
    await flush();
    expect(screen.getByRole("columnheader", { name: "Rating" })).toBeTruthy();
    expect(screen.getByRole("cell", { name: "1024" })).toBeTruthy();
    fireEvent.click(screen.getByRole("tab", { name: "Bot league" }));
    await flush();
    expect(screen.getByText(/bot · expectimax-v1/)).toBeTruthy();
    expect(screen.queryByText(/deleted account/)).toBeNull();
  });

  it("has honest empty, unavailable (404) and error-with-retry states", async () => {
    let mode: "empty" | "404" | "error" = "404";
    const leaderboard = vi.fn(async (): Promise<Page<LeaderboardEntry>> => {
      if (mode === "404") throw new ApiError("NOT_FOUND", "Not found", 404, null);
      if (mode === "error") throw new ApiError("DB_BUSY", "busy", 503, null);
      return { items: [], nextCursor: null };
    });
    await boot({ ranking: fakeRanking({ leaderboard }).source });
    await go("/leaderboards");
    await flush();
    expect(screen.getByText("Not available yet")).toBeTruthy();
    expect(screen.queryByRole("table")).toBeNull();

    mode = "error";
    fireEvent.click(screen.getByRole("tab", { name: "Duel Elo" }));
    await flush();
    expect(screen.getByRole("alert").textContent).toMatch(/Couldn't load standings/);
    mode = "empty";
    fireEvent.click(screen.getByRole("button", { name: "Try again" }));
    await flush();
    expect(screen.getByText("No results for these filters yet.")).toBeTruthy();
  });
});

describe("Challenges screen", () => {
  const challenge: ChallengeSummary = {
    id: "weekly-1",
    season: "2026-10",
    rulesetVersion: "ranked-v1",
    moveCap: 500,
    status: "open",
    myAttempt: null,
  };

  it("shows 'not available yet' on 404, with no simulated challenges", async () => {
    await boot({ ranking: fakeRanking().source });
    await go("/challenges");
    await flush();
    expect(screen.getByText("Not available yet")).toBeTruthy();
    expect(screen.queryByText(/weekly/)).toBeNull();
  });

  it("asks guests to sign in instead of offering an attempt", async () => {
    const challenges = async () => ({ items: [challenge], nextCursor: null });
    await boot({ ranking: fakeRanking({ challenges }).source });
    await go("/challenges");
    await flush();
    expect(screen.getByText(/Guests can't enter ranked challenges/)).toBeTruthy();
    expect(screen.queryByRole("button", { name: /attempt/ })).toBeNull();
  });

  it("confirms, starts the official attempt and opens it on the play screen", async () => {
    const state = localEngine.newGame(RULESETS["ranked-v1"], "weekly-seed");
    const response: GameResponse = {
      game: {
        id: "ranked-game-1",
        mode: "ranked",
        rulesetVersion: "ranked-v1",
        status: "active",
        score: "0",
        maxExponent: null,
        acceptedMoves: 0,
        revision: 0,
        createdAt: "2026-10-12T00:00:00.000Z",
        updatedAt: "2026-10-12T00:00:00.000Z",
      },
      state,
      canUndo: false,
    };
    const startAttempt = vi.fn(async () => response);
    const challenges = async () => ({ items: [challenge], nextCursor: null });
    const { services } = await boot({ ranking: fakeRanking({ challenges, startAttempt }).source }, true);
    await go("/challenges");
    await flush();
    fireEvent.click(screen.getByRole("button", { name: "Start attempt…" }));
    expect(startAttempt).not.toHaveBeenCalled();
    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: "Confirm: start official attempt" }));
    });
    await flush();
    expect(startAttempt).toHaveBeenCalledWith("weekly-1");
    expect(window.location.hash).toBe("#/play");
    expect(services.serverGame.getSnapshot().session?.id).toBe("ranked-game-1");
  });

  it("explains a used attempt (403) without losing the list", async () => {
    const challenges = async () => ({ items: [challenge], nextCursor: null });
    const startAttempt = () => Promise.reject(new ApiError("FORBIDDEN", "forbidden", 403, null));
    await boot({ ranking: fakeRanking({ challenges, startAttempt }).source }, true);
    await go("/challenges");
    await flush();
    fireEvent.click(screen.getByRole("button", { name: "Start attempt…" }));
    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: "Confirm: start official attempt" }));
    });
    expect(screen.getByRole("alert").textContent).toMatch(/already used your official attempt/);
    expect(screen.getByText(/Challenge weekly-1/)).toBeTruthy();
  });
});

function replayText(moves = 70) {
  const rules = RULESETS["classic-v1"];
  const initial = localEngine.newGame(rules, "screen-replay");
  const dirs: Direction[] = [];
  let state = initial;
  while (dirs.length < moves && state.status === "active") {
    const legal = localEngine.legalMoves(state.board);
    const d = (["left", "down", "right", "up"] as const).find((x) => legal.includes(x))!;
    state = localEngine.applyMove(state, d, rules).state;
    dirs.push(d);
  }
  const file = buildReplayFile(
    localEngine,
    { mode: "classic", rules, seed: "screen-replay", initial, moves: dirs },
    { displayName: null, createdAt: "2026-10-12T00:00:00.000Z" },
  );
  return { file, text: JSON.stringify(file), state };
}

async function importFile(content: string, name = "replay.json") {
  const input = screen.getByLabelText("Replay file (.json)");
  await act(async () => {
    fireEvent.change(input, { target: { files: [new File([content], name, { type: "application/json" })] } });
  });
  await flush();
}

describe("Replays screen", () => {
  it("rejects a corrupt import with an actionable message and installs nothing", async () => {
    const { file } = replayText(10);
    const moves = file.moves.map((m, i) => (i === 4 ? { ...m, checksum: "0".repeat(64) } : m));
    await boot();
    await go("/replays");
    await importFile(JSON.stringify({ ...file, moves }), "edited.json");
    const alert = screen.getByRole("alert");
    expect(alert.textContent).toMatch(/Can't open “edited.json”/);
    expect(alert.textContent).toMatch(/corrupt or was edited/);
    expect(within(alert).getByRole("button", { name: "Choose another file" })).toBeTruthy();
    expect(screen.queryByText("Verified by the engine")).toBeNull();
  });

  it("rejects unsupported versions and non-replay files", async () => {
    const { file } = replayText(5);
    await boot();
    await go("/replays");
    await importFile(JSON.stringify({ ...file, replaySchemaVersion: 7 }));
    expect(screen.getByRole("alert").textContent).toMatch(/version 7 isn't supported/);
    await importFile("{ nope");
    expect(screen.getByRole("alert").textContent).toMatch(/isn't valid JSON/);
  });

  it("plays a verified import: step, back, seek, play/pause, explanations, virtualized move list", async () => {
    vi.useFakeTimers({ toFake: ["setInterval", "clearInterval"] });
    try {
      const { file, text, state } = replayText(70);
      const total = file.moves.length;
      await boot();
      await go("/replays");
      await importFile(text);
      expect(screen.getByText("Verified by the engine")).toBeTruthy();
      expect(screen.getByText(/Imported file/)).toBeTruthy();
      expect(screen.getByText(`0 / ${total}`)).toBeTruthy();

      fireEvent.click(screen.getByRole("button", { name: "Step forward" }));
      expect(screen.getByText(`1 / ${total}`)).toBeTruthy();
      expect(screen.getByRole("heading", { name: /^Move 1: left/ })).toBeTruthy();
      expect(screen.getAllByText(/A new (2|4) appeared at row/).length).toBeGreaterThan(0);
      fireEvent.click(screen.getByRole("button", { name: "Step back" }));
      expect(screen.getByText(`0 / ${total}`)).toBeTruthy();

      fireEvent.change(screen.getByLabelText("Position"), { target: { value: String(total) } });
      expect(screen.getByText(`${total} / ${total}`)).toBeTruthy();
      expect(screen.getByRole("group", { name: "Playback" })).toBeTruthy();
      // The final position shows the exact final score of the original game.
      expect(screen.getAllByText(state.score).length).toBeGreaterThan(0);

      fireEvent.click(screen.getByRole("button", { name: "Go to start" }));
      fireEvent.click(screen.getByRole("button", { name: "Play" }));
      await act(async () => {
        vi.advanceTimersByTime(1500);
      });
      expect(screen.getByText(`3 / ${total}`)).toBeTruthy();
      fireEvent.click(screen.getByRole("button", { name: "Pause" }));
      await act(async () => {
        vi.advanceTimersByTime(5000);
      });
      expect(screen.getByText(`3 / ${total}`)).toBeTruthy();

      const list = screen.getByRole("list", { name: `Moves (${total})` });
      expect(list.querySelectorAll("li").length).toBeLessThan(total);
      fireEvent.click(within(list).getAllByRole("button")[1]!);
      expect(screen.getByText(`2 / ${total}`)).toBeTruthy();
    } finally {
      vi.useRealTimers();
    }
  });

  it("builds, verifies and replays the current guest game", async () => {
    const { services } = await boot();
    await act(async () => {
      await services.localGame!.start({
        mode: "classic",
        rules: RULESETS["classic-v1"],
        seed: "guest-replay",
      });
    });
    for (const d of ["left", "down", "right", "up", "left"] as Direction[]) {
      await act(async () => {
        services.localGame!.move(d);
      });
      await flush();
    }
    const accepted = services.localGame!.getSnapshot().session!.state.acceptedMoves;
    await go("/replays");
    expect(screen.getByText(new RegExp(`^${accepted} accepted moves`))).toBeTruthy();
    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: "Watch replay" }));
    });
    await flush();
    expect(screen.getByText("Verified by the engine")).toBeTruthy();
    expect(screen.getByText(/Local game/)).toBeTruthy();
    expect(screen.getByText(`0 / ${accepted}`)).toBeTruthy();
  });

  it("loads a replay from the server and reports a 404 honestly", async () => {
    await boot({}, true);
    await go("/replays");
    fireEvent.change(screen.getByLabelText("Replay or game ID"), { target: { value: "r-404" } });
    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: "Load from server" }));
    });
    await flush();
    expect(screen.getByRole("alert").textContent).toMatch(/No replay “r-404” is available from this server/);
  });
});

describe("Bot lab screen", () => {
  it("validates budgets against contract limits before running", async () => {
    await boot({ decisions: inlineDecisionService() });
    await go("/bots");
    fireEvent.change(screen.getByLabelText("Node budget per move"), { target: { value: "99999999" } });
    fireEvent.click(screen.getByRole("button", { name: "Set up run" }));
    expect(screen.getByRole("alert").textContent).toMatch(/Node budget must be 1–5,000,000/);
  });

  it("runs a bot in this browser: step shows the chosen move, explanation and nodes; stop ends it", async () => {
    await boot({ decisions: inlineDecisionService() });
    await go("/bots");
    fireEvent.click(screen.getByRole("radio", { name: /Expectimax/ }));
    expect((screen.getByLabelText("Node budget per move") as HTMLInputElement).value).toBe("200000");
    fireEvent.change(screen.getByLabelText("Node budget per move"), { target: { value: "300" } });
    fireEvent.change(screen.getByLabelText("Seed"), { target: { value: "lab-seed" } });
    fireEvent.click(screen.getByRole("button", { name: "Set up run" }));
    expect(screen.getByText(/running in this browser/)).toBeTruthy();
    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: "Step one move" }));
    });
    await flush();
    const decision = screen.getByLabelText("Last decision");
    expect(decision.textContent).toMatch(/Chose (up|right|down|left)/);
    expect(decision.textContent).toMatch(/expectimax/);
    expect(decision.textContent).toMatch(/nodes searched/);
    fireEvent.click(screen.getByRole("button", { name: "Stop" }));
    expect(screen.getByText(/^Stopped$/)).toBeTruthy();
    expect(screen.queryByRole("button", { name: "Step one move" })).toBeNull();
  });

  it("offers the server option only to signed-in accounts and reports a missing endpoint", async () => {
    await boot({ decisions: inlineDecisionService() }, true);
    await go("/bots");
    fireEvent.click(screen.getByRole("radio", { name: "Local server" }));
    fireEvent.click(screen.getByRole("button", { name: "Set up run" }));
    expect(screen.getByText(/running on the server/)).toBeTruthy();
    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: "Run" }));
    });
    await flush();
    expect(screen.getByText(/Bot runs on the server aren't available yet/)).toBeTruthy();
  });
});
