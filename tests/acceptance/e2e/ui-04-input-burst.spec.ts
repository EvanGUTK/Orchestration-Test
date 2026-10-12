// UI-04 | Rapid mixed input and animation — accepted sequence matches authority;
// no dropped/doubled/out-of-order moves. Expected state comes from @g2048/engine in the test process.
import { applyMove, newGame, serialize } from "@g2048/engine";
import { practiceRuleset } from "@g2048/contracts";
import type { Direction, GameState } from "@g2048/contracts";
import type { Page } from "@playwright/test";
import {
  boardLocator,
  expect,
  readCells,
  readSave,
  startPractice,
  test,
  waitForAcceptedMoves,
} from "./fixtures.js";

type Input =
  | { kind: "key"; key: string; dir: Direction }
  | { kind: "button"; dir: Direction }
  | { kind: "swipe"; dir: Direction };

const KEYS: Record<Direction, string[]> = {
  up: ["ArrowUp", "w", "W"],
  right: ["ArrowRight", "d", "D"],
  down: ["ArrowDown", "s", "S"],
  left: ["ArrowLeft", "a", "A"],
};
const BUTTON: Record<Direction, string> = {
  up: "Move up",
  right: "Move right",
  down: "Move down",
  left: "Move left",
};
const ORDER: Direction[] = ["left", "down", "right", "down", "left", "up", "right", "down"];

/** Deterministic mixed burst: mostly keys (all bindings), every 7th a D-pad click, every 11th a swipe. */
function buildWave(offset: number, length: number): Input[] {
  return Array.from({ length }, (_, i) => {
    const n = offset + i;
    const dir = ORDER[(n * 5 + Math.floor(n / 3)) % ORDER.length] as Direction;
    if (n % 11 === 10) return { kind: "swipe", dir };
    if (n % 7 === 6) return { kind: "button", dir };
    const keys = KEYS[dir];
    return { kind: "key", key: keys[n % keys.length] as string, dir };
  });
}

async function send(page: Page, input: Input): Promise<void> {
  const board = boardLocator(page);
  if (input.kind === "key") {
    await page.keyboard.press(input.key);
  } else if (input.kind === "button") {
    await page.getByRole("button", { name: BUTTON[input.dir] }).click();
    await board.focus(); // keys only act on the focused board
  } else {
    const box = await board.boundingBox();
    if (!box) throw new Error("board not visible");
    const cx = box.x + box.width / 2;
    const cy = box.y + box.height / 2;
    const d = Math.min(box.width, box.height) / 3;
    const offsets: Record<Direction, readonly [number, number]> = {
      up: [0, -d],
      down: [0, d],
      left: [-d, 0],
      right: [d, 0],
    };
    const [dx, dy] = offsets[input.dir];
    await page.mouse.move(cx, cy);
    await page.mouse.down();
    await page.mouse.move(cx + dx, cy + dy, { steps: 3 });
    await page.mouse.up();
  }
}

function expectedAfter(
  initial: GameState,
  dirs: readonly Direction[],
  rules = practiceRuleset({ size: 4, fourWeight: 1, undo: true }),
) {
  let state = initial;
  for (const d of dirs) {
    if (state.status !== "active") break;
    state = applyMove(state, d, rules).state;
  }
  return state;
}

test.describe("UI-04 rapid mixed input", () => {
  for (const seed of ["ui04-burst-alpha", "ui04-burst-beta"]) {
    test(`seed ${seed}: two 30-input bursts (keys/WASD/D-pad/swipe) match the engine exactly`, async ({
      page,
    }) => {
      const rules = practiceRuleset({ size: 4, fourWeight: 1, undo: true });
      await startPractice(page, { size: 4, seed });
      const initial = newGame(rules, seed);
      expect(await readCells(page), "initial board = engine.newGame(seed)").toEqual(initial.board.cells);

      const all: Input[] = [];
      for (const [wave, offset] of [
        [0, 0],
        [1, 30],
      ] as const) {
        const inputs = buildWave(offset, 30); // <= queue capacity (32): no overflow is legitimate
        await boardLocator(page).focus();
        for (const input of inputs) await send(page, input); // no waits between inputs
        all.push(...inputs);
        const expected = expectedAfter(
          initial,
          all.map((i) => i.dir),
          rules,
        );
        await waitForAcceptedMoves(page, expected.acceptedMoves);
        // settle: nothing further may arrive (no doubled moves)
        await page.waitForTimeout(400);
        const save = await readSave(page);
        expect(save?.raw.state, `wave ${wave}: saved state is the engine's canonical state`).toBe(
          serialize(expected),
        );
        expect(await readCells(page), `wave ${wave}: rendered board`).toEqual(expected.board.cells);
      }
      expect(all.filter((i) => i.kind === "swipe").length).toBeGreaterThan(0);
      expect(all.filter((i) => i.kind === "button").length).toBeGreaterThan(0);
      // overflow is refused visibly, never silently: with <=30 inputs per wave there must be no refusal notice
      await expect(page.getByText(/ignored|too many|queue/i)).toHaveCount(0);
    });
  }

  test("held-key auto-repeat never reorders or injects moves", async ({ page }) => {
    // Design (controller): auto-repeat only queues when nothing is pending, so k of the N presses apply.
    // Whatever k is, the result must equal the engine applying the SAME direction k times (1 <= k <= N).
    const seed = "ui04-repeat";
    const rules = practiceRuleset({ size: 4, fourWeight: 1, undo: true });
    await startPractice(page, { size: 4, seed });
    const initial = newGame(rules, seed);
    await boardLocator(page).focus();
    const presses = 6;
    for (const [key, dir] of [
      ["ArrowDown", "down"],
      ["ArrowRight", "right"],
    ] as const) {
      const before = (await readSave(page))?.raw.state ?? serialize(initial);
      const start = JSON.parse(before) as GameState;
      for (let i = 0; i < presses; i++) await page.keyboard.down(key); // 2nd..Nth are repeat events
      await page.keyboard.up(key);
      await page.waitForTimeout(400);
      const candidates = Array.from({ length: presses }, (_, k) =>
        serialize(expectedAfter(start, Array<Direction>(k + 1).fill(dir), rules)),
      );
      const now = (await readSave(page))?.raw.state;
      expect(candidates, `${dir}: state equals ${dir} applied 1..${presses} times`).toContain(now);
      expect(await readCells(page)).toEqual((JSON.parse(now ?? "{}") as GameState).board.cells);
    }
  });
});
