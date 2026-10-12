import { useCallback, useState } from "react";
import type { CustomOptions } from "@2048/contracts";
import { isApiError } from "../api/client.ts";
import { useNavigate } from "../router.tsx";
import { useApp } from "./app.tsx";

/**
 * Start a casual game on the server when we have a session (user or server guest);
 * fall back to the in-browser engine when the server is unreachable or there is no session.
 */
export function useStartGame() {
  const { identity, api } = useApp();
  const navigate = useNavigate();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<unknown>(null);

  const start = useCallback(
    async (mode: "classic" | "practice", custom?: CustomOptions) => {
      setError(null);
      const localQuery = () => {
        const q = new URLSearchParams({ new: "1", t: String(Date.now()) });
        if (mode === "practice" && custom) {
          if (custom.boardSize !== undefined) q.set("size", String(custom.boardSize));
          if (custom.spawnFourTenths !== undefined) q.set("fours", String(custom.spawnFourTenths));
          if (custom.seed) q.set("seed", custom.seed);
        }
        return q.toString();
      };
      if (!identity) {
        navigate(`/play?${localQuery()}`);
        return;
      }
      setBusy(true);
      try {
        const game = await api.createGame({ mode, ...(custom ? { custom } : {}) });
        navigate(`/play/${game.id}`);
      } catch (e) {
        if (isApiError(e) && e.isNetwork) navigate(`/play?${localQuery()}`); // offline fallback
        else setError(e);
      } finally {
        setBusy(false);
      }
    },
    [identity, api, navigate],
  );

  return { start, busy, error, clearError: () => setError(null) };
}
