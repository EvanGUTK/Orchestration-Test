import { randomBytes, randomUUID } from "node:crypto";
import * as engine from "@2048/engine";
import { startBotRun, validateBotConfig, describeBot, type BotRunHandle, type BotRunResult } from "@2048/bots";
import { createRepos, type BotRunRow, type GameDb, type WriteQueue } from "@2048/database";
import {
  BOT_VERSION, CLASSIC_RULES, DUEL_RULES, DomainError, customRules, resolveRules,
  type BotConfig, type BotRunRequest, type BotRunView, type Ruleset,
} from "@2048/contracts";
import type { ServerConfig } from "../config.ts";
import { forbidden, notFound, validation } from "../errors.ts";
import type { Principal } from "./accounts.ts";
import { createGameRecord, type GameService, type Owner } from "./games.ts";
import { Outbox, type Publisher } from "./outbox.ts";

/** Milliseconds between exhibition moves by the owner's botSpeed preference (league/duel bots are unpaced). */
export const BOT_PACE_MS = { slow: 600, normal: 200, fast: 0 } as const;
export const DEFAULT_EXHIBITION_MAX_MOVES = 5_000;
export const MAX_BOT_RUN_MOVES = 100_000;

export type BotAction = "pause" | "resume" | "step" | "cancel";

type Runtime = {
  row: BotRunRow;
  handle: BotRunHandle;
  desired: "running" | "paused";
  pace: number;
  timer: ReturnType<typeof setTimeout> | null;
  stepWaiter: (() => void) | null;
  persist: Promise<void>;
  cancelRequested: boolean;
  failed: string | null;
};

export type BotManagerDeps = {
  db: GameDb;
  queue: WriteQueue;
  games: GameService;
  config: ServerConfig;
  publish?: Publisher;
  now?: () => Date;
  maxConcurrent?: number;
};

export function viewOfRun(row: BotRunRow): BotRunView {
  return {
    id: row.id,
    status: row.status,
    config: JSON.parse(row.configJson) as BotConfig,
    botVersion: row.botVersion,
    gameId: row.gameId,
    moves: row.moves,
    ...(row.lastExplanation ? { lastExplanation: row.lastExplanation } : {}),
  };
}

export class BotRunManager {
  readonly #d: BotManagerDeps;
  readonly #runs = new Map<string, Runtime>();
  readonly #lastSeq = new Map<string, number>();
  #shuttingDown = false;
  recovering = false;

  constructor(deps: BotManagerDeps) {
    this.#d = deps;
  }

  #now(): string {
    return (this.#d.now?.() ?? new Date()).toISOString();
  }

  get activeCount(): number {
    return this.#runs.size;
  }

  /** Strictly increasing per run and across restarts (wall-clock based), so clients can drop stale envelopes. */
  #seq(runId: string): number {
    const next = Math.max(Date.now(), (this.#lastSeq.get(runId) ?? 0) + 1);
    this.#lastSeq.set(runId, next);
    return next;
  }

  #publish(run: BotRunRow, type: "bot.progress" | "bot.finished"): void {
    const out = new Outbox();
    out.push(type, run.id, this.#seq(run.id), { run: viewOfRun(run) });
    this.#d.publish?.(out.items);
    if (type === "bot.finished") this.#lastSeq.delete(run.id);
  }

  #ownerWhere(p: Principal): { userId?: string; guestId?: string } {
    return p.kind === "user" ? { userId: p.userId } : { guestId: p.userId };
  }

