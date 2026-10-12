import { ErrorPanel, PageHeading } from "../components/common.tsx";
import { Link } from "../router.tsx";
import { useApp } from "../state/app.tsx";
import { useStartGame } from "../state/startGame.ts";

type ModeCard = { title: string; text: string; to?: string; action?: "classic"; needsAccount?: boolean; tag: string };

const MODES: ModeCard[] = [
  { title: "Classic infinite", text: "4x4, no winning tile. Undo is available, history capped at 100 moves.", action: "classic", tag: "Casual" },
  { title: "Custom practice", text: "3x3 to 8x8, your own seed and spawn odds. Never ranked.", to: "/practice", tag: "Casual" },
  { title: "Ranked challenge", text: "Fixed 4x4, 500 accepted moves, no undo. One official attempt per challenge.", to: "/challenges", needsAccount: true, tag: "Ranked" },
  { title: "Human 1v1 / vs bot", text: "Same seed for both seats, 500 moves per seat, decided by decisions not speed.", to: "/duel", needsAccount: true, tag: "Duel" },
  { title: "Bot laboratory", text: "Watch four algorithmic strategies play, with node and time budgets.", to: "/bots", needsAccount: true, tag: "Bots" },
  { title: "Saved games", text: "Resume anything in progress.", to: "/saves", tag: "Resume" },
  { title: "Leaderboards", text: "Casual best, challenge standings, duel Elo and bot league.", to: "/leaderboards", tag: "Rankings" },
  { title: "Replays", text: "Step through a finished game with merge explanations.", to: "/replays", tag: "Review" },
];

export function ModesScreen() {
  const { identity, isUser } = useApp();
  const { start, busy, error } = useStartGame();
  const startClassic = () => start("classic");

  return (
    <>
      <PageHeading title="Choose a mode" subtitle={isUser && identity ? `Signed in as ${identity.displayName}` : "Playing as a guest. Sign in to unlock ranked modes."} />
      {error ? <ErrorPanel error={error} onRetry={() => void startClassic()} /> : null}
      <ul className="card-grid" aria-label="Game modes">
        {MODES.map((mode) => {
          const locked = mode.needsAccount && !isUser;
          return (
            <li key={mode.title} className="panel mode-card">
              <span className="tag">{mode.tag}</span>
              <h2 className="panel-title">{mode.title}</h2>
              <p className="muted">{mode.text}</p>
              {locked ? (
                <p className="notice">
                  Needs a local account. <Link to="/login">Sign in</Link> or <Link to="/register">create one</Link>.
                </p>
              ) : mode.action === "classic" ? (
                <button type="button" className="btn btn-primary" onClick={() => void startClassic()} disabled={busy}>
                  {busy ? "Starting..." : "Start"}
                </button>
              ) : (
                <Link to={mode.to ?? "/"} className="btn btn-primary">
                  Open
                </Link>
              )}
            </li>
          );
        })}
      </ul>
    </>
  );
}
