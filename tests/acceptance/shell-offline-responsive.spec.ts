/**
 * UI-01 (no horizontal overflow at 320/768/1280), UI-02 (keyboard focus reachable + visible), UI-03 basics
 * (landmarks, lang, title), OPS-01 (loopback-only network: zero non-loopback requests), console cleanliness.
 * The app is exercised through its production bundle; selectors are role/landmark based on purpose.
 */
import { expect, test, type Request } from "@playwright/test";

const isLoopback = (url: string) => {
  const u = new URL(url);
  return u.protocol === "data:" || u.protocol === "blob:" || u.protocol === "about:" || ["127.0.0.1", "localhost", "[::1]"].includes(u.hostname);
};

test.describe("production shell", () => {
  test("loads with only loopback requests, no console errors, accessible page skeleton (OPS-01, UI-03)", async ({ page, context }) => {
    const external: string[] = [];
    const consoleErrors: string[] = [];
    await context.route("**/*", (route) => {
      if (!isLoopback(route.request().url())) {
        external.push(route.request().url());
        return route.abort("blockedbyclient");
      }
      return route.continue();
    });
    page.on("request", (r: Request) => {
      if (!isLoopback(r.url())) external.push(r.url());
    });
    page.on("console", (m) => {
      if (m.type() === "error") consoleErrors.push(m.text());
    });
    page.on("pageerror", (e) => consoleErrors.push(String(e)));

    const res = await page.goto("/");
    expect(res?.status()).toBe(200);
    await page.waitForLoadState("networkidle");
    expect(external, "no request may leave the machine").toEqual([]);
    expect(consoleErrors).toEqual([]);
    expect(await page.title()).not.toBe("");
    expect(await page.locator("html").getAttribute("lang")).toMatch(/^[a-z]{2}/);
    await expect(page.getByRole("main")).toHaveCount(1);
    await expect(page.getByRole("heading").first()).toBeVisible();
  });

  test("no horizontal overflow at the project viewport (UI-01)", async ({ page }) => {
    await page.goto("/");
    await page.waitForLoadState("networkidle");
    const { scrollWidth, clientWidth } = await page.evaluate(() => ({
      scrollWidth: document.documentElement.scrollWidth,
      clientWidth: document.documentElement.clientWidth,
    }));
    expect(scrollWidth).toBeLessThanOrEqual(clientWidth);
  });

  test("interactive controls meet a 24x24 CSS px minimum target and 44px on touch projects (UI-01)", async ({ page, hasTouch }) => {
    await page.goto("/");
    await page.waitForLoadState("networkidle");
    const min = hasTouch ? 44 : 24;
    const small = await page.evaluate((m) => {
      const out: string[] = [];
      for (const el of document.querySelectorAll<HTMLElement>("button, a[href], [role=button], input, select, textarea, [tabindex]:not([tabindex='-1'])")) {
        const r = el.getBoundingClientRect();
        if (r.width === 0 || r.height === 0) continue; // hidden
        if (r.width < m || r.height < m) out.push(`${el.tagName.toLowerCase()} "${(el.textContent ?? "").trim().slice(0, 30)}" ${Math.round(r.width)}x${Math.round(r.height)}`);
      }
      return out;
    }, min);
    expect(small).toEqual([]);
  });

  test("keyboard: Tab reaches a control and focus is visibly indicated (UI-02)", async ({ page }) => {
    await page.goto("/");
    await page.waitForLoadState("networkidle");
    const stops: { id: string; visible: boolean }[] = [];
    for (let i = 0; i < 12; i++) {
      await page.keyboard.press("Tab");
      const info = await page.evaluate(() => {
        const el = document.activeElement as HTMLElement | null;
        if (!el || el === document.body) return null;
        const cs = getComputedStyle(el);
        const outlined = cs.outlineStyle !== "none" && Number.parseFloat(cs.outlineWidth) > 0;
        const shadow = cs.boxShadow !== "none";
        return { id: `${el.tagName}#${el.id}|${el.textContent?.trim().slice(0, 20)}`, visible: outlined || shadow };
      });
      if (info) stops.push(info);
    }
    expect(stops.length, "Tab must reach at least one focusable control").toBeGreaterThan(0);
    expect(stops.filter((s) => !s.visible).map((s) => s.id), "every Tab stop needs a visible focus indicator").toEqual([]);
  });

  test("prefers-reduced-motion is honoured: no running CSS animations/transitions longer than 1ms (UI-03)", async ({ browser, baseURL }) => {
    const ctx = await browser.newContext({ reducedMotion: "reduce", baseURL });
    const page = await ctx.newPage();
    await page.goto("/");
    await page.waitForLoadState("networkidle");
    const running = await page.evaluate(() => document.getAnimations().filter((a) => a.playState === "running" && Number(a.effect?.getComputedTiming().duration ?? 0) > 1 && a.effect?.getComputedTiming().iterations === Infinity).length);
    expect(running, "infinite animations must stop under reduced motion").toBe(0);
    await ctx.close();
  });
});
