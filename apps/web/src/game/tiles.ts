import type { Board, DomainEvent, Exponent } from "@2048/contracts";

/**
 * Presentation-only tile model. Identity (`id`) lets CSS transitions follow a tile
 * across cells. The authoritative board always wins: whenever the event-derived
 * layout disagrees with it, the model is rebuilt from the board without animation.
 */
export type TileView = {
  id: number;
  index: number;
  exponent: Exponent;
  fresh: boolean; // spawned by the last move
  merged: boolean; // produced by a merge in the last move
  leaving: boolean; // slid into a merge and is about to disappear
};

export type IdSource = { next(): number };

export function createIdSource(start = 1): IdSource {
  let n = start;
  return { next: () => n++ };
}

export function tilesFromBoard(board: Board, ids: IdSource): TileView[] {
  const out: TileView[] = [];
  board.cells.forEach((cell, index) => {
    if (cell !== null) out.push({ id: ids.next(), index, exponent: cell, fresh: false, merged: false, leaving: false });
  });
  return out;
}

export function layoutMatchesBoard(tiles: readonly TileView[], board: Board): boolean {
  const seen = new Array<Exponent | null>(board.cells.length).fill(null);
  for (const tile of tiles) {
    if (tile.leaving) continue;
    if (tile.index < 0 || tile.index >= seen.length || seen[tile.index] !== null) return false;
    seen[tile.index] = tile.exponent;
  }
  return board.cells.every((cell, i) => cell === seen[i]);
}

/** Apply the ordered DomainEvents of one accepted move on top of the previous tile model. */
export function advanceTiles(
  previous: readonly TileView[],
  events: readonly DomainEvent[],
  board: Board,
  ids: IdSource,
): TileView[] {
  const moves = new Map<number, number>();
  const merges = new Map<number, Extract<DomainEvent, { type: "merge" }>>();
  const spawns: Extract<DomainEvent, { type: "spawn" }>[] = [];
  for (const event of events) {
    if (event.type === "move") moves.set(event.from, event.to);
    else if (event.type === "merge") merges.set(event.to, event);
    else if (event.type === "spawn") spawns.push(event);
  }

  const next: TileView[] = [];
  const mergeSurvivor = new Map<number, TileView>();
  for (const tile of previous) {
    if (tile.leaving) continue;
    const destination = moves.get(tile.index) ?? tile.index;
    const merge = merges.get(destination);
    if (merge) {
      const survivor = mergeSurvivor.get(destination);
      if (!survivor) {
        const created: TileView = { ...tile, index: destination, exponent: merge.exponent, fresh: false, merged: true, leaving: false };
        mergeSurvivor.set(destination, created);
        next.push(created);
      } else {
        next.push({ ...tile, index: destination, fresh: false, merged: false, leaving: true });
      }
    } else {
      next.push({ ...tile, index: destination, fresh: false, merged: false, leaving: false });
    }
  }
  for (const spawn of spawns) {
    next.push({ id: ids.next(), index: spawn.index, exponent: spawn.exponent, fresh: true, merged: false, leaving: false });
  }
  return layoutMatchesBoard(next, board) ? next : tilesFromBoard(board, ids);
}
