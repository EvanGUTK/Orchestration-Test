import { describe, expect, it, vi } from "vitest";
import type { Direction } from "@g2048/contracts";
import { MoveQueue } from "./move-queue.js";

const tick = () => new Promise((r) => setTimeout(r, 0));

describe("MoveQueue (UI-04)", () => {
  it("applies rapid input strictly in order, exactly once, one at a time", async () => {
    const applied: Direction[] = [];
    let inFlight = 0;
    let maxInFlight = 0;
    const queue = new MoveQueue<Direction>(async (d) => {
      inFlight++;
      maxInFlight = Math.max(maxInFlight, inFlight);
      // Variable latency, as with animation frames or a server round trip.
      await new Promise((r) => setTimeout(r, applied.length % 3));
      applied.push(d);
      inFlight--;
    });
    const input: Direction[] = ["up", "up", "left", "down", "right", "left", "left", "up", "down", "right"];
    for (const d of input) expect(queue.enqueue(d)).toBe(true);
    await queue.idle();
    expect(applied).toEqual(input);
    expect(maxInFlight).toBe(1);
  });

  it("keeps order when input arrives while a move is in flight", async () => {
    const applied: Direction[] = [];
    let release: () => void = () => undefined;
    const queue = new MoveQueue<Direction>(async (d) => {
      if (d === "up") await new Promise<void>((r) => (release = r));
      applied.push(d);
    });
    queue.enqueue("up");
    queue.enqueue("left");
    await tick();
    queue.enqueue("right");
    expect(applied).toEqual([]);
    expect(queue.pending).toBe(2);
    release();
    await queue.idle();
    expect(applied).toEqual(["up", "left", "right"]);
  });

  it("pauses between moves and resumes without losing queued input", async () => {
    const applied: Direction[] = [];
    const queue = new MoveQueue<Direction>(async (d) => {
      applied.push(d);
      if (d === "down") queue.pause();
    });
    queue.enqueue("down");
    queue.enqueue("left");
    queue.enqueue("up");
    await queue.idle();
    expect(applied).toEqual(["down"]);
    expect(queue.pending).toBe(2);
    queue.resume();
    await queue.idle();
    expect(applied).toEqual(["down", "left", "up"]);
  });

  it("refuses input beyond capacity visibly instead of silently dropping it", async () => {
    const onOverflow = vi.fn();
    let release: () => void = () => undefined;
    const queue = new MoveQueue<Direction>(() => new Promise<void>((r) => (release = r)), {
      capacity: 2,
      onOverflow,
    });
    expect(queue.enqueue("up")).toBe(true); // in flight
    expect(queue.enqueue("left")).toBe(true);
    expect(queue.enqueue("down")).toBe(true);
    expect(queue.enqueue("right")).toBe(false);
    expect(onOverflow).toHaveBeenCalledWith("right");
    release();
  });

  it("clears remaining moves after a failure and reports how many", async () => {
    const onError = vi.fn();
    const applied: Direction[] = [];
    const queue = new MoveQueue<Direction>(
      async (d) => {
        if (d === "left") throw new Error("conflict");
        applied.push(d);
      },
      { onError },
    );
    queue.enqueue("up");
    queue.enqueue("left");
    queue.enqueue("down");
    queue.enqueue("right");
    await queue.idle();
    expect(applied).toEqual(["up"]);
    expect(onError).toHaveBeenCalledWith(expect.any(Error), 2);
    queue.enqueue("down");
    await queue.idle();
    expect(applied).toEqual(["up", "down"]);
  });
});
