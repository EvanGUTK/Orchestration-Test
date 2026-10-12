// Shared Playwright fixtures for the guest-path e2e suite (QA-E2E-001).
// Every test runs "offline": an auto fixture intercepts ALL requests, lets loopback/data/blob through,
// aborts anything else as internet-disconnected, and fails the test if any such request was attempted.
import { test as base, expect } from "@playwright/test";
import type { Locator, Page } from "@playwright/test";
import type { Cell, GameState } from "@g2048/contracts";

export const GUEST_SAVE_KEY = "g2048.guest.game.v1";
const LOOPBACK_HOSTS = new Set(["127.0.0.1", "localhost", "[::1]", "::1"]);

export function isLocalUrl(raw: string): boolean {
  const url = new URL(raw);
  if (["data:", "blob:", "about:"].includes(url.protocol)) return true;
  return LOOPBACK_HOSTS.has(url.hostname);
}

type Fixtures = {
  /** Non-loopback request URLs that were attempted (and aborted). Must stay empty. */
  externalRequests: string[];
  /** Uncaught page errors; must stay empty. */
  pageErrors: string[];
};

export const test = base.extend<Fixtures>({
  externalRequests: [
    async ({ context }, use) => {
      const external: string[] = [];
      await context.route("**/*", (route) => {
        const url = route.request().url();
        if (isLocalUrl(url)) return route.continue();
        external.push(url);
        return route.abort("internetdisconnected");
      });
      await use(external);
      expect(external, "the app must make zero non-loopback requests").toEqual([]);
    },
    { auto: true },
  ],
  pageErrors: [
    async ({ page }, use) => {
      const errors: string[] = [];
      page.on("pageerror", (e) => errors.push(String(e)));
      await use(errors);
      expect(errors, "uncaught page errors").toEqual([]);
    },
    { auto: true },
  ],
});
export { expect };

// ------------------------------------------------------------------ navigation / board helpers

export async function gotoRoute(page: Page, path: string): Promise<void> {
  await page.goto(`/#${path}`);
  await expect(page.locator("h1.page-title")).toBeVisible();
}

export function boardLocator(page: Page): Locator {
  return page.getByRole("application", { name: /game board/ });
}

export async function startClassic(page: Page): Promise<void> {
  await gotoRoute(page, "/play");
  await page.getByRole("button", { name: "Start classic game" }).click();
  await expect(boardLocator(page)).toBeVisible();
}

export async function startPractice(
  page: Page,
  opts: { size: number; seed: string; fourWeightPercent?: number },
): Promise<void> {
  await gotoRoute(page, "/practice");
  await page.getByRole("radio", { name: `${opts.size}×${opts.size}` }).check();
  if (opts.fourWeightPercent !== undefined) {
    await page.getByLabel("Chance a new tile is a 4").fill(String(opts.fourWeightPercent / 10));
  }
  await page.getByLabel("Seed (optional)").fill(opts.seed);
  await page.getByRole("button", { name: "Start practice game" }).click();
  await expect(boardLocator(page)).toBeVisible();
  await expect(page.locator("code.seed")).toHaveText(opts.seed);
}

/** Authoritative cells as rendered (row-major, data-exp of the tile in each cell, or null). */
export async function readCells(page: Page): Promise<Cell[]> {
  return page
    .locator(".board .cell")
    .evaluateAll((cells) => cells.map((c) => c.querySelector(".tile")?.getAttribute("data-exp") ?? null));
}

/** Guest autosave from localStorage, parsed (state is the engine's canonical JSON). */
export async function readSave(
  page: Page,
): Promise<{ raw: { mode: string; seed: string | null; state: string }; state: GameState } | null> {
  const text = await page.evaluate((key) => window.localStorage.getItem(key), GUEST_SAVE_KEY);
  if (text === null) return null;
  const raw = JSON.parse(text) as { mode: string; seed: string | null; state: string };
  return { raw, state: JSON.parse(raw.state) as GameState };
}

export async function waitForAcceptedMoves(page: Page, n: number, timeout = 10_000): Promise<void> {
  await expect
    .poll(async () => (await readSave(page))?.state.acceptedMoves, {
      timeout,
      message: `acceptedMoves -> ${n}`,
    })
    .toBe(n);
}

/** True when the focused element (or a close ancestor) shows a focus indicator. */
export async function focusIndicatorVisible(page: Page): Promise<boolean> {
  return page.evaluate(() => {
    let el: Element | null = document.activeElement;
    for (let depth = 0; el && depth < 3; depth++, el = el.parentElement) {
      const s = getComputedStyle(el);
      const outline = s.outlineStyle !== "none" && Number.parseFloat(s.outlineWidth) > 0;
      const shadow = s.boxShadow !== "none" && s.boxShadow !== "";
      if (outline || shadow) return true;
    }
    return false;
  });
}

export type FocusInfo = { tag: string; role: string | null; name: string; type: string | null };

export async function focusInfo(page: Page): Promise<FocusInfo> {
  return page.evaluate(() => {
    const el = document.activeElement as HTMLElement | null;
    if (!el) return { tag: "", role: null, name: "", type: null };
    const labelled = el.getAttribute("aria-labelledby");
    const byId = labelled ? (document.getElementById(labelled)?.textContent ?? "") : "";
    const label = (el as HTMLInputElement).labels?.[0]?.textContent ?? "";
    const name = (el.getAttribute("aria-label") ?? byId ?? "") || label || el.textContent || "";
    return {
      tag: el.tagName.toLowerCase(),
      role: el.getAttribute("role"),
      name: name.replace(/\s+/g, " ").trim(),
      type: el.getAttribute("type"),
    };
  });
}

/** Presses Tab until the focused element matches; asserts a visible focus indicator on it. */
export async function tabTo(page: Page, match: (f: FocusInfo) => boolean, max = 80): Promise<FocusInfo> {
  for (let i = 0; i < max; i++) {
    await page.keyboard.press("Tab");
    const f = await focusInfo(page);
    if (match(f)) {
      expect(await focusIndicatorVisible(page), `visible focus on ${f.tag} "${f.name}"`).toBe(true);
      return f;
    }
  }
  throw new Error(`Tab never reached the requested element within ${max} presses`);
}