  /** Create the bot game + run row, then start the worker. */
  async start(principal: Principal, req: BotRunRequest): Promise<BotRunView> {
    let config: BotConfig;
    try {
      config = validateBotConfig(req.config);
    } catch (err) {
      if (err instanceof DomainError) throw validation(err.message);
      throw err;
    }
    if (req.mode === "league" && principal.kind !== "user") throw forbidden("Bot league runs require an account");
    if (req.mode !== "exhibition" && req.mode !== "league") throw validation("mode must be exhibition or league");
    let rules: Ruleset;
    if (req.mode === "league") {
      if (req.boardSize !== undefined && req.boardSize !== 4) throw validation("League runs use the official 4x4 board");
      rules = DUEL_RULES;
    } else {
      const size = req.boardSize ?? 4;
      try {
        rules = size === 4 ? CLASSIC_RULES : customRules({ boardSize: size });
      } catch (err) {
        throw validation(err instanceof RangeError ? err.message : "Invalid board size");
      }
    }
    const maxMoves = req.maxMoves ?? (req.mode === "exhibition" ? DEFAULT_EXHIBITION_MAX_MOVES : null);
    if (maxMoves !== null && (!Number.isSafeInteger(maxMoves) || maxMoves < 1 || maxMoves > MAX_BOT_RUN_MOVES)) {
      throw validation(`maxMoves must be an integer from 1 to ${MAX_BOT_RUN_MOVES}`);
    }
    const gameSeed = req.gameSeed ?? (req.mode === "league" ? `league:${config.seed}` : randomBytes(16).toString("hex"));
    if (gameSeed.length < 1 || gameSeed.length > 128) throw validation("gameSeed must be 1-128 characters");

    const maxConcurrent = this.#d.maxConcurrent ?? 6;
    if (this.#runs.size >= maxConcurrent) {
      throw new DomainError("RESOURCE_LIMIT", `Too many bot runs are active (limit ${maxConcurrent}); cancel one first`);
    }
    const owner: Owner = principal.kind === "user" ? { userId: principal.userId } : { guestId: principal.userId };
    const pace = req.mode === "exhibition" ? BOT_PACE_MS[this.#speedPref(principal)] : 0;
    const at = this.#now();
    const label = describeBot(config).label;
    const id = randomUUID();
    await this.#d.queue.submit((raw) => {
      const repos = createRepos(raw);
      if (repos.bots.countActive(this.#ownerWhere(principal)) >= 3) {
        throw new DomainError("RESOURCE_LIMIT", "You already have 3 active bot runs; cancel one first");
      }
      const game = createGameRecord(raw, {
        owner, mode: req.mode === "league" ? "bot-league" : "bot-exhibition", rules, seed: gameSeed, at, botLabel: label,
      });
      repos.bots.insert({
        id, ownerUserId: "userId" in owner ? owner.userId : null, ownerGuestId: "guestId" in owner ? owner.guestId : null, botVersion: BOT_VERSION,
        mode: req.mode, configJson: JSON.stringify(config),
        budgetJson: JSON.stringify({ nodeBudget: config.nodeBudget, timeBudgetMs: config.timeBudgetMs, maxMoves }),
        status: "running", gameId: game.id, matchId: null, gameSeed, rulesetVersion: rules.version, maxMoves, paceMs: pace, at,
      });
    });
    this.launch(id);
    return this.#load(id);
  }

