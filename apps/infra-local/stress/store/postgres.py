"""Truth rows in the control plane's own Postgres.

The default backend: keeping the test's ground truth next to the system's own
tables is what lets a human answer "was the box wrong, or was the checker?" with
a single query after the run is over.
"""

from __future__ import annotations

from ..clients.psql import Psql
from .truth import SCHEMA, TABLE, TruthRow


class PostgresTruthStore:
    def __init__(self, psql: Psql, run_id: str) -> None:
        self.psql = psql
        self.run_id = run_id

    def describe(self) -> str:
        target = self.psql.target
        return (
            f"psql -h {target.host} -p {target.port} -U {target.user} -d {target.database} "
            f"-c \"select * from {TABLE} where run_id = '{self.run_id}'\""
        )

    def setup(self) -> None:
        self.psql.run(
            f"CREATE SCHEMA IF NOT EXISTS {SCHEMA};"
            f"CREATE TABLE IF NOT EXISTS {TABLE} ("
            "  run_id     text        NOT NULL,"
            "  box_id     text        NOT NULL,"
            "  value      text        NOT NULL,"
            "  certain    boolean     NOT NULL DEFAULT true,"
            "  updated_at timestamptz NOT NULL DEFAULT now(),"
            "  PRIMARY KEY (run_id, box_id));"
        )

    def record(self, box_id: str, value: str, *, certain: bool = True) -> None:
        self.psql.run(
            f"INSERT INTO {TABLE} (run_id, box_id, value, certain) "
            "VALUES (:'run', :'box', :'val', :'certain'::boolean) "
            "ON CONFLICT (run_id, box_id) DO UPDATE SET "
            "value = EXCLUDED.value, certain = EXCLUDED.certain, updated_at = now();",
            run=self.run_id, box=box_id, val=value, certain="true" if certain else "false",
        )

    def fetch(self, box_id: str) -> TruthRow | None:
        rows = self.psql.rows(
            f"SELECT value, certain FROM {TABLE} WHERE run_id = :'run' AND box_id = :'box';",
            run=self.run_id, box=box_id,
        )
        if not rows:
            return None
        value, certain = rows[0]
        return TruthRow(value, certain == "t")

    def fetch_all(self) -> dict[str, TruthRow]:
        rows = self.psql.rows(
            f"SELECT box_id, value, certain FROM {TABLE} WHERE run_id = :'run';",
            run=self.run_id,
        )
        return {box_id: TruthRow(value, certain == "t") for box_id, value, certain in rows}

    def forget(self, box_id: str) -> None:
        self.psql.run(
            f"DELETE FROM {TABLE} WHERE run_id = :'run' AND box_id = :'box';",
            run=self.run_id, box=box_id,
        )

    def drop_run(self) -> None:
        self.psql.run(f"DELETE FROM {TABLE} WHERE run_id = :'run';", run=self.run_id)
