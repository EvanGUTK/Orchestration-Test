import { Unavailable } from "../components/Unavailable.js";

const SERVER_REASON =
  "This needs the local 2048 Infinite server (accounts, saved results and verification), which this build does not connect to yet. Nothing here is simulated.";

const PLAY_INSTEAD = [
  { to: "play" as const, label: "Play a guest game" },
  { to: "practice" as const, label: "Custom practice" },
];

export function LobbyScreen() {
  return (
    <Unavailable
      purpose="Duel lobby: create or join a same-seed 1v1 against another local account or a bot. 500 accepted moves per seat; no speed race."
      reason={SERVER_REASON}
      alternatives={PLAY_INSTEAD}
    />
  );
}

export function DuelScreen() {
  return (
    <Unavailable
      purpose="Split-board duel: both seats side by side with live scores. A missing player never loses by timeout; only an explicit forfeit ends a seat early."
      reason={SERVER_REASON}
      alternatives={[{ to: "lobby", label: "Duel lobby" }, ...PLAY_INSTEAD]}
    />
  );
}
