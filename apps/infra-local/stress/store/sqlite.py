"""Truth rows in a local SQLite file — the no-`psql` fallback.

Same protocol, same semantics; only the location differs. A run using this
backend cannot sweep the control plane's leftover rows afterwards (that needs
SQL against Postgres), which the teardown reports rather than hides.

Every method opens and closes its own connection: the store is called from
worker threads via `asyncio.to_thread`, and a SQLite connection is not safe to
share across threads.
"""

from __future__ import annotations

import sqlite3
from pathlib import Path

from .truth import TruthRow


class SqliteTruthStore:
    def __init__(self, path: Path, run_id: str) -> None:
        self.path = path
        self.run_id = run_id

    def describe(self) -> str:
        return f"sqlite3 {self.path} \"select * from truth where run_id = '{self.run_id}'\""

    def _connect(self) -> sqlite3.Connection:
        connection = sqlite3.connect(self.path, timeout=30)
        connection.execute("PRAGMA journal_mode=WAL")
        return connection

    def setup(self) -> None:
        self.path.parent.mkdir(parents=True, exist_ok=True)
        with self._connect() as connection:
            connection.execute(
                "CREATE TABLE IF NOT EXISTS truth ("
                "  run_id  TEXT NOT NULL,"
                "  box_id  TEXT NOT NULL,"
                "  value   TEXT NOT NULL,"
                "  certain INTEGER NOT NULL DEFAULT 1,"
                "  PRIMARY KEY (run_id, box_id))"
            )

    def record(self, box_id: str, value: str, *, certain: bool = True) -> None:
        with self._connect() as connection:
            connection.execute(
                "INSERT INTO truth (run_id, box_id, value, certain) VALUES (?, ?, ?, ?) "
                "ON CONFLICT(run_id, box_id) DO UPDATE SET value = excluded.value, "
                "certain = excluded.certain",
                (self.run_id, box_id, value, 1 if certain else 0),
            )

    def fetch(self, box_id: str) -> TruthRow | None:
        with self._connect() as connection:
            row = connection.execute(
                "SELECT value, certain FROM truth WHERE run_id = ? AND box_id = ?",
                (self.run_id, box_id),
            ).fetchone()
        return TruthRow(row[0], bool(row[1])) if row else None

    def fetch_all(self) -> dict[str, TruthRow]:
        with self._connect() as connection:
            rows = connection.execute(
                "SELECT box_id, value, certain FROM truth WHERE run_id = ?", (self.run_id,)
            ).fetchall()
        return {box_id: TruthRow(value, bool(certain)) for box_id, value, certain in rows}

    def forget(self, box_id: str) -> None:
        with self._connect() as connection:
            connection.execute(
                "DELETE FROM truth WHERE run_id = ? AND box_id = ?", (self.run_id, box_id)
            )

    def drop_run(self) -> None:
        with self._connect() as connection:
            connection.execute("DELETE FROM truth WHERE run_id = ?", (self.run_id,))