  #speedPref(p: Principal): keyof typeof BOT_PACE_MS {
    if (p.kind !== "user") return "normal";
    const profile = this.#d.db.read((raw) => createRepos(raw).accounts.profile(p.userId));
    try {
      const prefs = JSON.parse(profile?.preferencesJson ?? "{}") as { botSpeed?: string };
      return prefs.botSpeed === "slow" || prefs.botSpeed === "fast" ? prefs.botSpeed : "normal";
    } catch {
      return "normal";
    }
  }

  #load(id: string): BotRunView {
    const row = this.#d.db.read((raw) => createRepos(raw).bots.get(id));
    if (!row) throw notFound("Bot run not found");
    return viewOfRun(row);
  }

  #authorized(p: Principal, row: BotRunRow): boolean {
    return p.kind === "user" ? row.ownerUserId === p.userId : row.ownerGuestId === p.userId;
  }

  get(p: Principal, id: string): BotRunView {
    const row = this.#d.db.read((raw) => createRepos(raw).bots.get(id));
    if (!row || !this.#authorized(p, row)) throw notFound("Bot run not found");
    return viewOfRun(row);
  }

  snapshot(id: string): BotRunView | null {
    const row = this.#d.db.read((raw) => createRepos(raw).bots.get(id));
    return row ? viewOfRun(row) : null;
  }

  canRead(accountId: string, id: string): boolean {
    const row = this.#d.db.read((raw) => createRepos(raw).bots.get(id));
    return !!row && (row.ownerUserId === accountId || row.ownerGuestId === accountId);
  }

  /** Start (or restart after a crash) the worker for a stored run. Moves already persisted are verified, not replayed. */
  launch(runId: string): void {
    if (this.#runs.has(runId) || this.#shuttingDown) return;
    const row = this.#d.db.read((raw) => createRepos(raw).bots.get(runId));
    if (!row || (row.status !== "running" && row.status !== "paused")) return;
    const rules = row.rulesetVersion ? resolveRules(row.rulesetVersion) : null;
    if (!rules || !row.gameSeed || !row.gameId) {
      void this.#finalize(row, "error");
      return;
    }
    const config = JSON.parse(row.configJson) as BotConfig;
    const pace = row.paceMs;
    const deterministic = row.mode === "league" || row.matchId !== null;
    const desired = row.status === "paused" ? "paused" : "running";
    const handle = startBotRun({
      id: row.id, config, rules, gameSeed: row.gameSeed, ...(row.maxMoves ? { maxMoves: row.maxMoves } : {}),
      ignoreTimeBudget: deterministic, startPaused: desired === "paused" || pace > 0,
      onProgress: (record) => this.#onProgress(rt, record),
    });
    const rt: Runtime = { row, handle, desired, pace, timer: null, stepWaiter: null, persist: Promise.resolve(), cancelRequested: false, failed: null };
    this.#runs.set(row.id, rt);
    void handle.done.then((result) => this.#onDone(rt, result));
    if (desired === "running" && pace > 0) this.#schedule(rt, 0);
  }

  #schedule(rt: Runtime, delay: number): void {
    if (rt.timer) clearTimeout(rt.timer);
    rt.timer = setTimeout(() => {
      rt.timer = null;
      if (rt.desired !== "running" || rt.handle.status === "finished" || rt.handle.status === "cancelled" || rt.handle.status === "error") return;
      rt.stepWaiter = () => this.#schedule(rt, rt.pace);
      rt.handle.step();
    }, delay);
    rt.timer.unref();
  }

  #onProgress(rt: Runtime, record: { sequence: number; direction: "up" | "right" | "down" | "left"; checksum: string; explanation: string }): void {
    const waiter = rt.stepWaiter;
    rt.stepWaiter = null;
    rt.persist = rt.persist.then(async () => {
      if (rt.failed || this.#shuttingDown) return;
      try {
        await this.#applyMove(rt, record);
      } catch (err) {
        rt.failed = err instanceof Error ? err.message : String(err);
        rt.handle.cancel();
      }
    });
    if (waiter) void rt.persist.then(() => { if (!rt.failed) waiter(); });
  }

  async #applyMove(rt: Runtime, record: { sequence: number; direction: "up" | "right" | "down" | "left"; checksum: string; explanation: string }): Promise<void> {
    const gameId = rt.row.gameId!;
    const persisted = this.#d.db.read((raw) => createRepos(raw).games.get(gameId));
    if (!persisted) throw new Error("bot game disappeared");
    if (record.sequence <= persisted.state.acceptedMoves) {
      // Recovery fast-forward: the move already exists; it must be the same move.
      const existing = this.#d.db.read((raw) => createRepos(raw).games.checksumAt(gameId, record.sequence));
      if (existing !== undefined && existing !== record.checksum && persisted.state.acceptedMoves === record.sequence) {
        throw new Error("bot replay diverged from the persisted game");
      }
      return;
    }
    const res = await this.#d.games.move("system", gameId, { commandId: `bot-${rt.row.id}-${record.sequence}`, expectedRevision: null, direction: record.direction });
    if (!res.changed || engine.stateChecksum(res.game.state) !== record.checksum) {
      throw new Error("bot move did not reproduce on the authoritative engine");
    }
    const at = this.#now();
    const updated = await this.#d.queue.submit((raw) => {
      const r = createRepos(raw).bots;
      r.progress(rt.row.id, record.sequence, record.explanation, at);
      return r.get(rt.row.id)!;
    });
    rt.row = updated;
    this.#publish(updated, "bot.progress");
  }

  async #onDone(rt: Runtime, result: BotRunResult): Promise<void> {
    if (rt.timer) clearTimeout(rt.timer);
    await rt.persist;
    this.#runs.delete(rt.row.id);
    if (this.#shuttingDown) return; // leave the row 'running'/'paused': it is rebuilt on next boot
    const row = this.#d.db.read((raw) => createRepos(raw).bots.get(rt.row.id));
    if (!row) return;
    if (rt.failed) return void (await this.#finalize(row, "error"));
    if (result.status === "finished") return void (await this.#finalize(row, "finished"));
    if (result.status === "cancelled") return void (await this.#finalize(row, "cancelled"));
    await this.#finalize(row, "error");
  }

  async #finalize(row: BotRunRow, status: "finished" | "cancelled" | "error"): Promise<void> {
    const at = this.#now();
    if (row.gameId) {
      // finished within budget => the exhibition ended normally; cancelled/error => abandoned (forfeited).
      await this.#d.games.systemEnd(row.gameId, status === "finished" ? "completed" : "forfeited", `bot-end-${row.id}`).catch(() => null);
    }
    const final = await this.#d.queue.submit((raw) => {
      const r = createRepos(raw).bots;
      r.setStatus(row.id, status, at);
      return r.get(row.id)!;
    });
    this.#publish(final, "bot.finished");
  }

  async control(p: Principal, id: string, action: BotAction): Promise<BotRunView> {
    const row = this.#d.db.read((raw) => createRepos(raw).bots.get(id));
    if (!row || !this.#authorized(p, row)) throw notFound("Bot run not found");
    if (row.matchId) {
      const m = this.#d.db.read((raw) => createRepos(raw).competition.match(row.matchId!));
      if (m && m.kind !== "bot-vs-bot") throw forbidden("This bot is controlled by its match");
    }
    if (row.status === "finished" || row.status === "cancelled" || row.status === "error") return viewOfRun(row); // idempotent
    const rt = this.#runs.get(id);
    if (!rt) {
      // Not running in this process (e.g. recovery failed): cancel is the only meaningful control.
      if (action === "cancel") await this.#finalize(row, "cancelled");
      return this.#load(id);
    }
    const at = this.#now();
    const setStatus = (status: "running" | "paused") =>
      this.#d.queue.submit((raw) => {
        const r = createRepos(raw).bots;
        r.setStatus(id, status, at);
        return r.get(id)!;
      });
    switch (action) {
      case "pause": {
        rt.desired = "paused";
        if (rt.timer) { clearTimeout(rt.timer); rt.timer = null; }
        if (rt.pace === 0) rt.handle.pause();
        break;
      }
      case "resume": {
        rt.desired = "running";
        if (rt.pace > 0) this.#schedule(rt, 0);
        else rt.handle.resume();
        break;
      }
      case "step": {
        rt.desired = "paused";
        if (rt.timer) { clearTimeout(rt.timer); rt.timer = null; }
        rt.handle.step();
        break;
      }
      case "cancel": {
        rt.cancelRequested = true;
        rt.desired = "paused";
        if (rt.timer) { clearTimeout(rt.timer); rt.timer = null; }
        rt.handle.cancel();
        return viewOfRun(row);
      }
    }
    const updated = await setStatus(rt.desired);
    rt.row = updated;
    this.#publish(updated, "bot.progress");
    return viewOfRun(updated);
  }

  /** Relaunch every unfinished run (boot-time recovery). */
  recover(): number {
    this.recovering = true;
    try {
      const rows = this.#d.db.read((raw) => createRepos(raw).bots.unfinished());
      for (const row of rows) this.launch(row.id);
      return rows.length;
    } finally {
      this.recovering = false;
    }
  }

  /** Stop all workers without recording a result: the runs are reconstructed on the next boot. */
  async shutdown(): Promise<void> {
    this.#shuttingDown = true;
    const runs = [...this.#runs.values()];
    for (const rt of runs) if (rt.timer) clearTimeout(rt.timer);
    await Promise.allSettled(runs.map((rt) => rt.handle.terminate()));
    await Promise.allSettled(runs.map((rt) => rt.persist));
    this.#runs.clear();
  }
}
