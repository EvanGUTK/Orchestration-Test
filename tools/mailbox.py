#!/usr/bin/env python3
"""Local SQLite mailbox shared by six panes. No model provider or network dependency."""
import argparse
from datetime import datetime, timezone
import json
import os
from pathlib import Path
import sqlite3
import sys
import time
import uuid

ROLES = ("chief", "engine", "backend", "frontend", "competition", "quality")
KINDS = ("task", "ack", "status", "question", "answer", "blocked", "result", "stop")


def connection():
    runtime = os.environ.get("LAB_RUNTIME")
    if not runtime or not os.environ.get("LAB_RUN_ID") or not os.environ.get("LAB_EXPERIMENT"):
        raise ValueError("Source .lab/env.sh (or env.ps1) first; run identity and LAB_RUNTIME are required")
    path = Path(runtime).expanduser().resolve()
    path.mkdir(parents=True, exist_ok=True, mode=0o700)
    db = sqlite3.connect(path / "mailbox.sqlite3", timeout=15)
    db.execute("PRAGMA journal_mode=WAL")
    db.executescript("""
      CREATE TABLE IF NOT EXISTS messages (
        id TEXT PRIMARY KEY, experiment TEXT NOT NULL, run TEXT NOT NULL,
        sender TEXT NOT NULL, recipient TEXT NOT NULL, kind TEXT NOT NULL,
        task TEXT NOT NULL, body TEXT NOT NULL, reply_to TEXT,
        created_at TEXT NOT NULL, acknowledged_at TEXT);
      CREATE INDEX IF NOT EXISTS inbox ON messages(experiment,run,recipient,acknowledged_at,created_at);
    """)
    db.row_factory = sqlite3.Row
    return db


def emit(rows):
    for row in rows:
        print(json.dumps(dict(row), ensure_ascii=False), flush=True)


def inbox(db, role, all_messages=False):
    suffix = "" if all_messages else " AND acknowledged_at IS NULL"
    return db.execute("SELECT * FROM messages WHERE experiment=? AND run=? AND recipient=?" +
                      suffix + " ORDER BY created_at,id",
                      (os.environ["LAB_EXPERIMENT"], os.environ["LAB_RUN_ID"], role)).fetchall()


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    sub = parser.add_subparsers(dest="command", required=True)
    sub.add_parser("init")
    send = sub.add_parser("send")
    send.add_argument("--from", dest="sender", choices=ROLES, required=True)
    send.add_argument("--to", choices=ROLES, required=True)
    send.add_argument("--kind", choices=KINDS, default="status")
    send.add_argument("--task", required=True)
    body = send.add_mutually_exclusive_group(required=True)
    body.add_argument("--body")
    body.add_argument("--body-file", type=Path)
    send.add_argument("--reply-to")
    read = sub.add_parser("inbox")
    read.add_argument("role", choices=ROLES)
    read.add_argument("--all", action="store_true")
    ack = sub.add_parser("ack")
    ack.add_argument("role", choices=ROLES)
    ack.add_argument("id")
    wait = sub.add_parser("wait")
    wait.add_argument("role", choices=ROLES)
    wait.add_argument("--timeout", type=float, default=30)
    args = parser.parse_args()
    try:
        if args.command == "wait" and not 0 < args.timeout <= 60:
            raise ValueError("Wait timeout must be greater than zero and at most 60 seconds")
        with connection() as db:
            if args.command == "init":
                print("Local mailbox ready; messages are run-scoped and stay outside Git")
            elif args.command == "send":
                text = args.body if args.body is not None else args.body_file.read_text()
                if not text.strip() or len(text.encode()) > 65536:
                    raise ValueError("Message must contain 1-65536 bytes; link artifacts instead of dumping logs")
                identity = str(uuid.uuid4())
                now = datetime.now(timezone.utc).isoformat()
                db.execute("INSERT INTO messages VALUES (?,?,?,?,?,?,?,?,?,?,NULL)",
                           (identity, os.environ["LAB_EXPERIMENT"], os.environ["LAB_RUN_ID"],
                            args.sender, args.to, args.kind, args.task, text, args.reply_to, now))
                print(identity)
            elif args.command == "inbox":
                emit(inbox(db, args.role, args.all))
            elif args.command == "ack":
                changed = db.execute("UPDATE messages SET acknowledged_at=? WHERE id=? AND recipient=? "
                                     "AND experiment=? AND run=?",
                                     (datetime.now(timezone.utc).isoformat(), args.id, args.role,
                                      os.environ["LAB_EXPERIMENT"], os.environ["LAB_RUN_ID"])).rowcount
                if not changed:
                    raise ValueError("Message not found for this recipient/run")
                print("Acknowledged receipt; this does not mark the task completed")
            elif args.command == "wait":
                deadline = time.monotonic() + args.timeout
                while True:
                    rows = inbox(db, args.role)
                    if rows:
                        emit(rows)
                        return 0
                    if time.monotonic() >= deadline:
                        return 2
                    time.sleep(min(0.5, max(0, deadline - time.monotonic())))
    except (ValueError, OSError, sqlite3.Error) as exc:
        print(f"STOP: {exc}", file=sys.stderr)
        return 1
    return 0


if __name__ == "__main__":
    sys.exit(main())
