// BOT-04 | Repeatable bot league — same seeds/versions/budgets reproduce outcomes; human Elo unchanged.
// Also checks the RANK-03 separation for bots (bot results only in the bot-league scope).
// Spec-first: POST /bots/runs (CreateBotRunRequest) -> BotRunView; ASSUMPTION: GET /bots/runs/:id returns
// the BotRunView for polling (the HTTP table lists only create/cancel; flagged to chief).
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { BOT_STRATEGIES } from "@g2048/contracts";
import type { BotRunView, BotStrategy, GameResponse, LeaderboardEntry } from "@g2048/contracts";
import { checksum } from "@g2048/engine";
import { createTestApp } from "./helpers/app.js";
import type { TestApp } from "./helpers/app.js";
import { Client } from "./helpers/http.js";

let t: TestApp;
beforeEach(async () => {
  t = await createTestApp();
});
afterEach(async () => {
  await t.close();
});

const TERMINAL = new Set(["finished", "cancelled", "failed"]);

async function runBot(c: Client, strategy: BotStrategy, seed: string, maxMoves = 25): Promise<BotRunView> {
  const created = await c.post<BotRunView>("/bots/runs", {
    strategy,
    // node budget binds; the time budget is generous so wall-clock speed cannot change decisions
    nodeBudget: 400,
    timeBudgetMs: 10_000,
    seed,
    maxMoves,
  });
  expect([200, 201, 202], created.text).toContain(created.status);
  let view = created.json;
  const deadline = Date.now() + 60_000;
  while (!TERMINAL.has(view.status)) {
    if (Date.now() > deadline) throw new Error(`bot run ${view.id} did not finish: ${JSON.stringify(view)}`);
    await new Promise((r) => setTimeout(r, 100));
    const r = await c.get<BotRunView>(`/bots/runs/${view.id}`);
    expect(r.status, r.text).toBe(200);
    view = r.json;
  }
  expect(view.status).toBe("finished");
  return view;
}

const humanRatingRows = () =>
  t.db.prepare("SELECT (SELECT COUNT(*) FROM ratings) AS r, (SELECT COUNT(*) FROM rating_events) AS e").get();

describe("BOT-04 repeatable bot league", () => {
  for (const strategy of BOT_STRATEGIES) {
    it(
      `${strategy}: same seed/version/budget reproduces the identical game`,
      { timeout: 150_000 },
      async () => {
        const c = new Client(t.app);
        await c.signUp(`botfan_${strategy.replace(/[^a-z0-9]/g, "")}`.slice(0, 24));
        const before = humanRatingRows();
        const a = await runBot(c, strategy, "bot04-league");
        const b = await runBot(c, strategy, "bot04-league");
        expect(a.botVersion).toBe(b.botVersion);
        expect(a.movesPlayed).toBe(b.movesPlayed);
        expect(a.movesPlayed).toBeGreaterThan(0);
        const ga = await c.get<GameResponse>(`/games/${a.gameId}`);
        const gb = await c.get<GameResponse>(`/games/${b.gameId}`);
        expect(ga.status, ga.text).toBe(200);
        expect(checksum(gb.json.state)).toBe(checksum(ga.json.state));
        expect(ga.json.game.mode).toBe("bot-exhibition");
        expect(humanRatingRows(), "bot runs never touch human ratings").toEqual(before);
      },
    );
  }

  it(
    "bot results appear only on the bot-league board, never in human/casual scopes",
    { timeout: 150_000 },
    async () => {
      const c = new Client(t.app);
      await c.signUp("league_watcher");
      const run = await runBot(c, "greedy-v1", "bot04-separation", 15);
      const scope = (q: string) => c.get<{ items: LeaderboardEntry[] }>(`/leaderboards?${q}`);
      const league = await scope("scope=bot-league");
      expect(league.status, league.text).toBe(200);
      for (const q of [
        "scope=casual&ruleset=classic-v1",
        "scope=casual&ruleset=bot-v1",
        "scope=challenge",
        "scope=duel-elo",
      ]) {
        const r = await scope(q);
        expect(r.status, `${q}: ${r.text}`).toBe(200);
        expect(
          r.json.items.some((e) => e.gameId === run.gameId || e.botStrategy !== null),
          q,
        ).toBe(false);
      }
      for (const e of league.json.items) expect(e.botStrategy).not.toBeNull();
    },
  );
});
