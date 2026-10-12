// Test fixture (DB-02): applies one move in a child process and dies abruptly at a chosen point.
//   argv: <dbPath> <gameId> <ownerUserId> <commandId> <expectedRevision> <direction> <stage>
//   stage = "mid-transaction": exit right after the game_moves insert, before COMMIT
//   stage = "after-commit":    exit right after the transaction committed, without closing the DB
import { DatabaseWriter, gamesRepo, openDatabase } from "@g2048/database";
import type { Direction } from "@g2048/contracts";
import { GameService } from "../services/game-service.js";

const [dbPath, gameId, ownerUserId, commandId, expectedRevision, direction, stage] = process.argv.slice(2);
if (!dbPath || !gameId || !ownerUserId || !commandId || !expectedRevision || !direction || !stage) {
  throw new Error(
    "usage: kill-mid-move <dbPath> <gameId> <ownerUserId> <commandId> <rev> <direction> <stage>",
  );
}

const db = openDatabase(dbPath);
const games = new GameService({ db, writer: new DatabaseWriter(db), clock: () => new Date() });

if (stage === "mid-transaction") {
  const original = gamesRepo.insertMove;
  gamesRepo.insertMove = (...args: Parameters<typeof original>) => {
    original(...args);
    process.exit(137); // simulated kill: the open transaction is never committed
  };
}

await games.move({ userId: ownerUserId }, gameId, {
  commandId,
  expectedRevision: Number(expectedRevision),
  direction: direction as Direction,
});
process.exit(stage === "after-commit" ? 137 : 0); // no db.close(): the process just dies
