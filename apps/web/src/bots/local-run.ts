import { RULESETS, practiceRuleset } from "@g2048/contracts";
import type { BotConfig, BotDecision, GameState, RandomState, Ruleset } from "@g2048/contracts";
import type { EnginePort } from "../game/engine-port.js";
import { DecisionCancelled } from "./decision.js";
import type { DecisionService } from "./decision.js";

export type BotRunSettings = BotConfig & {
  readonly seed: string;
  /** 4 uses the bot-v1 ruleset; other sizes use a casual practice ruleset. */
  readonly size: number;
  readonly maxMoves: number;
};

export type BotRunStatus = "ready" | "running" | "paused" | "finished" | "cancelled" | "failed";

export type BotRunState = {
  readonly status: BotRunStatus;
  readonly state: GameState;
  readonly rules: Ruleset;
  readonly movesPlayed: number;
  readonly lastDecision: BotDecision | null;
  /** Waiting for the bot's search (the worker is computing). */
  readonly thinking: boolean;
  readonly message: string | null;
};

/** Common surface for local and server bot runs used by the bot lab screen. */
export interface BotRunHandle {
  readonly kind: "local" | "server";
  readonly canPause: boolean;
  get(): BotRunState;
  subscribe(listener: () => void): () => void;
  run(): void;
  pause(): void;
  step(): Promise<void>;
  stop(): void;
}

export function rulesForBotRun(size: number): Ruleset {
  return size === 4 ? RULESETS["bot-v1"] : practiceRuleset({ size, fourWeight: 1, undo: false });
}

type Sleep = (ms: number) => Promise<void>;

/**
 * Offline bot exhibition: the engine applies moves here (cheap); every decision comes from the
 * DecisionService (a Web Worker in the browser). Speed is a delay between moves; pause/step/stop act
 * between decisions, and stop also interrupts an in-flight search.
 */
export class LocalBotRun implements BotRunHandle {
  readonly kind = "local" as const;
  readonly canPause = true;
  private view: BotRunState;
  private rng: RandomState | null = null;
  private readonly listeners = new Set<() => void>();
  private loopToken = 0;

  constructor(
    private readonly engine: EnginePort,
    private readonly decisions: DecisionService,
    private readonly settings: BotRunSettings,
    private readonly delayMs: () => number,
    private readonly sleep: Sleep = (ms) => new Promise((r) => setTimeout(r, ms)),
  ) {
    const rules = rulesForBotRun(settings.size);
    this.view = {
      status: "ready",
      state: engine.newGame(rules, settings.seed),
      rules,
      movesPlayed: 0,
      lastDecision: null,
      thinking: false,
      message: null,
    };
  }

  get = (): BotRunState => this.view;

  subscribe = (listener: () => void) => {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  };

  private set(patch: Partial<BotRunState>) {
    this.view = { ...this.view, ...patch };
    for (const l of this.listeners) l();
  }

  private get terminal() {
    return (
      this.view.status === "finished" || this.view.status === "cancelled" || this.view.status === "failed"
    );
  }

  run(): void {
    if (this.terminal || this.view.status === "running") return;
    const token = ++this.loopToken;
    this.set({ status: "running", message: null });
    void (async () => {
      while (token === this.loopToken && this.view.status === "running") {
        await this.advance(token);
        if (token !== this.loopToken || this.view.status !== "running") break;
        const delay = this.delayMs();
        if (delay > 0) await this.sleep(delay);
        else await this.sleep(0); // yield so the UI can render and controls stay responsive
      }
    })();
  }

  pause(): void {
    if (this.view.status !== "running") return;
    this.loopToken++;
    this.set({ status: "paused" });
  }

  /** One decision + move. Only from ready/paused (a running loop is paused first). */
  async step(): Promise<void> {
    if (this.terminal) return;
    if (this.view.status === "running") this.pause();
    if (this.view.thinking) return;
    const token = ++this.loopToken;
    this.set({ status: "paused" });
    await this.advance(token);
  }

  stop(): void {
    if (this.terminal) return;
    this.loopToken++;
    this.decisions.cancel();
    this.set({ status: "cancelled", thinking: false, message: "Stopped." });
  }

  private finish(message: string) {
    this.loopToken++;
    this.set({ status: "finished", thinking: false, message });
  }

  private async advance(token: number): Promise<void> {
    const { state, rules, movesPlayed } = this.view;
    if (state.status !== "active") return this.finish("Game over: no moves left.");
    if (movesPlayed >= this.settings.maxMoves)
      return this.finish(`Reached the ${this.settings.maxMoves}-move limit.`);
    this.set({ thinking: true });
    let result;
    try {
      result = await this.decisions.decide({
        state,
        rules,
        config: {
          strategy: this.settings.strategy,
          nodeBudget: this.settings.nodeBudget,
          timeBudgetMs: this.settings.timeBudgetMs,
        },
        rng: this.rng,
        seed: this.settings.seed,
      });
    } catch (error) {
      if (error instanceof DecisionCancelled || token !== this.loopToken) return;
      this.loopToken++;
      this.set({
        status: "failed",
        thinking: false,
        message: error instanceof Error ? error.message : "Bot error",
      });
      return;
    }
    if (token !== this.loopToken && this.terminal) return;
    this.rng = result.rng;
    if (result.kind === "no-legal-move") {
      return this.finish(
        result.reason === "dead-board" ? "Game over: no moves left." : "The game has ended.",
      );
    }
    let applied;
    try {
      applied = this.engine.applyMove(state, result.decision.direction, rules);
    } catch (error) {
      const code = (error as { code?: string }).code;
      this.loopToken++;
      this.set({
        status: "failed",
        thinking: false,
        message:
          code === "RESOURCE_LIMIT"
            ? "Stopped at the tile size limit; the board is unchanged."
            : "The move failed.",
      });
      return;
    }
    this.set({
      state: applied.state,
      movesPlayed: applied.changed ? movesPlayed + 1 : movesPlayed,
      lastDecision: result.decision,
      thinking: false,
    });
    if (applied.state.status !== "active") this.finish("Game over: no moves left.");
  }
}
