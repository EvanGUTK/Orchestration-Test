import type { BotLeagueGame, BotLeagueSeat } from "@g2048/competition";
import type { TournamentResult, TournamentSeat } from "./play.js";

/** Converts tournament games into computeBotLeague input (bot-league scope only). */
export function leagueGamesFromTournament(result: TournamentResult): BotLeagueGame[] {
  const seat = (s: TournamentSeat): BotLeagueSeat => ({
    kind: "bot",
    strategy: s.strategy,
    botVersion: result.botVersion,
    nodeBudget: s.nodeBudget,
    score: s.score,
    maxExponent: s.maxExponent,
  });
  return result.games.map((g) => ({ a: seat(g.a), b: seat(g.b), outcome: g.outcome }));
}
