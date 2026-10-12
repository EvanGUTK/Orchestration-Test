import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { act, cleanup, fireEvent, render, screen, within } from "@testing-library/react";
import { RULESETS } from "@g2048/contracts";
import { newGame } from "@g2048/engine";
import { App } from "./App.js";
import { createAppServices } from "./app/create-services.js";
import { localEngine } from "./game/local-engine.js";
import { silentSoundPlayer } from "./lib/sound.js";
import { memoryStorage } from "./test/fake-engine.js";
import { ADA, createFakeServer } from "./test/fake-server.js";
import type { FakeServer } from "./test/fake-server.js";

async function go(path: string) {
  await act(async () => {
    window.location.hash = `#${path}`;
    window.dispatchEvent(new HashChangeEvent("hashchange"));
  });
}

async function boot(
  server: FakeServer | null,
  fetchOverride?: (i: string, init?: RequestInit) => Promise<Response>,
) {
  const services = createAppServices({
    engine: localEngine,
    storage: memoryStorage(),
    fetch: fetchOverride ?? ((i, init) => server!.fetch(i, init)),
    sound: silentSoundPlayer,
    sleep: () => Promise.resolve(),
    retryDelays: [1],
    settingsDebounceMs: 0,
  });
  render(<App services={services} />);
  await act(async () => {
    await services.auth.refresh();
  });
  return services;
}

const flush = () => act(async () => new Promise((r) => setTimeout(r, 0)));

beforeEach(() => {
  window.location.hash = "";
});
afterEach(cleanup);

describe("accounts", () => {
  it("signs in with a generic failure message first, then shows the account indicator", async () => {
    const server = createFakeServer();
    await boot(server);
    await go("/");
    expect(screen.getByRole("link", { name: /Playing as guest/ })).toBeTruthy();
    const form = screen.getByRole("form", { name: "Sign in" });
    fireEvent.change(within(form).getByLabelText("Username"), { target: { value: "ADA" } });
    fireEvent.change(within(form).getByLabelText("Password"), { target: { value: "wrong password!" } });
    await act(async () => {
      fireEvent.submit(form);
    });
    expect(screen.getByRole("alert").textContent).toBe("Username or password is incorrect.");
    fireEvent.change(within(form).getByLabelText("Password"), { target: { value: "correct horse battery" } });
    await act(async () => {
      fireEvent.submit(form);
    });
    // Username was normalized to lowercase before sending.
    expect(
      server.requests
        .filter((r) => r.path === "/auth/login")
        .map((r) => (r.body as { username: string }).username),
    ).toEqual(["ada", "ada"]);
    expect(screen.getByRole("link", { name: /Signed in as Ada/ })).toBeTruthy();
  });

  it("validates registration fields against contract limits before sending", async () => {
    const server = createFakeServer();
    await boot(server);
    await go("/");
    fireEvent.click(screen.getByRole("tab", { name: "Create account" }));
    const form = screen.getByRole("form", { name: "Create account" });
    fireEvent.change(within(form).getByLabelText("Username"), { target: { value: "a!" } });
    fireEvent.change(within(form).getByLabelText("Password"), { target: { value: "short" } });
    await act(async () => {
      fireEvent.submit(form);
    });
    expect(within(form).getByLabelText("Username").getAttribute("aria-invalid")).toBe("true");
    expect(within(form).getByText(/at least 12 characters \(now 5\)/)).toBeTruthy();
    expect(server.requests.some((r) => r.path === "/auth/register")).toBe(false);

    fireEvent.change(within(form).getByLabelText("Username"), { target: { value: "Grace_H" } });
    fireEvent.change(within(form).getByLabelText("Display name"), { target: { value: "Grace Hopper" } });
    fireEvent.change(within(form).getByLabelText("Password"), { target: { value: "cobol is forever" } });
    fireEvent.change(within(form).getByLabelText("Confirm password"), {
      target: { value: "cobol is forever" },
    });
    await act(async () => {
      fireEvent.submit(form);
    });
    expect(server.requests.find((r) => r.path === "/auth/register")!.body).toEqual({
      username: "grace_h",
      displayName: "Grace Hopper",
      password: "cobol is forever",
    });
    expect(screen.getByRole("link", { name: /Signed in as Grace Hopper/ })).toBeTruthy();
  });

  it("falls back to offline guest play when the server is unreachable", async () => {
    const services = await boot(null, () => Promise.reject(new TypeError("Failed to fetch")));
    await go("/");
    expect(screen.getByText("Server not reachable")).toBeTruthy();
    expect(screen.getByRole("link", { name: /Guest, offline/ })).toBeTruthy();
    await go("/play");
    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: "Start classic game" }));
    });
    const board = screen.getByRole("application", { name: /game board/ });
    expect(board.querySelectorAll(".tile")).toHaveLength(2);
    expect(services.localGame!.getSnapshot().session!.authority).toBe("local");
  });
});

