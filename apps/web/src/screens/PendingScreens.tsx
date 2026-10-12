import { Unavailable } from "../components/Unavailable.js";

const SERVER_REASON =
  "This needs the local 2048 Infinite server (accounts, saved results and verification), which this build does not connect to yet. Nothing here is simulated.";

const PLAY_INSTEAD = [
  { to: "play" as const, label: "Play a guest game" },
  { to: "practice" as const, label: "Custom practice" },
];

export function ChallengesScreen() {
  return (
    <Unavailable
      purpose="Ranked challenges: a fixed 4×4 seed shared by every attempt, 500 accepted moves, no undo, one official attempt per account."
      reason={SERVER_REASON}
      alternatives={PLAY_INSTEAD}
    />
  );
}

export function LeaderboardsScreen() {
  return (
    <Unavailable
      purpose="Separate boards for casual best scores, challenge standings, human duel Elo, and bot results — never blended."
      reason={`${SERVER_REASON} No rankings are shown until real results exist.`}
      alternatives={PLAY_INSTEAD}
    />
  );
}

export function ProfileScreen() {
  return (
    <Unavailable
      purpose="Personal bests, score distribution, highest tiles, win/draw/loss and ranked history for your local account."
      reason={`${SERVER_REASON} Statistics are never estimated.`}
      alternatives={[{ to: "settings", label: "Guest settings" }, ...PLAY_INSTEAD]}
    />
  );
}

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

export function BotLabScreen() {
  return (
    <Unavailable
      purpose="Bot laboratory: run random, greedy, heuristic and expectimax bots with budgets, pause/step controls and move explanations."
      reason="The deterministic bot workers are still being built. Bot speed can already be set in Settings."
      alternatives={[{ to: "settings", label: "Bot speed setting" }, ...PLAY_INSTEAD]}
    />
  );
}

export function ReplaysScreen() {
  return (
    <Unavailable
      purpose="Replay browser and player: step, seek, pause and change speed through any finished game, with merge explanations. Import and export verified replay files."
      reason={SERVER_REASON}
      alternatives={PLAY_INSTEAD}
    />
  );
}
