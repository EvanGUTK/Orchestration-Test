import type { EnginePort } from "../game/engine-port.js";
import { analyzeReplayText } from "./replay.js";
import type { AnalyzeResult } from "./replay.js";

/** Runs replay verification; the browser implementation uses a Web Worker so the UI never freezes. */
export interface ReplayAnalyzer {
  analyze(text: string, byteLength: number): Promise<AnalyzeResult>;
}

/** Same-thread analyzer (tests, and browsers without module workers). */
export function inlineAnalyzer(engine: EnginePort): ReplayAnalyzer {
  return { analyze: async (text, byteLength) => analyzeReplayText(text, engine, byteLength) };
}

export function workerAnalyzer(fallback: ReplayAnalyzer): ReplayAnalyzer {
  if (typeof Worker === "undefined") return fallback;
  let worker: Worker | null = null;
  let nextId = 1;
  const pending = new Map<number, (r: AnalyzeResult) => void>();
  const ensure = () => {
    if (worker) return worker;
    worker = new Worker(new URL("./replay.worker.ts", import.meta.url), { type: "module" });
    worker.onmessage = (event: MessageEvent<{ id: number; result: AnalyzeResult }>) => {
      pending.get(event.data.id)?.(event.data.result);
      pending.delete(event.data.id);
    };
    worker.onerror = () => {
      for (const resolve of pending.values()) {
        resolve({
          ok: false,
          problem: { kind: "corrupt", message: "The replay checker stopped unexpectedly.", atMove: null },
        });
      }
      pending.clear();
      worker?.terminate();
      worker = null;
    };
    return worker;
  };
  return {
    analyze(text, byteLength) {
      const id = nextId++;
      return new Promise((resolve) => {
        pending.set(id, resolve);
        ensure().postMessage({ id, text, byteLength });
      });
    },
  };
}
