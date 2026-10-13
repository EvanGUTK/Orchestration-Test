// Verifies and snapshots replays off the UI thread (a 200k-move replay checks ~200k SHA-256 checksums).
import { localEngine } from "../game/local-engine.js";
import { analyzeReplayText } from "./replay.js";

type Request = { id: number; text: string; byteLength: number };

const scope = self as unknown as {
  onmessage: ((event: MessageEvent<Request>) => void) | null;
  postMessage(message: unknown): void;
};

scope.onmessage = (event) => {
  const { id, text, byteLength } = event.data;
  try {
    scope.postMessage({ id, result: analyzeReplayText(text, localEngine, byteLength) });
  } catch {
    scope.postMessage({
      id,
      result: {
        ok: false,
        problem: { kind: "corrupt", message: "The replay couldn't be checked.", atMove: null },
      },
    });
  }
};
