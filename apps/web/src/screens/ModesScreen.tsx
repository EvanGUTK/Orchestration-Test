import { routeHref } from "../app/routes.js";
import type { RouteId } from "../app/routes.js";
import { useServices } from "../app/services.js";

type ModeCard = {
  title: string;
  board: string;
  summary: string;
  to: RouteId;
  needs: "engine" | "server";
};

const MODES: ModeCard[] = [
  {
    title: "Classic infinite",
    board: "4×4",
    summary: "Endless play past 2048. Undo up to 100 moves.",
    to: "play",
    needs: "engine",
  },
  {
    title: "Custom practice",
    board: "3×3 – 8×8",
    summary: "Pick size, seed and spawn odds. Always casual.",
    to: "practice",
    needs: "engine",
  },
  {
    title: "Ranked challenge",
    board: "4×4 · 500 moves",
    summary: "Shared seed, no undo, one official attempt.",
    to: "challenges",
    needs: "server",
  },
  {
    title: "Bot exhibition",
    board: "4×4",
    summary: "Watch four bot strategies play, step by step.",
    to: "bots",
    needs: "server",
  },
  {
    title: "Human 1v1",
    board: "4×4 · same seed",
    summary: "Two local accounts, 500 moves each, Elo rated.",
    to: "lobby",
    needs: "server",
  },
  {
    title: "Human vs bot",
    board: "4×4 · same seed",
    summary: "Race a bot on the same seed. Casual result board.",
    to: "lobby",
    needs: "server",
  },
  {
    title: "Bot vs bot",
    board: "4×4 · same seed",
    summary: "Pit two algorithms against each other.",
    to: "bots",
    needs: "server",
  },
];

export function ModesScreen() {
  const { game } = useServices();
  return (
    <ul className="mode-grid">
      {MODES.map((m) => {
        const ready = m.needs === "engine" && game !== null;
        return (
          <li key={m.title} className="mode-card" data-ready={ready}>
            <p className="mode-card__board">{m.board}</p>
            <h2 className="mode-card__title">
              <a href={routeHref(m.to)}>{m.title}</a>
            </h2>
            <p>{m.summary}</p>
            <p className={`badge ${ready ? "badge--ready" : "badge--pending"}`}>
              {ready ? "Ready offline" : "Not available yet"}
            </p>
          </li>
        );
      })}
    </ul>
  );
}
