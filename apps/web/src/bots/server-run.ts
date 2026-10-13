import type { BotDecision, BotRunView, GameResponse, GameState } from "@g2048/contracts";
import type { ApiClient } from "../api/client.js";
import { describeApiError, isApiError } from "../api/client.js";
import type { EventStream } from "../api/events.js";
import type { BotRunHandle, BotRunSettings, BotRunState, BotRunStatus } from "./local-run.js";
import { rulesForBotRun } from "./local-run.js";

const STATUS: Record<BotRunView["status"], BotRunStatus> = {
  queued: "running",
  running: "running",
  paused: "paused",
  finished: "finished",
  cancelled: "cancelled",
  failed: "failed",
};

const TERMINAL: ReadonlySet<BotRunStatus> = new Set(["finished", "cancelled", "failed"]);

export const BOT_POLL_INTERVAL_MS = 500;

type Sleep = (ms: number) => Promise<void>;
export type BotRunAction = "pause" | "resume" | "step" | "cancel";

/** The server-side bot run API (CONTRACT-001 HTTP table + C13), behind an interface for tests. */
export interface BotRunApi {
  create(body: Record<string, unknown>): Promise<BotRunView>;
  get(id: string): Promise<BotRunView>;
  command(id: string, action: BotRunAction): Promise<unknown>;
  game(id: string): Promise<GameResponse>;
}

export function httpBotRunApi(api: ApiClient): BotRunApi {
  const path = (id: string) => `/bots/runs/${encodeURIComponent(id)}`;
  return {
    create: (body) => api.request<BotRunView>("POST", "/bots/runs", body),
    get: (id) => api.request<BotRunView>("GET", path(id)),
    command: (id, action) => api.request<unknown>("POST", `${path(id)}/${action}`, {}),
    game: (id) => api.getGame(id),
  };
}

function isBotRunView(value: unknown): value is BotRunView {
  return (
    typeof value === "object" &&
    value !== null &&
    typeof (value as BotRunView).id === "string" &&
    typeof (value as BotRunView).status === "string"
  );
}

/**
 * Bot run on the local server: POST /bots/runs starts it, GET /bots/runs/:id is polled for progress
 * (C13; `bot.progress`/`bot.finished` WebSocket events, when available, only make updates arrive
 * sooner), POST /bots/runs/:id/{pause,resume,step,cancel} control it. The board is read from
 * GET /games/:gameId. A 404 on create means this server has no bot runs yet.
 */
export class ServerBotRun implements BotRunHandle {
  readonly kind = "server" as const;
  readonly canPause = true;
  private view: BotRunState;
  private runId: string | null = null;
  private unsubscribe: (() => void) | null = null;
  private readonly listeners = new Set<() => void>();
  private boardMoves = -1;
  private polling = false;
  private disposed = false;
  private busy = false;

