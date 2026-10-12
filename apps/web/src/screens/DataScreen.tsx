import { useState } from "react";
import { CONTRACT_VERSION } from "@g2048/contracts";
import { useServices } from "../app/services.js";
import { toPreferences } from "../settings/store.js";

/** Builds the guest export document. Contains no credentials (guests have none). */
export function buildGuestExport(
  preferences: ReturnType<typeof toPreferences>,
  game: unknown,
  exportedAt: string,
): string {
  return JSON.stringify(
    { format: "2048-infinite/guest-export", contract: CONTRACT_VERSION, exportedAt, preferences, game },
    null,
    2,
  );
}

export function DataScreen() {
  const { settings, saves } = useServices();
  const [status, setStatus] = useState<string | null>(null);

  const exportGuest = () => {
    const json = buildGuestExport(toPreferences(settings.get()), saves.load(), new Date().toISOString());
    const url = URL.createObjectURL(new Blob([json], { type: "application/json" }));
    const a = document.createElement("a");
    a.href = url;
    a.download = "2048-infinite-guest.json";
    document.body.append(a);
    a.click();
    a.remove();
    URL.revokeObjectURL(url);
    setStatus("Guest data exported as 2048-infinite-guest.json.");
  };

  return (
    <div className="stack">
      <section className="panel" aria-labelledby="guest-data-title">
        <h2 className="panel__title" id="guest-data-title">
          Guest data in this browser
        </h2>
        <p>
          Guest preferences and the current guest game are stored only in this browser&apos;s local storage.
          Export downloads them as a JSON file; nothing is uploaded anywhere.
        </p>
        <div className="action-row">
          <button type="button" className="button button--primary" onClick={exportGuest}>
            Export guest data
          </button>
        </div>
        <p className="hint" role="status">
          {status}
        </p>
      </section>
      <section className="panel panel--unavailable" aria-labelledby="account-data-title">
        <h2 className="panel__title" id="account-data-title">
          Account export, backup and restore
        </h2>
        <p className="badge badge--pending">Not available yet</p>
        <p>
          Exporting your profile and results, deleting your account, and inspecting where data lives require
          the local server, which this build does not connect to yet. Operators can already back up the
          database with <code>npm run db:backup</code> once the server is installed.
        </p>
      </section>
    </div>
  );
}
