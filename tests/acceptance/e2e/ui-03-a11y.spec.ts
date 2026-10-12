// UI-03 | Screen reader / reduced motion / contrast — meaningful board/score announcements;
// no color-only values; motion respects the setting. axe-core WCAG 2.2 A/AA scans.
import { AxeBuilder } from "@axe-core/playwright";
import type { Page } from "@playwright/test";
import { boardLocator, expect, gotoRoute, readSave, startClassic, test } from "./fixtures.js";

const WCAG_TAGS = ["wcag2a", "wcag2aa", "wcag21a", "wcag21aa", "wcag22aa"];

async function axe(page: Page): Promise<string[]> {
  const result = await new AxeBuilder({ page }).withTags(WCAG_TAGS).analyze();
  // guard against a vacuous scan (e.g. an empty or not-yet-rendered page)
  expect(result.passes.length, "axe rules that passed").toBeGreaterThan(10);
  return result.violations.map(
    (v) => `${v.id} (${v.impact}): ${v.nodes.length} node(s) e.g. ${v.nodes[0]?.target.join(" ") ?? ""}`,
  );
}

async function playSomeMoves(page: Page): Promise<void> {
  await boardLocator(page).focus();
  for (const key of ["ArrowLeft", "ArrowDown", "ArrowRight", "ArrowDown", "ArrowLeft", "ArrowUp"]) {
    await page.keyboard.press(key);
  }
  await expect.poll(async () => (await readSave(page))?.state.acceptedMoves ?? 0).toBeGreaterThan(0);
}

async function chooseSetting(page: Page, legend: string, option: string): Promise<void> {
  await gotoRoute(page, "/settings");
  await page.getByRole("group", { name: legend }).getByRole("radio", { name: option }).check();
}

test.describe("UI-03 accessibility", () => {
  for (const path of [
    "/",
    "/modes",
    "/practice",
    "/saves",
    "/settings",
    "/data",
    "/challenges",
    "/replays",
  ]) {
    test(`axe: no WCAG 2.2 A/AA violations on ${path}`, async ({ page }) => {
      await gotoRoute(page, path);
      expect(await axe(page)).toEqual([]);
    });
  }

  for (const theme of ["Light", "Dark", "High contrast"]) {
    test(`axe: board screen with tiles in the ${theme} theme`, async ({ page }) => {
      await chooseSetting(page, "Theme", theme);
      await startClassic(page);
      await playSomeMoves(page);
      await expect(page.locator("html")).toHaveAttribute(
        "data-theme",
        theme === "High contrast" ? "high-contrast" : theme.toLowerCase(),
      );
      expect(await axe(page)).toEqual([]);
    });
  }

  test("OS 'more contrast' preference selects the high-contrast theme", async ({ page }) => {
    await page.emulateMedia({ contrast: "more" });
    await startClassic(page);
    await expect(page.locator("html")).toHaveAttribute("data-theme", "high-contrast");
    expect(await axe(page)).toEqual([]);
  });

  test("reduced motion (OS preference): no tile animations or transitions", async ({ page }) => {
    await page.emulateMedia({ reducedMotion: "reduce" });
    await startClassic(page);
    await expect(page.locator("html")).toHaveAttribute("data-motion", "reduced");
    await playSomeMoves(page);
    const animated = await page.locator(".tile").evaluateAll((tiles) =>
      tiles
        .map((t) => getComputedStyle(t))
        .filter(
          (s) =>
            s.animationName !== "none" || (s.transitionDuration !== "0s" && s.transitionProperty !== "none"),
        )
        .map((s) => `${s.animationName}/${s.transitionDuration}`),
    );
    expect(animated).toEqual([]);
  });

  test("full motion control: moved tiles do animate (so the reduced-motion check is meaningful)", async ({
    page,
  }) => {
    await page.emulateMedia({ reducedMotion: "no-preference" });
    await startClassic(page);
    await expect(page.locator("html")).toHaveAttribute("data-motion", "full");
    await playSomeMoves(page);
    const names = await page
      .locator(".tile[data-anim]")
      .evaluateAll((tiles) => tiles.map((t) => getComputedStyle(t).animationName));
    expect(names.some((n) => n !== "none")).toBe(true);
  });

  test("Settings 'Reduced' motion overrides an OS without a preference", async ({ page }) => {
    await page.emulateMedia({ reducedMotion: "no-preference" });
    await chooseSetting(page, "Motion", "Reduced");
    await expect(page.locator("html")).toHaveAttribute("data-motion", "reduced");
  });

  for (const [style, expectPower] of [
    ["Prefer numbers", false],
    ["Powers of two", true],
  ] as const) {
    test(`tile values are text, not color-only (${style})`, async ({ page }) => {
      await chooseSetting(page, "Tile labels", style);
      await startClassic(page);
      await playSomeMoves(page);
      const tiles = await page.locator(".board .tile").evaluateAll((els) =>
        els.map((el) => ({
          exp: el.getAttribute("data-exp") ?? "",
          label: el.getAttribute("aria-label") ?? "",
          role: el.getAttribute("role"),
          text: (el.querySelector(".tile__text") as HTMLElement | null)?.innerText.replace(/\s+/g, "") ?? "",
        })),
      );
      expect(tiles.length).toBeGreaterThanOrEqual(2);
      for (const t of tiles) {
        const value = String(2n ** BigInt(t.exp));
        expect(t.role).toBe("img");
        expect(t.label, `aria-label of exponent ${t.exp}`).toContain(value);
        expect(t.text.length, `visible text of exponent ${t.exp}`).toBeGreaterThan(0);
        expect(t.text).toBe(expectPower ? `2${t.exp}` : value);
      }
      // distinct values always have distinct visible text
      const byExp = new Map(tiles.map((t) => [t.exp, t.text]));
      expect(new Set(byExp.values()).size).toBe(byExp.size);
    });
  }

  test("board has an accessible name; moves and 'Read board aloud' produce live announcements", async ({
    page,
  }) => {
    await startClassic(page);
    const board = boardLocator(page);
    await expect(board).toHaveAttribute("aria-roledescription", "game board");
    await expect(board).toHaveAccessibleName("4 by 4 game board");
    const live = page.getByTestId("live-region");
    await expect(live).toHaveAttribute("aria-live", "polite");
    await playSomeMoves(page);
    await expect.poll(async () => ((await live.textContent()) ?? "").trim().length).toBeGreaterThan(0);

    await page.getByRole("button", { name: "Read board aloud" }).click();
    const save = await readSave(page);
    const values = (save?.state.board.cells ?? [])
      .filter((c) => c !== null)
      .map((e) => String(2n ** BigInt(e)));
    await expect
      .poll(
        async () => {
          const text = (await live.textContent()) ?? "";
          return values.every((v) => text.includes(v));
        },
        { message: "announcement mentions every tile value on the board" },
      )
      .toBe(true);
  });

  test("score is exposed with a text label", async ({ page }) => {
    await startClassic(page);
    await playSomeMoves(page);
    const score = (await readSave(page))?.state.score ?? "0";
    await expect(page.getByText("Score", { exact: true }).first()).toBeVisible();
    await expect(page.locator(".stats")).toContainText(score === "0" ? "0" : score.slice(0, 3));
  });
});
