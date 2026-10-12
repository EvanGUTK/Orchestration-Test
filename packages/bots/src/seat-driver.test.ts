import { RULESETS } from "@g2048/contracts";
import type { BotConfig, GameState, RandomState, SeatId } from "@g2048/contracts";
import { computeBotLeague, createMatch, reduceMatch } from "@g2048/competition";
import type { MatchState, Participant } from "@g2048/competition";
import { describe, expect, it } from "vitest";
import { BotError, deriveBotRng } from "./choose-move.js";
import { engineAdapter } from "./engine-adapter.js";
import { leagueGamesFromTournament } from "./league.js";
import { runTournament } from "./play.js";
import { nextBotSeatAction, planBotSeat } from "./seat-driver.js";

const rules = RULESETS["duel-v1"];
const greedyBot: Participant = { kind: "bot", strategy: "greedy-v1", botVersion: "bots-1.1.0" };
const expectimaxBot: Participant = { kind: "bot", strategy: "expectimax-v1", botVersion: "bots-1.1.0" };
const greedy: BotConfig = { strategy: "greedy-v1", nodeBudget: 4, timeBudgetMs: 1000 };
const expectimax: BotConfig = { strategy: "expectimax-v1", nodeBudget: 300, timeBudgetMs: 1000 };

function activeMatch(kind: "human-bot" | "bot-bot", a: Participant, b: Participant): MatchState {
  const created = createMatch({ id: `m-${kind}`, kind, season: "s1", creator: a }).state;
  return reduceMatch(created, { type: "join", participant: b }).state;
}

/** Drives every bot seat of a match to completion through the pure seat driver + match reducer. */
function driveBots(
  match: MatchState,
  configs: Partial<Record<SeatId, BotConfig>>,
  seed: string,
): { match: MatchState; games: Record<SeatId, GameState> } {
  const games: Record<SeatId, GameState> = {
    a: engineAdapter.newGame(rules, seed),
    b: engineAdapter.newGame(rules, seed),
  };
  const rngs: Record<SeatId, RandomState> = {
    a: deriveBotRng(engineAdapter, seed),
    b: deriveBotRng(engineAdapter, seed),
  };
  let m = match;
  // Alternate seats one action at a time, as a server would interleave independent seats.
  for (let guard = 0; guard < 5000; guard += 1) {
    let progressed = false;
    for (const seat of ["a", "b"] as const) {
      const config = configs[seat];
      if (config === undefined) continue;
      const action = nextBotSeatAction({
        match: m,
        seat,
        game: games[seat],
        rules,
        config,
        botRng: rngs[seat],
      });
      if (action.kind === "move") {
        games[seat] = engineAdapter.applyMove(games[seat], action.direction, rules).state;
        rngs[seat] = action.rng;
        progressed = true;
      } else if (action.kind === "terminal") {
        m = reduceMatch(m, action.command).state;
        progressed = true;
      }
    }
    if (!progressed) break;
  }
  return { match: m, games };
}

