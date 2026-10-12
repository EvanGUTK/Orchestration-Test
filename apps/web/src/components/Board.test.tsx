import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, createEvent, fireEvent, render, screen } from "@testing-library/react";
import type { Board as BoardModel, Cell } from "@g2048/contracts";
import { DEFAULT_KEY_BINDINGS } from "../input/keyboard.js";
import { Board } from "./Board.js";
import { ScoreDisplay } from "./ScoreDisplay.js";

afterEach(cleanup);

function board(size: number, fill: Record<number, string> = {}): BoardModel {
  const cells: Cell[] = Array.from({ length: size * size }, (_, i) => fill[i] ?? null);
  return { size, cells };
}

function renderBoard(model: BoardModel, onMove = vi.fn()) {
  render(
    <Board
      board={model}
      tileStyle="auto"
      bindings={DEFAULT_KEY_BINDINGS}
      onMove={onMove}
      label="Test board"
    />,
  );
  return { el: screen.getByRole("application", { name: "Test board" }), onMove };
}

describe("Board rendering", () => {
  it.each([3, 4, 5, 6, 7, 8])("renders a %ix%i grid", (size) => {
    const { el } = renderBoard(board(size, { 0: "1" }));
    expect(el.querySelectorAll(".cell")).toHaveLength(size * size);
    expect(el.getAttribute("data-size")).toBe(String(size));
  });

  it("labels tiles with their value as text, not just color", () => {
    renderBoard(board(4, { 0: "1", 5: "11", 15: "17" }));
    expect(screen.getByRole("img", { name: "2" }).textContent).toBe("2");
    expect(screen.getByRole("img", { name: "2048" }).textContent).toBe("2048");
    expect(screen.getByRole("img", { name: "131072" }).textContent).toBe("131072");
  });

  it("renders an exponent-4096 tile as 2^4096 with the exact decimal in its tooltip", () => {
    renderBoard(board(4, { 3: "4096" }));
    const tile = screen.getByRole("img", { name: /2 to the power 4096/ });
    expect(tile.textContent).toBe("24096");
    expect(tile.querySelector("sup")?.textContent).toBe("4096");
    expect(tile.getAttribute("title")).toBe(`2^4096 = ${(1n << 4096n).toString()}`);
    expect(tile.getAttribute("data-kind")).toBe("power");
  });

  it("marks animations from events without changing what is rendered", () => {
    const model = board(4, { 0: "2", 3: "1" });
    render(
      <Board
        board={model}
        tileStyle="auto"
        bindings={DEFAULT_KEY_BINDINGS}
        label="Animated"
        lastMove={{
          seq: 1,
          direction: "left",
          events: [
            { type: "tile.moved", from: 1, to: 0, exponent: "1" },
            { type: "tile.moved", from: 2, to: 0, exponent: "1" },
            { type: "tile.merged", to: 0, sources: [1, 2], exponent: "2", value: "4" },
            { type: "tile.spawned", at: 3, exponent: "1" },
          ],
        }}
      />,
    );
    const merged = screen.getByRole("img", { name: "4" });
    expect(merged.getAttribute("data-anim")).toBe("merge");
    expect(merged.style.getPropertyValue("--dx")).toBe("2");
    expect(screen.getByRole("img", { name: "2" }).getAttribute("data-anim")).toBe("spawn");
  });
});

describe("Board keyboard handling", () => {
  it("handles game keys only while the board is focused and prevents scrolling only then", () => {
    const { el, onMove } = renderBoard(board(4, { 0: "1" }));
    const outside = createEvent.keyDown(document.body, { key: "ArrowDown", cancelable: true });
    fireEvent(document.body, outside);
    expect(onMove).not.toHaveBeenCalled();
    expect(outside.defaultPrevented).toBe(false);

    el.focus();
    const inside = createEvent.keyDown(el, { key: "ArrowDown", cancelable: true });
    fireEvent(el, inside);
    expect(onMove).toHaveBeenCalledWith("down", false);
    expect(inside.defaultPrevented).toBe(true);

    fireEvent.keyDown(el, { key: "a" });
    fireEvent.keyDown(el, { key: "W" });
    expect(onMove.mock.calls.map((c) => c[0])).toEqual(["down", "left", "up"]);
  });

  it("leaves unbound and modified keys alone", () => {
    const { el, onMove } = renderBoard(board(4));
    const tab = createEvent.keyDown(el, { key: "Tab", cancelable: true });
    fireEvent(el, tab);
    const ctrl = createEvent.keyDown(el, { key: "a", ctrlKey: true, cancelable: true });
    fireEvent(el, ctrl);
    expect(onMove).not.toHaveBeenCalled();
    expect(tab.defaultPrevented).toBe(false);
    expect(ctrl.defaultPrevented).toBe(false);
  });

  it("passes auto-repeat through so the controller can rate-limit held keys", () => {
    const { el, onMove } = renderBoard(board(4));
    fireEvent.keyDown(el, { key: "ArrowLeft", repeat: true });
    expect(onMove).toHaveBeenCalledWith("left", true);
  });
});

describe("ScoreDisplay", () => {
  it("shows short scores exactly", () => {
    render(<ScoreDisplay label="Score" value="1234567" />);
    expect(screen.getByText("1,234,567")).toBeTruthy();
  });

  it("shows a huge score compactly with the exact value one click away", () => {
    const huge = "31415926535897932384626433832795028841971693993751";
    render(<ScoreDisplay label="Score" value={huge} />);
    expect(screen.getByText("3.14159… × 10^49")).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Show all 50 digits" }));
    expect(screen.getByText(huge)).toBeTruthy();
  });
});
