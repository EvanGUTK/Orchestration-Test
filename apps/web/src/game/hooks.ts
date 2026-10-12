import { useEffect, useRef, useState, useSyncExternalStore } from "react";
import type { Direction, GameState } from "@2048/contracts";
import { groupDecimal, maxExponentOf, tileSpoken } from "../format.ts";
import { GameController } from "./controller.ts";
import type { ControllerSnapshot, GameTransport } from "./controller.ts";

export function useControllerSnapshot(controller: GameController): ControllerSnapshot {
  return useSyncExternalStore(controller.subscribe, controller.getSnapshot, controller.getSnapshot);
}

/** Create a controller once per (game identity) and dispose it afterwards. */
export function useGameController(key: string, create: () => GameController): GameController {
  const ref = useRef<{ key: string; controller: GameController } | null>(null);
  if (ref.current === null || ref.current.key !== key) {
    ref.current?.controller.dispose();
    ref.current = { key, controller: create() };
  }
  const current = ref.current.controller;
  useEffect(() => () => current.dispose(), [current]);
  return current;
}

const DIRECTION_WORD: Record<Direction, string> = { up: "Up", right: "Right", down: "Down", left: "Left" };

export function scoreSpoken(score: string): string {
  return score.length <= 15 ? groupDecimal(score, ",") : `${score.length}-digit number starting ${score.slice(0, 6)}`;
}

export function describeState(state: GameState): string {
  const max = maxExponentOf(state.board.cells);
  const highest = max === null ? "none" : tileSpoken(max);
  return `Score ${scoreSpoken(state.score)}. Highest tile ${highest}. ${state.acceptedMoves} moves.`;
}

/**
 * Debounced polite announcement: many moves in a burst produce one message about the
 * latest state, never one per animation frame.
 */
export function useAnnouncement(snapshot: ControllerSnapshot, delayMs = 450): string {
  const [text, setText] = useState("");
  const toggle = useRef(false);
  const { lastMove, state } = snapshot;
  const seq = lastMove?.seq ?? 0;

  useEffect(() => {
    if (!lastMove) return;
    const timer = setTimeout(() => {
      toggle.current = !toggle.current;
      const pad = toggle.current ? "" : " ";
      if (state.status !== "active") {
        setText(`Game over. Final score ${scoreSpoken(state.score)}.${pad}`);
      } else if (!lastMove.changed) {
        setText(`${DIRECTION_WORD[lastMove.direction]}: no tiles moved.${pad}`);
      } else {
        const merges = lastMove.events.filter((e) => e.type === "merge");
        const mergeText = merges.length > 0 ? ` Merged ${merges.length === 1 ? "two tiles into " : `${merges.length} pairs, largest `}${tileSpoken(
          merges.reduce((best, e) => (e.type === "merge" && BigInt(e.exponent) > BigInt(best) ? e.exponent : best), "1"),
        )}.` : "";
        setText(`${DIRECTION_WORD[lastMove.direction]}.${mergeText} ${describeState(state)}${pad}`);
      }
    }, delayMs);
    return () => clearTimeout(timer);
  }, [seq, state.status, delayMs]);
  return text;
}

export function controllerFor(initial: GameState, transport: GameTransport, undoAvailable?: number): GameController {
  return new GameController(initial, transport, undoAvailable === undefined ? {} : { undoAvailable });
}
