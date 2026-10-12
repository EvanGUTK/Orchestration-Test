// SOLO-01 (guest) | New guest game; save/resume — correct initial state and durable progress.
import { applyMove, deserialize, newGame, serialize } from "@g2048/engine";
import { RULESETS, practiceRuleset } from "@g2048/contracts";
import type { Direction } from "@g2048/contracts";
import {
  boardLocator,
  expect,
  gotoRoute,
  readCells,
  readSave,
  startClassic,
  startPractice,
  test,
  waitForAcceptedMoves,
} from "./fixtures.js";

const MOVES: { key: string; dir: Direction }[] = [
  { key: "ArrowLeft", dir: "left" },
  { key: "ArrowDown", dir: "down" },
  { key: "ArrowRight", dir: "right" },
  { key: "ArrowUp", dir: "up" },
  { key: "ArrowLeft", dir: "left" },
  { key: "ArrowDown", dir: "down" },
];

test.describe("SOLO-01 guest game save and resume", () => {
  test("classic guest game: initial state matches the engine for the shown seed; progress survives reload", async ({
    page,
  }) => {
    const rules = RULESETS["classic-v1"];
    await startClassic(page);
    const seed = (await page.locator("code.seed").textContent())?.trim() ?? "";
    expect(seed.length, "the game shows its seed").toBeGreaterThan(0);
    let expected = newGame(rules, seed);
    expect(await readCells(page)).toEqual(expected.board.cells);
    await expect.poll(async () => (await readSave(page))?.raw.state).toBe(serialize(expected));

    await boardLocator(page).focus();
    for (const m of MOVES) {
      await page.keyboard.press(m.key);
      expected = applyMove(expected, m.dir, rules).state;
    }
    await waitForAcceptedMoves(page, expected.acceptedMoves);
    expect((await readSave(page))?.raw.state).toBe(serialize(expected));

    await page.reload();
    await gotoRoute(page, "/play");
    await expect(boardLocator(page)).toBeVisible();
    expect(await readCells(page), "board after reload").toEqual(expected.board.cells);
    await expect(page.locator("code.seed")).toHaveText(seed);
    expect((await readSave(page))?.raw.state).toBe(serialize(expected));

    // continuing after resume follows the same deterministic stream
    await boardLocator(page).focus();
    for (const m of MOVES.slice(0, 3)) {
      await page.keyboard.press(m.key);
      expected = applyMove(expected, m.dir, rules).state;
    }
    await waitForAcceptedMoves(page, expected.acceptedMoves);
    expect((await readSave(page))?.raw.state).toBe(serialize(expected));
  });

  test("practice 5x5 seeded game resumes from Saved games after a fresh page load", async ({ page }) => {
    const seed = "solo01-practice-5";
    const rules = practiceRuleset({ size: 5, fourWeight: 1, undo: true });
    await startPractice(page, { size: 5, seed });
    let expected = newGame(rules, seed);
    expect(await readCells(page)).toEqual(expected.board.cells);
    await boardLocator(page).focus();
    for (const m of MOVES) {
      await page.keyboard.press(m.key);
      expected = applyMove(expected, m.dir, rules).state;
    }
    await waitForAcceptedMoves(page, expected.acceptedMoves);

    await page.goto("about:blank");
    await gotoRoute(page, "/saves");
    await page.getByRole("button", { name: "Resume" }).click();
    await expect(page.locator("h1.page-title")).toHaveText("Solo board");
    await expect(boardLocator(page)).toHaveAttribute("data-size", "5");
    expect(await readCells(page)).toEqual(expected.board.cells);
    const save = await readSave(page);
    expect(save?.raw.mode).toBe("practice");
    expect(save?.raw.seed).toBe(seed);
    expect(serialize(deserialize(save?.raw.state ?? ""))).toBe(serialize(expected));
  });

  test("a corrupted autosave is ignored safely (no crash, new game can start)", async ({ page }) => {
    await gotoRoute(page, "/play");
    await page.evaluate(() =>
      window.localStorage.setItem("g2048.guest.game.v1", '{"version":1,"state":"{broken'),
    );
    await page.reload();
    await gotoRoute(page, "/play");
    await page.getByRole("button", { name: "Start classic game" }).click();
    await expect(boardLocator(page)).toBeVisible();
    expect((await readCells(page)).filter((c) => c !== null)).toHaveLength(2);
  });
});
