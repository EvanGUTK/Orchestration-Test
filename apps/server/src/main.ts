import { fileURLToPath } from "node:url";
import { migrate, openDatabase } from "@g2048/database";
import { buildApp } from "./app.js";
import { loadConfig } from "./config.js";

const config = loadConfig();
const db = openDatabase(config.databasePath);
migrate(db); // pending migrations apply before any request is accepted
const webDist = config.webDist ?? fileURLToPath(new URL("../../web/dist", import.meta.url));
const app = await buildApp({ db, webDist, logger: true });
await app.listen({ host: config.host, port: config.port });

for (const signal of ["SIGINT", "SIGTERM"] as const) {
  process.once(signal, () => {
    void app.close().then(() => {
      db.close();
      process.exit(0);
    });
  });
}
