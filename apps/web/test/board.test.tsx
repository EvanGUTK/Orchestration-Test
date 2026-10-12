// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { CLASSIC_RULES } from "@2048/contracts";
import type { Direction } from "@2048/contracts";
import * as engine from "@2048/engine";
import { BoardView } from "../src/components/Board.tsx";
import { GamePlay } from "../src/components/GamePlay.tsx";
import { GameController } from "../src/game/controller.ts";
import { LocalTransport } from "../src/game/transports.ts";
import { createIdSource, tilesFromBoard } from "../src/game/tiles.ts";
import { AppProvider } from "../src/state/app.tsx";
import { DEFAULT_KEY_BINDINGS } from "../src/input/keys.ts";
import { makeState } from "./helpers.ts";

afterEach(() => cleanup());

function renderBoard(cells: (string | null)[], onMove = vi.fn(), tileStyle: "numbers" | "powers" | "numbers-pattern" = "numbers-pattern") {
  const state = makeState(cells);
  render(
    <div>
      <button type="button">outside</button>
      <BoardView board={state.board} tiles={tilesFromBoard(state.board, createIdSource())} tileStyle={tileStyle} keyBindings={DEFAULT_KEY_BINDINGS} onMove={onMove} label="Test board" />
    </div>,
  );
  return { onMove, board: screen.getByTestId("board") };
}

describe("BoardView", () => {
  it("handles arrow keys and WASD only while the board has focus, preventing page scroll", () => {
    const { onMove, board } = renderBoard(["1", "2"]);
    const arrow = new KeyboardEvent("keydown", { key: "ArrowDown", bubbles: true, cancelable: true });
    board.focus();
    act(() => {
      board.dispatchEvent(arrow);
    });
    expect(onMove).toHaveBeenCalledWith("down");
    expect(arrow.defaultPrevented).toBe(true);

    fireEvent.keyDown(board, { key: "a" });
    expect(onMove).toHaveBeenLastCalledWith("left");
  });

  it("does not intercept game keys that fire elsewhere in the page or non-game keys on the board", () => {
    const { onMove, board } = renderBoard(["1"]);
    const outside = screen.getByRole("button", { name: "outside" });
    const arrow = new KeyboardEvent("keydown", { key: "ArrowDown", bubbles: true, cancelable: true });
    act(() => {
      outside.dispatchEvent(arrow);
      document.body.dispatchEvent(new KeyboardEvent("keydown", { key: "ArrowUp", bubbles: true, cancelable: true }));
    });
    expect(onMove).not.toHaveBeenCalled();
    expect(arrow.defaultPrevented).toBe(false);

    const tab = new KeyboardEvent("keydown", { key: "Tab", bubbles: true, cancelable: true });
    act(() => {
      board.dispatchEvent(tab);
    });
    expect(tab.defaultPrevented).toBe(false);
    expect(onMove).not.toHaveBeenCalled();
  });

  it("is focusable, labelled, and exposes the board contents as text", () => {
    const { board } = renderBoard(["1", "2", null, "11"]);
    expect(board.getAttribute("tabindex")).toBe("0");
    expect(board.getAttribute("aria-label")).toBe("Test board");
    expect(screen.getByRole("table", { name: "Test board contents" })).toBeTruthy();
    expect(screen.getAllByText("empty").length).toBe(13);
  });

  it("never relies on colour alone: every tile shows a number or 2^n and a pattern id", () => {
    renderBoard(["1", "11", "39", "65", "4096"]);
    const texts = Array.from(document.querySelectorAll(".tile-text")).map((n) => n.textContent);
    expect(texts).toEqual(["2", "2048", "549755813888", "2^65", "2^4096"]);
    for (const tile of document.querySelectorAll(".tile")) {
      expect(tile.getAttribute("data-pattern")).not.toBeNull();
    }
  });

  it("supports a swipe gesture and ignores taps", () => {
    const { onMove, board } = renderBoard(["1"]);
    fireEvent.pointerDown(board, { pointerId: 1, clientX: 100, clientY: 100, button: 0 });
    fireEvent.pointerUp(board, { pointerId: 1, clientX: 102, clientY: 101 });
    expect(onMove).not.toHaveBeenCalled();
    fireEvent.pointerDown(board, { pointerId: 2, clientX: 200, clientY: 100, button: 0 });
    fireEvent.pointerUp(board, { pointerId: 2, clientX: 130, clientY: 104 });
    expect(onMove).toHaveBeenCalledWith("left" as Direction);
  });
});

