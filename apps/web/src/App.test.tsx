import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { act, cleanup, fireEvent, render, screen, within } from "@testing-library/react";
import { App } from "./App.js";
import { ROUTES } from "./app/routes.js";
import { createAppServices } from "./app/create-services.js";
import { localEngine } from "./game/local-engine.js";
import { silentSoundPlayer } from "./lib/sound.js";
import { createFakeEngine, memoryStorage } from "./test/fake-engine.js";

async function go(path: string) {
  await act(async () => {
    window.location.hash = `#${path}`;
    window.dispatchEvent(new HashChangeEvent("hashchange"));
  });
}

beforeEach(() => {
  window.location.hash = "";
  delete document.documentElement.dataset.theme;
});
afterEach(cleanup);

describe("App shell", () => {
  it("links every required screen from the main navigation", async () => {
    const services = createAppServices({
      engine: localEngine,
      storage: memoryStorage(),
      sound: silentSoundPlayer,
    });
    render(<App services={services} />);
    const nav = screen.getByRole("navigation", { name: "Main" });
    const links = within(nav).getAllByRole("link");
    expect(links).toHaveLength(ROUTES.length);
    for (const route of ROUTES) {
      await go(route.path);
      expect(screen.getByRole("heading", { level: 1 }).textContent).toBe(route.title);
    }
  });

  it("shows honest unavailable states without fake rankings or numbers", async () => {
    const services = createAppServices({
      engine: localEngine,
      storage: memoryStorage(),
      sound: silentSoundPlayer,
    });
    render(<App services={services} />);
    for (const path of [
      "/leaderboards",
      "/challenges",
      "/profile",
      "/duel",
      "/duel/match",
      "/bots",
      "/replays",
    ]) {
      await go(path);
      const main = screen.getByRole("main");
      expect(within(main).getByText("Not available yet")).toBeTruthy();
      expect(main.querySelector("table, ol")).toBeNull();
      expect(main.textContent).not.toMatch(/\b(1st|#1|Elo \d|\d{3,} pts)\b/);
    }
  });

  it("shows an unavailable engine state when no engine is provided", async () => {
    const services = createAppServices({ engine: null, storage: memoryStorage(), sound: silentSoundPlayer });
    render(<App services={services} />);
    await go("/play");
    expect(screen.getByText(/engine has not been integrated/)).toBeTruthy();
  });

  it("switches theme from the settings screen and persists it", async () => {
    const storage = memoryStorage();
    const services = createAppServices({ engine: localEngine, storage, sound: silentSoundPlayer });
    render(<App services={services} />);
    await go("/settings");
    fireEvent.click(screen.getByRole("radio", { name: "Dark" }));
    expect(document.documentElement.dataset.theme).toBe("dark");
    fireEvent.click(screen.getByRole("radio", { name: "High contrast" }));
    expect(document.documentElement.dataset.theme).toBe("high-contrast");
    fireEvent.click(screen.getByRole("radio", { name: "Reduced" }));
    expect(document.documentElement.dataset.motion).toBe("reduced");
    expect(storage.getItem("g2048.guest.preferences.v1")).toContain('"theme":"high-contrast"');
  });
});

describe("Guest play end-to-end", () => {
  it("starts a real classic game and plays it with keys on the focused board only", async () => {
    const storage = memoryStorage();
    const services = createAppServices({ engine: localEngine, storage, sound: silentSoundPlayer });
    render(<App services={services} />);
    await go("/play");
    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: "Start classic game" }));
    });
    const board = screen.getByRole("application", { name: /4 by 4 game board/ });
    expect(board.querySelectorAll(".tile")).toHaveLength(2);
    expect(document.activeElement).toBe(board);

    // Keys outside the board do nothing.
    fireEvent.keyDown(document.body, { key: "ArrowLeft" });
    await act(() => services.game!.idle());
    expect(services.game!.getSnapshot().session!.state.revision).toBe(0);

    for (const key of ["ArrowLeft", "ArrowUp", "ArrowRight", "ArrowDown", "a", "w", "d", "s"]) {
      fireEvent.keyDown(board, { key });
    }
    await act(() => services.game!.idle());
    const state = services.game!.getSnapshot().session!.state;
    expect(state.acceptedMoves).toBeGreaterThan(0);
    expect(board.querySelectorAll(".tile").length).toBe(state.board.cells.filter((c) => c !== null).length);
    expect(storage.getItem("g2048.guest.game.v1")).toContain(`\\"revision\\":${state.revision}`);
  });

  it("applies a rapid burst from keys and on-screen buttons in exact order", async () => {
    const engine = createFakeEngine();
    const services = createAppServices({ engine, storage: memoryStorage(), sound: silentSoundPlayer });
    render(<App services={services} />);
    await go("/play");
    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: "Start classic game" }));
    });
    const board = screen.getByRole("application", { name: /game board/ });
    fireEvent.keyDown(board, { key: "ArrowLeft" });
    fireEvent.click(screen.getByRole("button", { name: "Move up" }));
    fireEvent.keyDown(board, { key: "d" });
    fireEvent.click(screen.getByRole("button", { name: "Move down" }));
    fireEvent.keyDown(board, { key: "ArrowLeft" });
    await act(() => services.game!.idle());
    expect(engine.calls).toEqual(["left", "up", "right", "down", "left"]);
  });

  it("starts a practice game with a chosen size and seed", async () => {
    const services = createAppServices({
      engine: localEngine,
      storage: memoryStorage(),
      sound: silentSoundPlayer,
    });
    render(<App services={services} />);
    await go("/practice");
    fireEvent.click(screen.getByRole("radio", { name: "7×7" }));
    fireEvent.change(screen.getByLabelText("Seed (optional)"), { target: { value: "my-seed" } });
    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: "Start practice game" }));
    });
    await act(async () => {
      window.dispatchEvent(new HashChangeEvent("hashchange"));
    });
    const board = screen.getByRole("application", { name: /7 by 7 game board/ });
    expect(board.querySelectorAll(".cell")).toHaveLength(49);
    expect(screen.getByText("my-seed")).toBeTruthy();
  });
});