describe("planBotSeat / nextBotSeatAction", () => {
  it("bot-vs-bot match runs to finished with a duel outcome and no human Elo", () => {
    const start = activeMatch("bot-bot", expectimaxBot, greedyBot);
    const { match, games } = driveBots(start, { a: expectimax, b: greedy }, "bot-duel-1");
    expect(match.seats.a.terminal).not.toBeNull();
    expect(match.seats.b.terminal).not.toBeNull();
    expect(match.seats.a.score).toBe(games.a.score);
    const finished = reduceMatch(match, { type: "finish" }).state;
    expect(finished.status).toBe("finished");
    expect(finished.ratingEvents).toEqual([]);
    expect(["seat-a", "seat-b", "draw"]).toContain(finished.outcome);
    expect(() => reduceMatch(match, { type: "finish", ratings: { a: 1000, b: 1000 } })).toThrow(
      expect.objectContaining({ code: "RATINGS_FORBIDDEN" }),
    );
  }, 60_000);

  it("a human seat is never driven and never blocks the bot seat (dead seat keeps the other going)", () => {
    const human: Participant = { kind: "human", accountId: "alice" };
    let m = activeMatch("human-bot", human, greedyBot);
    // The human's board dies early; the bot seat still plays to its own end.
    m = reduceMatch(m, {
      type: "seat-terminal",
      seat: "a",
      reason: "dead-board",
      score: "64",
      maxExponent: "4",
      acceptedMoves: 12,
    }).state;
    const { match, games } = driveBots(m, { b: greedy }, "human-bot-1");
    expect(match.seats.b.terminal).not.toBeNull();
    expect(match.seats.b.acceptedMoves).toBe(games.b.acceptedMoves);
    expect(() => planBotSeat(match, "a", games.a)).toThrow(BotError);
  });

  it("is idle while the human seat is still playing and the bot seat has ended", () => {
    const human: Participant = { kind: "human", accountId: "alice" };
    const { match, games } = driveBots(activeMatch("human-bot", human, greedyBot), { b: greedy }, "idle-1");
    expect(match.status).toBe("active"); // waiting for the human; no timeout ends the match
    expect(planBotSeat(match, "b", games.b)).toEqual({ kind: "idle", reason: "seat-terminal" });
    expect(match.seats.a.terminal).toBeNull();
  });

  it("maps finished seat games to the right terminal command", () => {
    const m = activeMatch("bot-bot", greedyBot, greedyBot);
    const g = engineAdapter.newGame(rules, "x");
    expect(planBotSeat(m, "a", g)).toEqual({ kind: "decide" });
    const capped: GameState = { ...g, acceptedMoves: 500, status: "completed" };
    expect(planBotSeat(m, "a", capped)).toMatchObject({
      kind: "terminal",
      command: { reason: "move-cap", acceptedMoves: 500 },
    });
    const forfeited: GameState = { ...g, status: "forfeited", acceptedMoves: 3 };
    expect(planBotSeat(m, "a", forfeited)).toMatchObject({
      kind: "terminal",
      command: { reason: "forfeit" },
    });
    const dead: GameState = {
      ...g,
      status: "completed",
      acceptedMoves: 77,
      board: {
        size: 4,
        cells: ["1", "2", "1", "2", "2", "1", "2", "1", "1", "2", "1", "2", "2", "1", "2", "1"],
      },
    };
    expect(planBotSeat(m, "b", dead)).toMatchObject({
      kind: "terminal",
      command: { seat: "b", reason: "dead-board", maxExponent: "2", acceptedMoves: 77 },
    });
    expect(
      planBotSeat(
        reduceMatch(m, {
          type: "seat-terminal",
          seat: "a",
          reason: "forfeit",
          score: "0",
          maxExponent: null,
          acceptedMoves: 0,
        }).state,
        "a",
        g,
      ),
    ).toEqual({
      kind: "idle",
      reason: "seat-terminal",
    });
  });

  it("is idle outside an active match and rejects mismatched rulesets", () => {
    const lobby = createMatch({ id: "l", kind: "bot-bot", season: "s1", creator: greedyBot }).state;
    expect(planBotSeat(lobby, "a", engineAdapter.newGame(rules, "x"))).toEqual({
      kind: "idle",
      reason: "match-not-active",
    });
    const m = activeMatch("bot-bot", greedyBot, greedyBot);
    expect(() => planBotSeat(m, "a", engineAdapter.newGame(RULESETS["classic-v1"], "x"))).toThrow(BotError);
    expect(() => planBotSeat(m, "c" as SeatId, engineAdapter.newGame(rules, "x"))).toThrow(BotError);
  });
});

describe("bot league from tournaments", () => {
  it("feeds tournament results into computeBotLeague deterministically", () => {
    const t = runTournament(engineAdapter, {
      seeds: ["lg-1", "lg-2"],
      pairings: [
        { a: expectimax, b: { strategy: "random-v1", nodeBudget: 1, timeBudgetMs: 1000 } },
        { a: greedy, b: expectimax },
      ],
    });
    const league = computeBotLeague(leagueGamesFromTournament(t));
    expect(league).toEqual(computeBotLeague(leagueGamesFromTournament(t)));
    expect(league[0]?.key).toBe("expectimax-v1@bots-1.1.0/300");
    expect(league.reduce((n, r) => n + r.played, 0)).toBe(8);
    expect(league.find((r) => r.strategy === "random-v1")).toMatchObject({ won: 0, lost: 2 });
  }, 60_000);
});
