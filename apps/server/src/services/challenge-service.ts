import { randomUUID } from "node:crypto";
import type { DatabaseSync } from "node:sqlite";
import {
  RULESETS,
  type ChallengeSummary,
  type GameResponse,
  type GameState,
  type Page,
} from "@g2048/contracts";
import {
  buildChallengeCatalog,
  newChallengeAttempt,
  reduceChallengeAttempt,
  type ChallengeAttemptState,
} from "@g2048/competition";
import { competitionRepo, type AttemptRow, type ChallengeRow, type GameRecord } from "@g2048/database";
import { maxExponent } from "@g2048/engine";
import { AppError } from "../http/errors.js";
import type { ServiceContext } from "./context.js";
import { nowIso } from "./context.js";
import type { GameService, TerminalReason } from "./game-service.js";
import type { Identity, UserIdentity } from "./identity.js";

/**
 * First boot creates one active season per competitive ruleset (CONTRACT-001 C18): `s1` for ranked
 * challenges (ranked-v1) and `duel-s1` for the human duel Elo ladder (duel-v1). Other services read
 * these rows; they never create seasons.
 */
export const DEFAULT_SEASON_ID = "s1";
export const DEFAULT_SEASON_NAME = "Season 1";
export const DEFAULT_DUEL_SEASON_ID = "duel-s1";
export const DEFAULT_DUEL_SEASON_NAME = "Duel season 1";
export const DEFAULT_CHALLENGE_COUNT = 10;

export type AttemptResponse = GameResponse & {
  attempt: { challengeId: string; status: "in-progress" | "completed" | "forfeited"; gameId: string };
};

function attemptState(
  challenge: ChallengeRow,
  userId: string,
  attempt: AttemptRow | null,
): ChallengeAttemptState {
  const fresh = newChallengeAttempt({
    challengeId: challenge.id,
    accountId: userId,
    moveCap: challenge.moveCap,
  });
  if (!attempt) return fresh;
  return { ...fresh, status: attempt.status, gameId: attempt.gameId };
}

/**
 * Ranked challenges (RANK-01/02). One official attempt per account and challenge, decided by the
 * pure competition reducer; the ranked game is created through GameService.createInTransaction with
 * the catalog seed and ranked-v1 rules. The attempt is finalized by a terminal listener inside the
 * SAME transaction as the move/forfeit that ends the game, from the server-derived final state.
 */
export class ChallengeService {
  readonly #ctx: ServiceContext;
  readonly #games: GameService;

