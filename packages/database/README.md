# packages/database

Backend owns SQLite migrations, repositories, backup and restore. Exact values remain decimal TEXT.

- `src/migrations/`: append-only list; `schema_migrations` stores a sha256 of each applied migration and
  boot refuses a modified or newer-than-known history. Destructive migrations (flagged) must be preceded by a backup.
- `GameDb`: the single writer handle (WAL, foreign keys, busy timeout, `BEGIN IMMEDIATE` transactions);
  `WriteQueue` is the bounded FIFO in front of it (`DB_BUSY` when full).
- CLI (`npm run db:migrate | db:backup | db:restore -- <file>`, uses `$DATABASE_PATH`):
  - `backup [dest]` uses the SQLite backup API (WAL-safe, never a raw copy), verifies the result and writes a
    single self-contained file, by default to `<db dir>/backups/`.
  - `restore <file>` validates the input (header, integrity_check, foreign keys, required tables, known
    migration checksums), copies it through the backup API to a temp file, snapshots the current database to
    `backups/pre-restore-*.sqlite3`, deletes stale `-wal/-shm`, and atomically renames. Corrupt or foreign
    input is refused before anything changes. **Stop the server first**; restore refuses while another process
    has the database open.

Shared requirements: [architecture](../../docs/ARCHITECTURE.md).
