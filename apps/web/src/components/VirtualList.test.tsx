import { afterEach, describe, expect, it } from "vitest";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { VirtualList } from "./VirtualList.js";

afterEach(cleanup);

describe("VirtualList", () => {
  it("renders only a window of rows for a 200,000-row list, with size/position for assistive tech", () => {
    render(
      <VirtualList
        count={200_000}
        rowHeight={44}
        height={264}
        label="Moves (200000)"
        renderRow={(i) => <span>move {i + 1}</span>}
      />,
    );
    const list = screen.getByRole("list", { name: "Moves (200000)" });
    const rows = list.querySelectorAll("li");
    expect(rows.length).toBeLessThan(30);
    expect(rows[0]!.getAttribute("aria-setsize")).toBe("200000");
    expect(rows[0]!.getAttribute("aria-posinset")).toBe("1");
    expect((list as HTMLElement).style.height).toBe(`${200_000 * 44}px`);
  });

  it("moves the window when scrolled", () => {
    const { container } = render(
      <VirtualList count={10_000} rowHeight={40} height={200} label="Rows" renderRow={(i) => `row ${i}`} />,
    );
    const viewport = container.querySelector(".vlist") as HTMLDivElement;
    viewport.scrollTop = 40 * 5000;
    fireEvent.scroll(viewport);
    expect(screen.getByText("row 5000")).toBeTruthy();
    expect(screen.queryByText("row 0")).toBeNull();
    expect(container.querySelectorAll("li").length).toBeLessThan(30);
  });

  it("scrolls the active row into view", () => {
    const { container, rerender } = render(
      <VirtualList
        count={1000}
        rowHeight={40}
        height={200}
        label="Rows"
        activeIndex={0}
        renderRow={(i) => i}
      />,
    );
    const viewport = container.querySelector(".vlist") as HTMLDivElement;
    rerender(
      <VirtualList
        count={1000}
        rowHeight={40}
        height={200}
        label="Rows"
        activeIndex={500}
        renderRow={(i) => i}
      />,
    );
    expect(viewport.scrollTop).toBe(500 * 40 + 40 - 200);
    rerender(
      <VirtualList
        count={1000}
        rowHeight={40}
        height={200}
        label="Rows"
        activeIndex={3}
        renderRow={(i) => i}
      />,
    );
    expect(viewport.scrollTop).toBe(3 * 40);
  });
});
