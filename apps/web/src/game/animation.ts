import type { DomainEvent } from "@g2048/contracts";

export type TileAnimation = {
  readonly kind: "move" | "merge" | "spawn";
  /** Offset of the source cell relative to the destination, in cells (for the slide-in). */
  readonly dx: number;
  readonly dy: number;
};

/**
 * Maps the DomainEvents of ONE accepted move to per-destination cosmetic animations.
 * Animations are derived from events and never feed back into game state: the board always renders
 * the authoritative GameState, and these hints only add a transient CSS transform/scale.
 */
export function deriveTileAnimations(
  events: readonly DomainEvent[],
  size: number,
): ReadonlyMap<number, TileAnimation> {
  const out = new Map<number, TileAnimation>();
  const offset = (from: number, to: number) => ({
    dx: (from % size) - (to % size),
    dy: Math.floor(from / size) - Math.floor(to / size),
  });
  for (const event of events) {
    switch (event.type) {
      case "tile.moved": {
        const existing = out.get(event.to);
        // For a merge both sources may move; keep the one that travels farthest so the slide reads well.
        const next = offset(event.from, event.to);
        if (
          !existing ||
          Math.abs(next.dx) + Math.abs(next.dy) > Math.abs(existing.dx) + Math.abs(existing.dy)
        ) {
          out.set(event.to, { kind: existing?.kind ?? "move", ...next });
        }
        break;
      }
      case "tile.merged": {
        const existing = out.get(event.to);
        out.set(event.to, { kind: "merge", dx: existing?.dx ?? 0, dy: existing?.dy ?? 0 });
        break;
      }
      case "tile.spawned":
        out.set(event.at, { kind: "spawn", dx: 0, dy: 0 });
        break;
      default:
        break;
    }
  }
  return out;
}
