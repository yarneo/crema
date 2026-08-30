"""SQLite store for shots and the advice generated for them."""

import json
import sqlite3
import threading
from datetime import datetime, timezone
from pathlib import Path

DB_PATH = Path(__file__).resolve().parent.parent / "data" / "advisor.db"

_lock = threading.Lock()


def _connect() -> sqlite3.Connection:
    DB_PATH.parent.mkdir(parents=True, exist_ok=True)
    conn = sqlite3.connect(DB_PATH)
    conn.row_factory = sqlite3.Row
    return conn


def init_db() -> None:
    with _lock, _connect() as conn:
        conn.execute(
            """
            CREATE TABLE IF NOT EXISTS shots (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                created_at TEXT NOT NULL,
                payload TEXT NOT NULL,
                advice TEXT,
                status TEXT NOT NULL DEFAULT 'pending',
                error TEXT
            )
            """
        )


def insert_shot(payload: dict) -> int:
    with _lock, _connect() as conn:
        cur = conn.execute(
            "INSERT INTO shots (created_at, payload) VALUES (?, ?)",
            (datetime.now(timezone.utc).isoformat(), json.dumps(payload)),
        )
        return cur.lastrowid


def set_advice(shot_id: int, advice: dict) -> None:
    with _lock, _connect() as conn:
        conn.execute(
            "UPDATE shots SET advice = ?, status = 'done', error = NULL WHERE id = ?",
            (json.dumps(advice), shot_id),
        )


def set_error(shot_id: int, error: str) -> None:
    with _lock, _connect() as conn:
        conn.execute(
            "UPDATE shots SET status = 'error', error = ? WHERE id = ?",
            (error[:2000], shot_id),
        )


def get_shot(shot_id: int) -> dict | None:
    with _lock, _connect() as conn:
        row = conn.execute("SELECT * FROM shots WHERE id = ?", (shot_id,)).fetchone()
    return _row_to_dict(row) if row else None


def recent_shots(limit: int = 20, bean: str | None = None) -> list[dict]:
    """Most recent shots, newest first, optionally filtered by bean name."""
    with _lock, _connect() as conn:
        rows = conn.execute(
            "SELECT * FROM shots ORDER BY id DESC LIMIT ?", (max(limit * 5, limit),)
        ).fetchall()
    shots = [_row_to_dict(r) for r in rows]
    if bean:
        shots = [s for s in shots if s["payload"].get("bean", {}).get("name") == bean]
    return shots[:limit]


def _row_to_dict(row: sqlite3.Row) -> dict:
    return {
        "id": row["id"],
        "created_at": row["created_at"],
        "payload": json.loads(row["payload"]),
        "advice": json.loads(row["advice"]) if row["advice"] else None,
        "status": row["status"],
        "error": row["error"],
    }
