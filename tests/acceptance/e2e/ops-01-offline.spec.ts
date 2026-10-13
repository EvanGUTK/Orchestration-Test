// OPS-01 (partial: guest paths) | Production build with internet disconnected — all asset and guest game
// operations work on loopback. The suite-wide fixture already aborts and fails on any non-loopback
// request; this spec walks every screen and checks that every request is same-origin and succeeds.
import type { Request, Response } from "@playwright/test";
import { boardLocator, expect, gotoRoute, isLocalUrl, readSave, startPractice, test } from "./fixtures.js";

const ROUTES = [
  "/",
  "/modes",
  "/play",
  "/practice",
  "/saves",
  "/challenges",
  "/leaderboards",
  "/duel",
  "/duel/match",
  "/bots",
  "/replays",
  "/profile",
  "/settings",
  "/data",
];

test.describe("OPS-01 offline (guest paths)", () => {
  test("every screen + a guest game load only loopback resources, all successfully", async ({
    page,
    baseURL,
    externalRequests,
  }) => {
    const origin = new URL(baseURL ?? "http://127.0.0.1").origin;
    const requests: Request[] = [];
    const failed: string[] = [];
    const bad: string[] = [];
    page.on("request", (r) => requests.push(r));
    page.on("requestfailed", (r) => failed.push(`${r.url()} ${r.failure()?.errorText ?? ""}`));
    page.on("response", (r: Response) => {
      if (r.status() >= 400) bad.push(`${r.status()} ${r.url()}`);
    });

    for (const path of ROUTES) await gotoRoute(page, path);
    await startPractice(page, { size: 4, seed: "ops01-offline" });
    await boardLocator(page).focus();
    for (const key of ["ArrowLeft", "ArrowDown", "ArrowRight", "ArrowUp"]) await page.keyboard.press(key);
    await expect.poll(async () => (await readSave(page))?.state.acceptedMoves ?? 0).toBeGreaterThan(0);
    await page.reload();
    await gotoRoute(page, "/play");
    await expect(boardLocator(page)).toBeVisible();

    expect(externalRequests).toEqual([]);
    const foreign = requests
      .map((r) => r.url())
      .filter((u) => !isLocalUrl(u) || (u.startsWith("http") && new URL(u).origin !== origin));
    expect(foreign, "requests to anything but the app origin").toEqual([]);
    expect(failed, "failed requests").toEqual([]);
    expect(bad, "HTTP error responses").toEqual([]);
    const kinds = new Set(requests.map((r) => r.resourceType()));
    expect(kinds.has("script") && kinds.has("stylesheet"), `resource types ${[...kinds].join(",")}`).toBe(
      true,
    );
  });

  test("HTML and CSS reference no remote URLs (fonts/images are bundled)", async ({ page, request }) => {
    const sheets: string[] = [];
    page.on("response", async (r) => {
      if (r.request().resourceType() === "stylesheet") sheets.push(await r.text());
    });
    await gotoRoute(page, "/");
    await gotoRoute(page, "/play");
    const html = await (await request.get("/")).text();
    const remote = /(?:src|href)\s*=\s*["']?(?:https?:)?\/\/(?!127\.0\.0\.1|localhost)/i;
    expect(remote.test(html), "remote src/href in index.html").toBe(false);
    await expect.poll(() => sheets.length).toBeGreaterThan(0);
    for (const css of sheets) {
      expect(/url\(\s*["']?(?:https?:)?\/\//i.test(css), "remote url() in CSS").toBe(false);
      expect(/@import\s+(?:url\()?["']?(?:https?:)?\/\//i.test(css), "remote @import in CSS").toBe(false);
    }
    const fontErrors = await page.evaluate(async () => {
      await document.fonts.ready;
      return [...document.fonts].filter((f) => f.status === "error").map((f) => f.family);
    });
    expect(fontErrors).toEqual([]);
  });

  test("the app keeps working when the network is cut mid-session (guest play is local)", async ({
    page,
    context,
  }) => {
    await startPractice(page, { size: 4, seed: "ops01-cut" });
    await context.setOffline(true);
    try {
      await boardLocator(page).focus();
      for (const key of ["ArrowLeft", "ArrowDown", "ArrowRight", "ArrowUp"]) await page.keyboard.press(key);
      await expect.poll(async () => (await readSave(page))?.state.acceptedMoves ?? 0).toBeGreaterThan(0);
      await page.getByRole("link", { name: "Settings" }).first().click();
      await expect(page.locator("h1.page-title")).toHaveText("Settings");
    } finally {
      await context.setOffline(false);
    }
  });

  test("the UI is served with a restrictive Content-Security-Policy (no remote origins)", async ({
    request,
  }) => {
    const res = await request.get("/");
    expect(res.status()).toBe(200);
    const csp = res.headers()["content-security-policy"] ?? "";
    expect(csp, "CSP header on the UI document").toMatch(/default-src 'self'/);
    // no remote hosts or wildcards anywhere in the policy
    expect(csp).not.toMatch(/https?:|\*|data:\s*https?/i);
  });
});

// The product CSP (default-src 'self') would block the page's external fetch before the route guard sees
// it, so ONLY this self-test bypasses CSP to prove the suite-wide guard itself still trips.
test.describe("OPS-01 offline guard self-test", () => {
  test.use({ bypassCSP: true });

  test("guard self-test: a page-initiated external request fails the test (expected failure)", async ({
    page,
  }) => {
    test.fail(
      true,
      "the suite-wide offline fixture must fail any test whose page contacts a non-loopback host",
    );
    await gotoRoute(page, "/");
    await page.evaluate(() => fetch("https://example.com/beacon").catch(() => undefined));
  });
});