describe("server-backed play and saves", () => {
  it("plays a server game with keys on the focused board", async () => {
    const server = createFakeServer({ user: ADA });
    const services = await boot(server);
    await go("/play");
    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: "Start classic game" }));
    });
    expect(screen.getByText(/saved on server/)).toBeTruthy();
    const board = screen.getByRole("application", { name: /game board/ });
    for (const key of ["ArrowLeft", "ArrowUp", "ArrowRight", "ArrowDown"]) fireEvent.keyDown(board, { key });
    await act(() => services.serverGame.idle());
    const gameId = [...server.games.keys()][0]!;
    expect(
      server.requests
        .filter((r) => r.path.endsWith("/moves"))
        .map((r) => (r.body as { direction: string }).direction),
    ).toEqual(["left", "up", "right", "down"]);
    expect(services.serverGame.getSnapshot().session!.state.revision).toBe(
      server.games.get(gameId)!.state.revision,
    );
  });

  it("lists saves with cursor pagination and resumes one", async () => {
    const server = createFakeServer({ user: ADA });
    for (let i = 0; i < 27; i++) server.seedGame(newGame(RULESETS["classic-v1"], `seed-${i}`));
    const services = await boot(server);
    await go("/saves");
    await flush();
    expect(screen.getAllByRole("button", { name: /^Resume / })).toHaveLength(20);
    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: "Load more" }));
    });
    expect(screen.getAllByRole("button", { name: /^Resume / })).toHaveLength(27);
    expect(screen.queryByRole("button", { name: "Load more" })).toBeNull();
    expect(server.requests.some((r) => r.path.startsWith("/games") && r.method === "GET")).toBe(true);

    await act(async () => {
      fireEvent.click(screen.getAllByRole("button", { name: /^Resume / })[0]!);
    });
    expect(services.serverGame.getSnapshot().session?.id).toBe("g27");
    expect(screen.getByRole("heading", { level: 1 }).textContent).toBe("Solo board");
  });

  it("shows empty and error states with specific recovery actions", async () => {
    const server = createFakeServer({ user: ADA });
    await boot(server);
    server.faults.offline = true;
    await go("/saves");
    await flush();
    const alert = screen.getByRole("alert");
    expect(alert.textContent).toMatch(/Couldn't load your saved games/);
    server.faults.offline = false;
    await act(async () => {
      fireEvent.click(within(alert).getByRole("button", { name: "Try again" }));
    });
    expect(screen.getByText(/No saved games yet/)).toBeTruthy();
    expect(screen.getByRole("link", { name: "Start a game" })).toBeTruthy();
  });

  it("stalls on connection loss with Retry, then applies every waiting move once", async () => {
    const server = createFakeServer({ user: ADA });
    const services = await boot(server);
    await go("/play");
    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: "Start classic game" }));
    });
    const board = screen.getByRole("application", { name: /game board/ });
    server.faults.offline = true;
    fireEvent.keyDown(board, { key: "ArrowLeft" });
    fireEvent.keyDown(board, { key: "ArrowRight" });
    await act(() => services.serverGame.idle());
    expect(screen.getByText(/2 moves are waiting/)).toBeTruthy();
    server.faults.offline = false;
    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: "Retry now" }));
    });
    await act(() => services.serverGame.idle());
    const gameId = [...server.games.keys()][0]!;
    expect(services.serverGame.getSnapshot().session!.state.revision).toBe(
      server.games.get(gameId)!.state.revision,
    );
    expect(screen.queryByText(/moves are waiting/)).toBeNull();
  });
});