  constructor(
    private readonly api: BotRunApi,
    private readonly events: EventStream | null,
    private readonly settings: BotRunSettings,
    initial: GameState,
    private readonly sleep: Sleep = (ms) => new Promise((r) => setTimeout(r, ms)),
    private readonly pollMs = BOT_POLL_INTERVAL_MS,
  ) {
    this.view = {
      status: "ready",
      state: initial,
      rules: rulesForBotRun(settings.size),
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
    return TERMINAL.has(this.view.status);
  }

  run(): void {
    if (this.terminal || this.busy) return;
    if (this.view.status === "ready") void this.create(false);
    else if (this.view.status === "paused" && this.runId) void this.command("resume");
  }

  pause(): void {
    if (this.view.status !== "running" || !this.runId || this.busy) return;
    void this.command("pause");
  }

  async step(): Promise<void> {
    if (this.terminal || this.busy) return;
    // stepMode: the server creates the run paused and advances exactly one move per step command.
    if (this.view.status === "ready" && !(await this.create(true))) return;
    if (this.view.status === "running") await this.command("pause");
    if (this.view.status === "paused") await this.command("step");
  }

  stop(): void {
    if (this.terminal) return;
    const id = this.runId;
    this.dispose();
    this.set({ status: "cancelled", thinking: false, message: "Stopped." });
    if (id) {
      this.api.command(id, "cancel").catch((error: unknown) => {
        this.set({ message: `Stop request failed: ${describeApiError(error)}` });
      });
    }
  }

  private dispose() {
    this.disposed = true;
    this.unsubscribe?.();
    this.unsubscribe = null;
  }

  private async create(stepMode: boolean): Promise<boolean> {
    this.busy = true;
    this.set({ status: "running", thinking: true, message: "Starting the bot on the server…" });
    const { strategy, nodeBudget, timeBudgetMs, seed, size, maxMoves } = this.settings;
    try {
      const run = await this.api.create({
        strategy,
        nodeBudget,
        timeBudgetMs,
        seed,
        maxMoves,
        stepMode,
        ...(size !== 4 ? { practice: { size, fourWeight: 1, undo: false } } : {}),
      });
      if (this.disposed) return false;
      this.runId = run.id;
      this.apply(run);
      if (this.events && !this.disposed) {
        this.unsubscribe = this.events.subscribe("bot-run", run.id, (env) => {
          if ((env.type === "bot.progress" || env.type === "bot.finished") && isBotRunView(env.payload))
            this.apply(env.payload);
        });
      }
      void this.poll();
      return true;
    } catch (error) {
      this.dispose();
      this.set({
        status: "failed",
        thinking: false,
        message:
          isApiError(error) && error.status === 404
            ? "Bot runs on the server aren't available yet. Choose “This browser” to run the bot offline."
            : `Couldn't start the server bot. ${describeApiError(error)}`,
      });
      return false;
    } finally {
      this.busy = false;
    }
  }

  private async command(action: "pause" | "resume" | "step"): Promise<void> {
    const id = this.runId;
    if (!id) return;
    this.busy = true;
    try {
      const result = await this.api.command(id, action);
      if (this.disposed) return;
      this.apply(isBotRunView(result) ? result : await this.api.get(id));
      void this.poll();
    } catch (error) {
      if (!this.disposed) this.set({ message: `Couldn't ${action} the bot. ${describeApiError(error)}` });
    } finally {
      this.busy = false;
    }
  }

  /** At most one polling loop; it ends when the run is no longer running here (paused, ended, stopped). */
  private async poll(): Promise<void> {
    if (this.polling) return;
    this.polling = true;
    let failures = 0;
    try {
      while (!this.disposed && this.runId && this.view.status === "running") {
        await this.sleep(this.pollMs);
        if (this.disposed || this.view.status !== "running") break;
        try {
          this.apply(await this.api.get(this.runId));
          failures = 0;
        } catch (error) {
          if (++failures >= 5) {
            this.set({ message: `Lost contact with the server bot. ${describeApiError(error)}` });
            break;
          }
        }
      }
    } finally {
      this.polling = false;
    }
  }

  private apply(run: BotRunView) {
    if (this.disposed && this.view.status === "cancelled") return;
    const decision: BotDecision | null = run.lastDecision
      ? {
          strategy: run.strategy,
          botVersion: run.botVersion,
          direction: run.lastDecision.direction as BotDecision["direction"],
          explanation: run.lastDecision.explanation,
          nodesSearched: run.lastDecision.nodesSearched,
          fallback: run.lastDecision.fallback,
        }
      : this.view.lastDecision;
    const status = STATUS[run.status] ?? "running";
    this.set({
      status,
      movesPlayed: run.movesPlayed,
      lastDecision: decision,
      thinking: status === "running",
      message:
        run.status === "queued"
          ? "Queued on the server…"
          : status === "finished"
            ? "Finished."
            : status === "failed"
              ? "The server bot failed."
              : status === "cancelled"
                ? "Stopped."
                : null,
    });
    if (TERMINAL.has(status)) this.dispose();
    if (run.gameId && run.movesPlayed !== this.boardMoves) {
      this.boardMoves = run.movesPlayed;
      this.api.game(run.gameId).then(
        (res) => {
          // Responses can arrive out of order; never move the board backwards.
          if (res.state.acceptedMoves >= this.view.state.acceptedMoves) this.set({ state: res.state });
        },
        () => undefined,
      );
    }
  }
}
