import { SCHEMA_VERSION } from "@g2048/contracts";

export function App() {
  return (
    <main>
      <h1>2048 Infinite</h1>
      <p>Local build shell — schema v{SCHEMA_VERSION}.</p>
    </main>
  );
}