  constructor(ctx: ServiceContext, games: GameService) {
    this.#ctx = ctx;
    this.#games = games;
    games.onTerminal((db, game, finalState, reason) => this.#finalize(db, game, finalState, reason));
  }

  /**
   * Idempotent boot step: ensures the active ranked + duel seasons and the challenge catalog exist.
   * Runs inside the caller's transaction (boot runs it directly, before requests are accepted).
   */
  ensureCatalogInTransaction(db: DatabaseSync): { season: string; duelSeason: string; inserted: number } {
    {
      const now = nowIso(this.#ctx);
      const ranked = RULESETS["ranked-v1"].version;
      const duel = RULESETS["duel-v1"].version;
      if (!competitionRepo.activeSeason(db, ranked) && !competitionRepo.getSeason(db, DEFAULT_SEASON_ID)) {
        competitionRepo.insertSeason(db, {
          id: DEFAULT_SEASON_ID,
          rulesetVersion: ranked,
          name: DEFAULT_SEASON_NAME,
          now,
        });
      }
      if (!competitionRepo.activeSeason(db, duel) && !competitionRepo.getSeason(db, DEFAULT_DUEL_SEASON_ID)) {
        competitionRepo.insertSeason(db, {
          id: DEFAULT_DUEL_SEASON_ID,
          rulesetVersion: duel,
          name: DEFAULT_DUEL_SEASON_NAME,
          now,
        });
      }
      const season = competitionRepo.activeSeason(db, ranked);
      const duelSeason = competitionRepo.activeSeason(db, duel);
      if (!duelSeason) throw new Error("no active duel season after seeding");
      if (!season) throw new Error("no active season after seeding");
      let inserted = 0;
      for (const def of buildChallengeCatalog(season.id, DEFAULT_CHALLENGE_COUNT)) {
        if (
          competitionRepo.insertChallengeIfMissing(db, {
            id: def.id,
            seasonId: def.season,
            rulesetVersion: def.rulesetVersion,
            seed: def.seed,
            moveCap: def.moveCap,
            now,
          })
        ) {
          inserted += 1;
        }
      }
      return { season: season.id, duelSeason: duelSeason.id, inserted };
    }
  }

  list(identity: Identity): Page<ChallengeSummary> {
    const { db } = this.#ctx;
    const mine = new Map<string, AttemptRow>();
    if (identity.kind === "user") {
      for (const a of competitionRepo.attemptsForUser(db, identity.user.id)) mine.set(a.challengeId, a);
    }
    const items = competitionRepo.listChallenges(db).map((c): ChallengeSummary => {
      const attempt = mine.get(c.id);
      return {
        id: c.id,
        season: c.seasonId,
        rulesetVersion: c.rulesetVersion,
        moveCap: c.moveCap,
        status: this.#isOpen(db, c) ? "open" : "closed",
        myAttempt: attempt ? { status: attempt.status, gameId: attempt.gameId } : null,
      };
    });
    return { items, nextCursor: null };
  }

  /** Starts the caller's official attempt, or resumes the in-progress one. 201 when started. */
  async startOrResume(
    identity: Identity,
    challengeId: string,
  ): Promise<{ started: boolean; response: AttemptResponse }> {
    // C17: anyone who is not a local account (guest or anonymous) gets 403; no guest is created here.
    if (identity.kind !== "user") {
      throw new AppError("FORBIDDEN", "Ranked challenges require a local account; guests can play practice");
    }
    const user: UserIdentity = identity;
    return this.#ctx.writer.run((db) => {
      const challenge = competitionRepo.getChallenge(db, challengeId);
      if (!challenge) throw new AppError("NOT_FOUND", "Challenge not found");
      const existing = competitionRepo.attemptFor(db, challenge.id, user.user.id);
      const gameId = randomUUID();
      const transition = reduceChallengeAttempt(attemptState(challenge, user.user.id, existing), {
        type: "start-or-resume",
        challengeOpen: this.#isOpen(db, challenge),
        gameId,
      });
      const started = transition.events.some((e) => e.type === "attempt.started");
      if (started) {
        // Official rules come only from the catalog: ranked-v1 and the challenge seed (RANK-02).
        this.#games.createInTransaction(
          db,
          { userId: user.user.id },
          {
            mode: "ranked",
            rules: RULESETS["ranked-v1"],
            seed: challenge.seed,
            id: gameId,
          },
        );
        competitionRepo.insertAttempt(db, {
          id: randomUUID(),
          challengeId: challenge.id,
          userId: user.user.id,
          gameId,
          now: nowIso(this.#ctx),
        });
      }
      const officialGameId = transition.state.gameId as string;
      const game = this.#games.readInTransaction(db, officialGameId, {
        owner: { userId: user.user.id },
        allowedModes: ["ranked"],
      });
      return {
        started,
        response: {
          ...game,
          attempt: { challengeId: challenge.id, status: "in-progress", gameId: officialGameId },
        },
      };
    });
  }

  #isOpen(db: DatabaseSync, challenge: ChallengeRow): boolean {
    if (challenge.status !== "open") return false;
    return competitionRepo.getSeason(db, challenge.seasonId)?.status === "active";
  }

  /** Terminal listener: completes or forfeits the official attempt from the server's final state. */
  #finalize(db: DatabaseSync, game: GameRecord, finalState: GameState, reason: TerminalReason): void {
    if (game.mode !== "ranked") return;
    const attempt = competitionRepo.attemptByGame(db, game.id);
    if (!attempt || attempt.status !== "in-progress") return;
    const challenge = competitionRepo.getChallenge(db, attempt.challengeId);
    if (!challenge) return;
    const values = {
      score: finalState.score,
      maxExponent: maxExponent(finalState.board),
      acceptedMoves: finalState.acceptedMoves,
    };
    const transition = reduceChallengeAttempt(
      attemptState(challenge, attempt.userId, attempt),
      reason === "forfeit" ? { type: "forfeit", ...values } : { type: "complete", reason, ...values },
    );
    const result = transition.state.result;
    if (!result) return;
    competitionRepo.finishAttempt(db, attempt.id, {
      status: transition.state.status === "forfeited" ? "forfeited" : "completed",
      score: result.score,
      maxExponent: result.maxExponent,
      now: nowIso(this.#ctx),
    });
  }
}
