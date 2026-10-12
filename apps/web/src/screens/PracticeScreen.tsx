import { useId, useState } from "react";
import type { FormEvent } from "react";
import { MAX_BOARD_SIZE, MIN_BOARD_SIZE, PracticeOptionsSchema, practiceRuleset } from "@g2048/contracts";
import { navigate } from "../app/routes.js";
import { describeApiError } from "../api/client.js";
import { useActiveGame } from "../app/services.js";
import { EngineUnavailable } from "./PlayScreen.js";

const SIZES = Array.from({ length: MAX_BOARD_SIZE - MIN_BOARD_SIZE + 1 }, (_, i) => MIN_BOARD_SIZE + i);

export function PracticeScreen() {
  const game = useActiveGame();
  const id = useId();
  const [size, setSize] = useState("5");
  const [fourWeight, setFourWeight] = useState("1");
  const [seed, setSeed] = useState("");
  const [undo, setUndo] = useState(true);
  const [error, setError] = useState<string | null>(null);

  if (!game) return <EngineUnavailable />;

  const submit = async (event: FormEvent) => {
    event.preventDefault();
    const parsed = PracticeOptionsSchema.safeParse({
      size: Number.parseInt(size, 10),
      fourWeight: Number.parseInt(fourWeight, 10),
      seed: seed.trim() === "" ? undefined : seed.trim(),
      undo,
    });
    if (!parsed.success) {
      setError(
        `Check the settings: size must be ${MIN_BOARD_SIZE}–${MAX_BOARD_SIZE}, 4-tile chance 0–100% in steps of 10, seed at most 128 characters.`,
      );
      return;
    }
    setError(null);
    try {
      await game.start({ mode: "practice", rules: practiceRuleset(parsed.data), seed: parsed.data.seed });
      navigate("play");
    } catch (err) {
      setError(`Couldn't start the practice game. ${describeApiError(err)}`);
    }
  };

  return (
    <form
      className="panel form"
      onSubmit={(e) => void submit(e)}
      noValidate
      aria-describedby={`${id}-casual`}
    >
      <p className="lede" id={`${id}-casual`}>
        Practice games are always casual: they never count toward ranked standings, even with a challenge
        seed.
      </p>

      <fieldset className="field">
        <legend>Board size</legend>
        <div className="segmented">
          {SIZES.map((n) => (
            <label key={n} className="segmented__item">
              <input
                type="radio"
                name="size"
                value={n}
                checked={size === String(n)}
                onChange={() => setSize(String(n))}
              />
              <span>
                {n}×{n}
              </span>
            </label>
          ))}
        </div>
      </fieldset>

      <div className="field">
        <label htmlFor={`${id}-four`}>Chance a new tile is a 4</label>
        <div className="range-row">
          <input
            id={`${id}-four`}
            type="range"
            min={0}
            max={10}
            step={1}
            value={fourWeight}
            onChange={(e) => setFourWeight(e.target.value)}
            aria-valuetext={`${fourWeight}0 percent`}
          />
          <output htmlFor={`${id}-four`}>{Number.parseInt(fourWeight, 10) * 10}%</output>
        </div>
      </div>

      <div className="field">
        <label htmlFor={`${id}-seed`}>Seed (optional)</label>
        <input
          id={`${id}-seed`}
          type="text"
          inputMode="text"
          autoComplete="off"
          spellCheck={false}
          maxLength={128}
          value={seed}
          onChange={(e) => setSeed(e.target.value)}
          aria-describedby={`${id}-seed-help`}
        />
        <p className="hint hint--small" id={`${id}-seed-help`}>
          The same seed and settings always produce the same tile spawns. Leave empty for a random seed.
        </p>
      </div>

      <label className="check">
        <input type="checkbox" checked={undo} onChange={(e) => setUndo(e.target.checked)} />
        <span>Allow undo (up to 100 moves)</span>
      </label>

      {error && (
        <p className="notice notice--error" role="alert">
          {error}
        </p>
      )}
      <div className="action-row">
        <button type="submit" className="button button--primary">
          Start practice game
        </button>
      </div>
    </form>
  );
}
