// UI-01 | 320px/mobile/tablet/desktop — playable without horizontal overflow; usable touch targets.
import { boardLocator, expect, readSave, startClassic, test } from "./fixtures.js";

const VIEWPORTS = [
  { name: "320px phone", width: 320, height: 640 },
  { name: "375px phone", width: 375, height: 812 },
  { name: "768px tablet", width: 768, height: 1024 },
  { name: "1280px desktop", width: 1280, height: 800 },
];
const MIN_TARGET = 44;

for (const vp of VIEWPORTS) {
  test.describe(`UI-01 board screen at ${vp.name}`, () => {
    test.use({ viewport: { width: vp.width, height: vp.height } });

    test("no horizontal overflow; board fits the viewport width", async ({ page }) => {
      await startClassic(page);
      const dims = await page.evaluate(() => ({
        doc: document.documentElement.scrollWidth,
        body: document.body.scrollWidth,
        client: document.documentElement.clientWidth,
      }));
      expect(dims.doc, "documentElement scrollWidth").toBeLessThanOrEqual(dims.client);
      expect(dims.body, "body scrollWidth").toBeLessThanOrEqual(dims.client);
      const box = await boardLocator(page).boundingBox();
      expect(box).not.toBeNull();
      expect(box!.x).toBeGreaterThanOrEqual(0);
      expect(box!.x + box!.width).toBeLessThanOrEqual(vp.width);
    });

    test(`every visible control on the board screen is at least ${MIN_TARGET}x${MIN_TARGET}px`, async ({
      page,
    }) => {
      await startClassic(page);
      const { checked, small } = await page
        .locator("button, a[href], input, select, textarea, [role=application], [role=tab]")
        .evaluateAll((els, min) => {
          const out: string[] = [];
          let n = 0;
          for (const el of els) {
            const r = el.getBoundingClientRect();
            const s = getComputedStyle(el);
            const visible = r.width > 0 && r.height > 0 && s.visibility !== "hidden" && s.display !== "none";
            if (!visible) continue;
            n++;
            if (r.width < min || r.height < min) {
              const name = (el.getAttribute("aria-label") ?? el.textContent ?? "")
                .replace(/\s+/g, " ")
                .trim();
              out.push(
                `${el.tagName.toLowerCase()} "${name}" ${Math.round(r.width)}x${Math.round(r.height)}`,
              );
            }
          }
          return { checked: n, small: out };
        }, MIN_TARGET);
      // board + 4 direction buttons + New game/Undo/Read board aloud at minimum
      expect(checked).toBeGreaterThanOrEqual(8);
      expect(small, `targets smaller than ${MIN_TARGET}px`).toEqual([]);
    });

    test("playable: direction buttons and keyboard both apply moves", async ({ page }) => {
      await startClassic(page);
      // A fresh 2-tile board always has a legal move among the four directions.
      for (const name of ["Move left", "Move up", "Move right", "Move down"]) {
        await page.getByRole("button", { name }).click();
      }
      await expect
        .poll(async () => (await readSave(page))?.state.acceptedMoves ?? 0, {
          message: "buttons applied a move",
        })
        .toBeGreaterThan(0);
      const afterButtons = (await readSave(page))?.state.acceptedMoves ?? 0;
      await boardLocator(page).focus();
      for (const key of ["ArrowLeft", "ArrowUp", "ArrowRight", "ArrowDown"]) {
        await page.keyboard.press(key);
      }
      await expect
        .poll(async () => (await readSave(page))?.state.acceptedMoves ?? 0, {
          message: "keys applied a move",
        })
        .toBeGreaterThan(afterButtons);
    });
  });
}
