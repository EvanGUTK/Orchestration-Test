import { describe, expect, it, vi } from "vitest";
import { BOT_STRATEGIES, RULESETS } from "@g2048/contracts";
import type { BotRunView, GameResponse, WsEnvelope } from "@g2048/contracts";
import { ApiError } from "../api/client.js";
import type { EventStream } from "../api/events.js";
import { localEngine } from "../game/local-engine.js";
import { inlineDecisionService } from "../test/inline-decisions.js";
import { DecisionCancelled, workerDecisionService } from "./decision.js";
import type { DecisionService } from "./decision.js";
import { LocalBotRun, rulesForBotRun } from "./local-run.js";
import type { BotRunSettings } from "./local-run.js";
import { ServerBotRun } from "./server-run.js";
import type { BotRunAction, BotRunApi } from "./server-run.js";

const settings = (patch: Partial<BotRunSettings> = {}): BotRunSettings => ({
  strategy: "greedy-v1",
  nodeBudget: 64,
  timeBudgetMs: 1000,
  seed: "bot-lab-test",
  size: 4,
  maxMoves: 1000,
  ...patch,
});
const instant = () => Promise.resolve();
const until = async (cond: () => boolean, max = 2000) => {
  for (let i = 0; i < max && !cond(); i++) await new Promise((r) => setTimeout(r, 0));
  if (!cond()) throw new Error("condition not reached");
};

describe("LocalBotRun (offline bot lab)", () => {
  it("uses bot-v1 on 4x4 and a non-ranked practice ruleset on other sizes", () => {
    expect(rulesForBotRun(4)).toBe(RULESETS["bot-v1"]);
    expect(rulesForBotRun(6)).toMatchObject({ version: "practice-v1", size: 6, ranked: false, undo: false });
  });

  it("steps one legal move at a time with the decision, explanation and node count", async () => {
    const run = new LocalBotRun(localEngine, inlineDecisionService(), settings(), () => 0, instant);
    expect(run.get().status).toBe("ready");
    await run.step();
    const view = run.get();
    expect(view.status).toBe("paused");
    expect(view.movesPlayed).toBe(1);
    expect(view.lastDecision).toMatchObject({ strategy: "greedy-v1", fallback: false });
    expect(view.lastDecision!.explanation.length).toBeGreaterThan(0);
    expect(view.lastDecision!.nodesSearched).toBeGreaterThan(0);
    expect(view.state.acceptedMoves).toBe(1);
  });

  it("is deterministic for the same seed, strategy and budget (BOT-04)", async () => {
    const a = new LocalBotRun(
      localEngine,
      inlineDecisionService(),
      settings({ maxMoves: 25 }),
      () => 0,
      instant,
    );
    const b = new LocalBotRun(
      localEngine,
      inlineDecisionService(),
      settings({ maxMoves: 25 }),
      () => 0,
      instant,
    );
    a.run();
    b.run();
    await until(() => a.get().status === "finished" && b.get().status === "finished");
    expect(a.get().movesPlayed).toBe(25);
    expect(a.get().message).toMatch(/25-move limit/);
    expect(localEngine.checksum(a.get().state)).toBe(localEngine.checksum(b.get().state));
  });

  it("every strategy plays legal moves within its node budget", async () => {
    for (const strategy of BOT_STRATEGIES) {
      const run = new LocalBotRun(
        localEngine,
        inlineDecisionService(),
        settings({ strategy, nodeBudget: 200, maxMoves: 3 }),
        () => 0,
        instant,
      );
      run.run();
      await until(() => run.get().status === "finished");
      expect(run.get().movesPlayed).toBe(3);
      expect(run.get().lastDecision!.nodesSearched).toBeLessThanOrEqual(200);
    }
  });

  it("pause stops between decisions; run resumes; stop cancels the in-flight search", async () => {
    const decisions = inlineDecisionService();
    const cancel = vi.spyOn(decisions, "cancel");
    const tick = () => new Promise<void>((r) => setTimeout(r, 0)); // yields like a real worker reply
    const run = new LocalBotRun(localEngine, decisions, settings(), () => 0, tick);
    run.run();
    await until(() => run.get().movesPlayed >= 2);
    run.pause();
    expect(run.get().status).toBe("paused");
    const moves = run.get().movesPlayed;
    await new Promise((r) => setTimeout(r, 5));
    expect(run.get().movesPlayed).toBeLessThanOrEqual(moves + 1); // at most the decision already in flight
    run.run();
    await until(() => run.get().movesPlayed > moves + 2);
    run.stop();
    expect(run.get().status).toBe("cancelled");
    expect(cancel).toHaveBeenCalled();
    const stopped = run.get().movesPlayed;
    await new Promise((r) => setTimeout(r, 5));
    expect(run.get().movesPlayed).toBe(stopped);
  });

  it("waits the configured speed between moves", async () => {
    const sleeps: number[] = [];
    const run = new LocalBotRun(
      localEngine,
      inlineDecisionService(),
      settings({ maxMoves: 3 }),
      () => 250,
      (ms) => {
        sleeps.push(ms);
        return Promise.resolve();
      },
    );
    run.run();
    await until(() => run.get().status === "finished");
    expect(sleeps.length).toBeGreaterThan(0);
    expect(sleeps.every((ms) => ms === 250)).toBe(true);
  });

  it("reports a failing worker instead of hanging", async () => {
    const broken: DecisionService = {
      decide: () => Promise.reject(new Error("The bot worker stopped unexpectedly.")),
      cancel: () => undefined,
    };
    const run = new LocalBotRun(localEngine, broken, settings(), () => 0, instant);
    await run.step();
    expect(run.get()).toMatchObject({ status: "failed", message: "The bot worker stopped unexpectedly." });
  });
});