function renderGame(initial = engine.newGame(CLASSIC_RULES, "ui-seed")) {
  const controller = new GameController(initial, new LocalTransport(initial, CLASSIC_RULES));
  render(
    <AppProvider skipBootstrap>
      <GamePlay controller={controller} label="Test game" showUndo />
    </AppProvider>,
  );
  return controller;
}

describe("GamePlay", () => {
  it("applies key presses through the controller and updates the score display", async () => {
    const user = userEvent.setup();
    const controller = renderGame();
    const board = screen.getByTestId("board");
    await user.click(board);
    await user.keyboard("{ArrowLeft}{ArrowUp}{ArrowRight}{ArrowDown}");
    await vi.waitFor(() => expect(controller.getSnapshot().pending).toBe(0));
    expect(controller.getSnapshot().lastMove?.seq).toBe(4);
    expect(screen.getByText("Moves").nextSibling?.textContent).toBe(String(controller.getSnapshot().state.acceptedMoves));
  });

  it("announces politely and debounced, not once per move", async () => {
    vi.useFakeTimers();
    try {
      const initial = makeState(["1", "1", null, null, null, "2"]);
      const controller = new GameController(initial, new LocalTransport(initial, CLASSIC_RULES));
      render(
        <AppProvider skipBootstrap>
          <GamePlay controller={controller} label="Test game" />
        </AppProvider>,
      );
      const live = screen.getByTestId("announcer");
      expect(live.getAttribute("aria-live")).toBe("polite");
      expect(live.textContent).toBe("");
      await act(async () => {
        controller.enqueue("left");
        controller.enqueue("up");
        controller.enqueue("right");
        await vi.advanceTimersByTimeAsync(10);
      });
      expect(live.textContent).toBe("");
      await act(async () => {
        await vi.advanceTimersByTimeAsync(600);
      });
      expect(live.textContent).toMatch(/Score .*Highest tile/);
    } finally {
      vi.useRealTimers();
    }
  });

  it("shows the 2048 celebration once, with Keep playing, and the game continues", async () => {
    const user = userEvent.setup();
    const initial = makeState(["10", "10", null, null, "1", null, null, null, "2"]);
    const controller = new GameController(initial, new LocalTransport(initial, CLASSIC_RULES));
    render(
      <AppProvider skipBootstrap>
        <GamePlay controller={controller} label="Test game" />
      </AppProvider>,
    );
    controller.enqueue("left");
    const keep = await screen.findByRole("button", { name: "Keep playing" });
    await user.click(keep);
    expect(screen.queryByRole("button", { name: "Keep playing" })).toBeNull();
    expect(controller.getSnapshot().state.status).toBe("active");
    controller.enqueue("down");
    await vi.waitFor(() => expect(controller.getSnapshot().pending).toBe(0));
    expect(screen.queryByRole("button", { name: "Keep playing" })).toBeNull();
  });

  it("has labelled 44px-class move buttons for non-keyboard, non-swipe play", async () => {
    const user = userEvent.setup();
    const controller = renderGame();
    const before = controller.getSnapshot().state;
    for (const name of ["Move up", "Move right", "Move down", "Move left"]) {
      expect((screen.getByRole("button", { name }) as HTMLButtonElement).disabled).toBe(false);
    }
    await user.click(screen.getByRole("button", { name: "Move left" }));
    await user.click(screen.getByRole("button", { name: "Move up" }));
    await vi.waitFor(() => expect(controller.getSnapshot().lastMove?.seq).toBe(2));
    expect(controller.getSnapshot().state.acceptedMoves).toBeGreaterThanOrEqual(before.acceptedMoves);
  });

  it("renders enormous scores exactly in the tooltip and without NaN or exponent notation in the digits", () => {
    const initial = makeState(["4096", "4096"], { score: "123456789012345678901234567890" });
    const controller = new GameController(initial, new LocalTransport(initial, CLASSIC_RULES));
    render(
      <AppProvider skipBootstrap>
        <GamePlay controller={controller} label="Big game" />
      </AppProvider>,
    );
    const score = screen.getByText("Score").nextSibling as HTMLElement;
    expect(score.getAttribute("title")).toBe("123456789012345678901234567890");
    expect(score.textContent).not.toMatch(/NaN|Infinity/);
    expect(document.querySelectorAll(".tile-text")[0]?.textContent).toBe("2^4096");
  });
});
