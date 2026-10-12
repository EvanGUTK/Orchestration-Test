// UI-02 | Keyboard-only run — mode/account/game/settings/replay reachable; visible focus;
// board-focused key handling. No mouse or programmatic focus is used in the main path.
import { expect, focusInfo, readCells, readSave, tabTo, test } from "./fixtures.js";

test.describe("UI-02 keyboard-only run", () => {
  test("menu -> classic game -> moves -> settings, all by keyboard with visible focus", async ({ page }) => {
    await page.goto("/#/");
    await expect(page.locator("h1.page-title")).toHaveText("Welcome");

    // First Tab reaches the skip link, which becomes visible.
    await page.keyboard.press("Tab");
    const skip = page.getByRole("link", { name: "Skip to content" });
    await expect(skip).toBeFocused();
    await expect(skip).toBeInViewport();

    // Account controls are reachable from the keyboard (Welcome tabs).
    await tabTo(page, (f) => f.role === "tab");

    // Main menu -> Modes
    await tabTo(page, (f) => f.tag === "a" && f.name === "Modes");
    await page.keyboard.press("Enter");
    await expect(page.locator("h1.page-title")).toHaveText("Choose a mode");
    await expect(page.locator("h1.page-title")).toBeFocused();

    // Mode card -> Classic infinite
    await tabTo(page, (f) => f.tag === "a" && f.name === "Classic infinite");
    await page.keyboard.press("Enter");
    await expect(page.locator("h1.page-title")).toHaveText("Solo board");

    // Start a game; focus lands on the board.
    await tabTo(page, (f) => f.tag === "button" && f.name === "Start classic game");
    await page.keyboard.press("Enter");
    const board = page.getByRole("application", { name: /game board/ });
    await expect(board).toBeFocused();
    expect((await focusInfo(page)).role).toBe("application");

    for (const key of ["ArrowLeft", "ArrowUp", "ArrowRight", "ArrowDown", "a", "w", "d", "s"]) {
      await page.keyboard.press(key);
    }
    await expect.poll(async () => (await readSave(page))?.state.acceptedMoves ?? 0).toBeGreaterThan(0);

    // Settings via the menu; change theme with arrow keys on the radio group.
    await tabTo(page, (f) => f.tag === "a" && f.name === "Settings");
    await page.keyboard.press("Enter");
    await expect(page.locator("h1.page-title")).toHaveText("Settings");
    await tabTo(page, (f) => f.tag === "input" && f.type === "radio" && f.name === "System");
    for (let i = 0; i < 3; i++) await page.keyboard.press("ArrowRight");
    await expect(page.getByRole("radio", { name: "High contrast" })).toBeChecked();
    await expect(page.locator("html")).toHaveAttribute("data-theme", "high-contrast");

    // Replays screen is reachable from the menu by keyboard.
    await tabTo(page, (f) => f.tag === "a" && f.name === "Replays", 120);
    await page.keyboard.press("Enter");
    await expect(page.locator("h1.page-title")).toHaveText("Replays");
  });

  test("arrow/WASD keys move tiles only while the board has focus", async ({ page }) => {
    await page.goto("/#/play");
    await page.getByRole("button", { name: "Start classic game" }).press("Enter");
    const board = page.getByRole("application", { name: /game board/ });
    await expect(board).toBeFocused();

    // Make one accepted move so we know keys work on the focused board.
    for (const key of ["ArrowLeft", "ArrowUp", "ArrowRight", "ArrowDown"]) await page.keyboard.press(key);
    await expect.poll(async () => (await readSave(page))?.state.acceptedMoves ?? 0).toBeGreaterThan(0);
    await page.waitForTimeout(300);
    const before = await readSave(page);
    const cellsBefore = await readCells(page);

    // Move focus off the board (Tab), then press every bound key: nothing may change.
    await page.keyboard.press("Tab");
    await expect(board).not.toBeFocused();
    for (const key of ["ArrowLeft", "ArrowUp", "ArrowRight", "ArrowDown", "a", "w", "d", "s"]) {
      await page.keyboard.press(key);
    }
    await page.waitForTimeout(500);
    expect(await readCells(page)).toEqual(cellsBefore);
    expect((await readSave(page))?.state).toEqual(before?.state);

    // Shift+Tab returns to the board and keys act again.
    await page.keyboard.press("Shift+Tab");
    await expect(board).toBeFocused();
    for (const key of ["ArrowLeft", "ArrowUp", "ArrowRight", "ArrowDown"]) await page.keyboard.press(key);
    await expect
      .poll(async () => (await readSave(page))?.state.acceptedMoves ?? 0)
      .toBeGreaterThan(before?.state.acceptedMoves ?? 0);
  });

  test("bound keys do not move tiles while typing in a form field", async ({ page }) => {
    await page.goto("/#/play");
    await page.getByRole("button", { name: "Start classic game" }).press("Enter");
    await page.waitForTimeout(200);
    const before = await readSave(page);
    await page.goto("/#/practice");
    const seed = page.getByLabel("Seed (optional)");
    await seed.focus();
    await page.keyboard.type("wasd");
    await page.keyboard.press("ArrowLeft");
    await expect(seed).toHaveValue("wasd");
    expect((await readSave(page))?.state).toEqual(before?.state);
  });
});