class FakeWorker {
  static created: FakeWorker[] = [];
  onmessage: ((e: MessageEvent) => void) | null = null;
  onerror: ((e: unknown) => void) | null = null;
  posted: Array<{ id: number }> = [];
  terminated = false;
  constructor() {
    FakeWorker.created.push(this);
  }
  postMessage(message: { id: number }) {
    this.posted.push(message);
  }
  terminate() {
    this.terminated = true;
  }
  reply(data: unknown) {
    this.onmessage?.({ data } as MessageEvent);
  }
}

describe("workerDecisionService (search off the UI thread)", () => {
  const request = {
    state: localEngine.newGame(RULESETS["bot-v1"], "w"),
    rules: RULESETS["bot-v1"],
    config: { strategy: "random-v1" as const, nodeBudget: 1, timeBudgetMs: 10 },
    rng: null,
    seed: "w",
  };

  it("posts each request to one worker and resolves by id", async () => {
    FakeWorker.created = [];
    const service = workerDecisionService(() => new FakeWorker() as unknown as Worker)!;
    const p = service.decide(request);
    const worker = FakeWorker.created[0]!;
    const result = {
      kind: "no-legal-move",
      reason: "dead-board",
      rng: { algorithm: "x", words: [1, 0, 0, 0] },
    };
    worker.reply({ id: worker.posted[0]!.id, ok: true, result });
    await expect(p).resolves.toEqual(result);
    expect(FakeWorker.created).toHaveLength(1);
  });

  it("cancel terminates the worker (interrupting a long search) and rejects pending decisions", async () => {
    FakeWorker.created = [];
    const service = workerDecisionService(() => new FakeWorker() as unknown as Worker)!;
    const p = service.decide(request);
    service.cancel();
    await expect(p).rejects.toBeInstanceOf(DecisionCancelled);
    expect(FakeWorker.created[0]!.terminated).toBe(true);
    void service.decide(request).catch(() => undefined);
    expect(FakeWorker.created).toHaveLength(2); // a fresh worker for the next decision
  });

  it("rejects on worker errors and error replies", async () => {
    FakeWorker.created = [];
    const service = workerDecisionService(() => new FakeWorker() as unknown as Worker)!;
    const p1 = service.decide(request);
    const w = FakeWorker.created[0]!;
    w.reply({ id: w.posted[0]!.id, ok: false, message: "nodeBudget must be an integer" });
    await expect(p1).rejects.toThrow("nodeBudget must be an integer");
    const p2 = service.decide(request);
    w.onerror?.({});
    await expect(p2).rejects.toThrow(/stopped unexpectedly/);
  });

  it("is unavailable (null) when the browser has no Web Workers", () => {
    expect(typeof Worker).toBe("undefined");
    expect(workerDecisionService()).toBeNull();
  });
});

function view(patch: Partial<BotRunView>): BotRunView {
  return {
    id: "run-1",
    strategy: "greedy-v1",
    botVersion: "bots-1.1.0",
    status: "running",
    gameId: "game-1",
    nodeBudget: 64,
    timeBudgetMs: 1000,
    seed: "s",
    movesPlayed: 0,
    lastDecision: null,
    ...patch,
  };
}

function fakeServerApi(script: BotRunView[]) {
  const calls: string[] = [];
  const bodies: Record<string, unknown>[] = [];
  let i = 0;
  const game = (moves: number): GameResponse =>
    ({ state: { ...localEngine.newGame(RULESETS["bot-v1"], "s"), acceptedMoves: moves } }) as GameResponse;
  const api: BotRunApi = {
    create: async (body) => {
      calls.push("create");
      bodies.push(body);
      return script[0]!;
    },
    get: async () => {
      calls.push("get");
      i = Math.min(script.length - 1, i + 1);
      return script[i]!;
    },
    command: async (_id, action: BotRunAction) => {
      calls.push(action);
      if (action === "pause") return view({ status: "paused", movesPlayed: 3 });
      if (action === "step") return view({ status: "paused", movesPlayed: 4 });
      if (action === "resume") return view({ status: "running", movesPlayed: 4 });
      return {};
    },
    game: async (id) => {
      calls.push(`game:${id}`);
      return game(script[i]!.movesPlayed);
    },
  };
  return { api, calls, bodies };
}

