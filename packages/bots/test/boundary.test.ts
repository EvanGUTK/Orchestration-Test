import { readdirSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { DUEL_RULES } from "@2048/contracts";
import type { Board, GameState } from "@2048/contracts";
import { deserialize, newGame, serialize } from "@2048/engine";
import { BOT_STRATEGIES, BotGame, chooseMove, defaultBotConfig } from "../src/index.ts";
import { boardOf } from "./helpers.ts";

const SRC = join(dirname(fileURLToPath(import.meta.url)), "..", "src");
const read = (f: string) => readFileSync(join(SRC, f), "utf8");

/** Modules that make decisions: they must never see game state or the game PRNG. */
const DECISION_MODULES = ["choose.ts", "strategies.ts", "sim.ts", "evaluate.ts", "budget.ts", "config.ts", "types.ts"];
/** Modules that own/advance games (runner, worker, host, league): the only place the engine game API may appear. */
const GAME_DRIVERS = ["run.ts", "worker.ts", "host.ts", "tournament.ts", "tournament-worker.ts", "tournament-host.ts", "protocol.ts"];

function importedNames(source: string, from: string): string[] {
  const names: string[] = [];
  const re = new RegExp(`import\\s+(?:type\\s+)?\\{([^}]*)\\}\\s+from\\s+"${from.replace("/", "\\/")}"`, "g");
  for (const m of source.matchAll(re)) for (const part of m[1]!.split(",")) names.push(part.trim().replace(/^type\s+/, "").split(/\s+as\s+/)[0]!);
  return names.filter(Boolean);
}

describe("BOT-03 information boundary: static", () => {
  it("every source file is accounted for (new files must be classified)", () => {
    const all = readdirSync(SRC).filter((f) => f.endsWith(".ts")).sort();
    expect(all).toEqual([...DECISION_MODULES, ...GAME_DRIVERS, "index.ts"].sort());
  });

  it("decision modules import only board-level engine functions, never state, rng state or the game API", () => {
    const ALLOWED_ENGINE = new Set(["createRng", "deriveSeedWords", "legalMoves"]);
    for (const f of DECISION_MODULES) {
      const src = read(f);
      for (const name of importedNames(src, "@2048/engine")) expect(ALLOWED_ENGINE.has(name), `${f} imports ${name} from @2048/engine`).toBe(true);
      expect(/import\s+\*\s+as\s+\w+\s+from\s+"@2048\/engine"/.test(src), `${f} uses a namespace import of the engine`).toBe(false);
      for (const name of importedNames(src, "@2048/contracts")) {
        expect(["GameState", "RandomState", "MoveResult", "MoveCommand"].includes(name), `${f} imports ${name}`).toBe(false);
      }
      const code = src.replace(/\/\*[\s\S]*?\*\//g, "").replace(/\/\/.*$/gm, "");
      expect(/\b(GameState|RandomState|applyMove|newGame|replay|stateChecksum|deserialize)\b/.test(code), `${f} mentions game state APIs`).toBe(false);
      expect(/\.rng\b|\brng\s*:\s*\{?\s*algorithm|xoshiro/i.test(code.replace(/options\.rng|const rng|rng:\s*BotRng|ctx\.rng|\brng\b(?=[,)}\s=;])/g, "")), `${f} touches game rng fields`).toBe(false);
    }
  });

  it("chooseMove's signature carries a Board, a bot config and options without any game state", () => {
    const types = read("types.ts");
    const opts = /export type ChooseMoveOptions = \{[\s\S]*?\n\};/.exec(types)![0];
    expect(opts).not.toMatch(/GameState|RandomState|words|acceptedMoves|score/);
    expect(read("choose.ts")).toMatch(/export function chooseMove\(board: Board, rawConfig: BotConfig, options: ChooseMoveOptions = \{\}\)/);
  });

  it("no source anywhere in the package uses ambient randomness or wall-clock dates for decisions", () => {
    for (const f of [...DECISION_MODULES, ...GAME_DRIVERS]) {
      const code = read(f).replace(/\/\*[\s\S]*?\*\//g, "").replace(/\/\/.*$/gm, "");
      expect(code, f).not.toMatch(/Math\.random|Date\.now|new Date\(|crypto\.getRandomValues/);
    }
    // the only clock reference is the injectable time budget
    expect(read("choose.ts")).toMatch(/performance\.now/);
  });
});

/** Same board, same everything except the game PRNG words (and the counters around them). */
function withRng(base: GameState, words: [number, number, number, number], acceptedMoves: number, score: string): GameState {
  return deserialize(serialize({ ...base, rng: { algorithm: "xoshiro128ss-v1", words }, acceptedMoves, revision: acceptedMoves, score }));
}

describe("BOT-03 information boundary: dynamic", () => {
  const board: Board = boardOf([[1, 2, 3, 0], [0, 1, 2, 0], [2, 0, 1, 0], [0, 0, 0, 1]]);
  const base: GameState = { ...newGame(DUEL_RULES, "boundary"), board };
  const stateVariants = Array.from({ length: 12 }, (_, i) =>
    withRng(base, [1 + i * 7919, 2 + i * 104729, 3 + i * 1299709, 4 + i * 15485863], i * 3, String(i * 1000)),
  );

  for (const strategy of BOT_STRATEGIES) {
    it(`${strategy}: decision for a board is identical for every game PRNG state, yet the game's spawns differ`, () => {
      const config = { ...defaultBotConfig(strategy, "bot-x"), nodeBudget: 4000 };
      const decisions = stateVariants.map((state) => {
        const g = new BotGame({ rules: DUEL_RULES, gameSeed: "unused", config, ignoreTimeBudget: true });
        g.state = state; // inject a different PRNG state under the same board
        const before = structuredClone(g.state.board);
        const rec = g.step()!;
        expect(before).toEqual(board);
        return { direction: rec.direction, explanation: rec.explanation, nodes: rec.nodes, stopReason: rec.stopReason, afterBoard: g.state.board.cells.join(",") };
      });
      const first = decisions[0]!;
      for (const d of decisions) {
        expect(d.direction).toBe(first.direction);
        expect(d.explanation).toBe(first.explanation);
        expect(d.nodes).toBe(first.nodes);
        expect(d.stopReason).toBe(first.stopReason);
      }
      // control: the PRNG states really are different, because the engine spawned different tiles
      expect(new Set(decisions.map((d) => d.afterBoard)).size).toBeGreaterThan(1);
    });
  }

  it("a direct chooseMove call has no way to receive game state: results depend only on (board, config, moveIndex)", () => {
    for (const strategy of BOT_STRATEGIES) {
      const config = { ...defaultBotConfig(strategy, "bot-y"), nodeBudget: 3000 };
      const a = chooseMove(board, config, { moveIndex: 4, ignoreTimeBudget: true });
      for (const _state of stateVariants) {
        expect(chooseMove(structuredClone(board), config, { moveIndex: 4, ignoreTimeBudget: true })).toEqual(a);
      }
    }
  });

  it("the bot move stream is independent of the game seed", () => {
    const config = { ...defaultBotConfig("random", "same-bot-seed") };
    const picks = (gameSeed: string) => {
      const g = new BotGame({ rules: DUEL_RULES, gameSeed, config, maxMoves: 1, ignoreTimeBudget: true });
      g.state = { ...g.state, board };
      return g.step()!.direction;
    };
    expect(new Set(["g1", "g2", "g3", "g4", "g5", "g6"].map(picks)).size).toBe(1);
  });
});