describe("ServerBotRun (C13: POST /bots/runs, polling GET, pause/resume/step/cancel)", () => {
  const initial = localEngine.newGame(RULESETS["bot-v1"], "s");

  it("starts the run, polls until finished, and mirrors decisions and the board", async () => {
    const decision = {
      direction: "left",
      explanation: "greedy: best merge",
      nodesSearched: 4,
      fallback: false,
    };
    const { api, calls, bodies } = fakeServerApi([
      view({ status: "queued" }),
      view({ movesPlayed: 1, lastDecision: decision }),
      view({ movesPlayed: 2, lastDecision: decision }),
      view({ status: "finished", movesPlayed: 3, lastDecision: decision }),
    ]);
    const run = new ServerBotRun(api, null, settings({ size: 5 }), initial, instant, 0);
    run.run();
    await until(() => run.get().status === "finished");
    expect(bodies[0]).toMatchObject({ strategy: "greedy-v1", stepMode: false, practice: { size: 5 } });
    expect(calls.filter((c) => c === "get").length).toBeGreaterThanOrEqual(3);
    expect(run.get()).toMatchObject({ movesPlayed: 3, message: "Finished." });
    expect(run.get().lastDecision).toMatchObject({
      direction: "left",
      strategy: "greedy-v1",
      nodesSearched: 4,
    });
    expect(calls).toContain("game:game-1");
    const polls = calls.length;
    await new Promise((r) => setTimeout(r, 5));
    expect(calls.length).toBe(polls); // polling stopped at the terminal status
  });

  it("pause, step and resume use the C13 endpoints", async () => {
    const { api, calls } = fakeServerApi([view({ movesPlayed: 1 }), view({ movesPlayed: 2 })]);
    const run = new ServerBotRun(api, null, settings(), initial, () => new Promise(() => undefined), 0);
    run.run();
    await until(() => run.get().movesPlayed === 1);
    run.pause();
    await until(() => run.get().status === "paused");
    await run.step();
    expect(run.get().movesPlayed).toBe(4);
    run.run();
    await until(() => run.get().status === "running");
    expect(calls.filter((c) => ["create", "pause", "step", "resume"].includes(c))).toEqual([
      "create",
      "pause",
      "step",
      "resume",
    ]);
  });

  it("step from ready creates the run in stepMode, then steps once", async () => {
    const { api, calls, bodies } = fakeServerApi([view({ status: "paused" })]);
    const run = new ServerBotRun(api, null, settings(), initial, instant, 0);
    await run.step();
    expect(bodies[0]).toMatchObject({ stepMode: true });
    expect(calls.filter((c) => !c.startsWith("game:"))).toEqual(["create", "step"]);
    expect(run.get()).toMatchObject({ status: "paused", movesPlayed: 4 });
  });

  it("stop cancels on the server exactly once and ignores late updates", async () => {
    const { api, calls } = fakeServerApi([view({ movesPlayed: 1 })]);
    const run = new ServerBotRun(api, null, settings(), initial, () => new Promise(() => undefined), 0);
    run.run();
    await until(() => run.get().movesPlayed === 1);
    run.stop();
    run.stop();
    expect(run.get().status).toBe("cancelled");
    await until(() => calls.includes("cancel"));
    expect(calls.filter((c) => c === "cancel")).toHaveLength(1);
  });

  it("applies bot.progress pushes from the event stream and unsubscribes at the end", async () => {
    let push: ((env: WsEnvelope) => void) | null = null;
    const unsubscribe = vi.fn();
    const events: EventStream = {
      subscribe: (_kind, _id, handler) => {
        push = handler;
        return unsubscribe;
      },
    };
    const { api } = fakeServerApi([view({ movesPlayed: 0 })]);
    const run = new ServerBotRun(api, events, settings(), initial, () => new Promise(() => undefined), 0);
    run.run();
    await until(() => push !== null);
    push!({
      protocolVersion: 1,
      type: "bot.progress",
      resourceId: "run-1",
      sequence: 1,
      payload: view({ movesPlayed: 7 }),
    } as WsEnvelope);
    expect(run.get().movesPlayed).toBe(7);
    push!({
      protocolVersion: 1,
      type: "bot.finished",
      resourceId: "run-1",
      sequence: 2,
      payload: view({ status: "finished", movesPlayed: 9 }),
    } as WsEnvelope);
    expect(run.get().status).toBe("finished");
    expect(unsubscribe).toHaveBeenCalled();
  });

  it("explains a server without bot runs (404) and points to the offline option", async () => {
    const api: BotRunApi = {
      create: () => Promise.reject(new ApiError("NOT_FOUND", "Not found", 404, null)),
      get: () => Promise.reject(new Error("unused")),
      command: () => Promise.reject(new Error("unused")),
      game: () => Promise.reject(new Error("unused")),
    };
    const run = new ServerBotRun(api, null, settings(), initial, instant, 0);
    run.run();
    await until(() => run.get().status === "failed");
    expect(run.get().message).toMatch(/aren't available yet.*This browser/);
  });
});
