"""Reading and cleaning the CONTROL PLANE's own rows.

Deliberately not the truth store: this reads the system under test rather than
the test's bookkeeping, it is always SQL (no API exposes it), and only teardown
and the report use it.

Two jobs:

* **the job ledger** — whether a migration was retried after its runner crashed
  is invisible from the outside except as a second job row for the same box;
* **the row sweep** — the API refuses to delete a box whose runner is gone, and
  refuses to delete a runner while any such box points at it, so a run that
  injected crashes always leaves rows behind. Those rows are this run's own,
  named `stress-<run_id>-…`, so the sweep removes them by that name.
"""

from __future__ import annotations

from dataclasses import dataclass

from ..clients.psql import Psql


@dataclass(frozen=True)
class JobCount:
    job_type: str
    status: str
    count: int


@dataclass(frozen=True)
class RowCounts:
    boxes: int
    runners: int

    def any(self) -> bool:
        return bool(self.boxes or self.runners)


class ControlPlaneLedger:
    def __init__(self, psql: Psql, run_id: str) -> None:
        self.psql = psql
        self.run_id = run_id

    def _patterns(self) -> dict[str, str]:
        """A destroyed box is renamed `DESTROYED_<name>_<epoch_ms>`, so matching
        only the original prefix would miss exactly the rows that block a runner
        row from being deleted."""
        return {
            "box": f"stress-{self.run_id}-b%",
            "dbox": f"DESTROYED_stress-{self.run_id}-b%",
            "runner": f"stress-{self.run_id}-%",
        }

    def job_tally(self) -> list[JobCount]:
        rows = self.psql.rows(
            "SELECT j.type, j.status, count(*) FROM job j "
            "WHERE j.\"resourceId\" IN "
            "  (SELECT id FROM box WHERE name LIKE :'box' OR name LIKE :'dbox') "
            "GROUP BY 1, 2 ORDER BY 1, 2;",
            **self._patterns(),
        )
        return [JobCount(job_type, status, int(count)) for job_type, status, count in rows]

    def count_rows(self) -> RowCounts:
        rows = self.psql.rows(
            "SELECT (SELECT count(*) FROM box WHERE name LIKE :'box' OR name LIKE :'dbox'),"
            "       (SELECT count(*) FROM runner WHERE name LIKE :'runner');",
            **self._patterns(),
        )
        if not rows:
            return RowCounts(0, 0)
        boxes, runners = rows[0]
        return RowCounts(int(boxes or 0), int(runners or 0))

    def purge_rows(self) -> None:
        """Delete this run's rows in foreign-key order.

        `job.runnerId` is varchar while `runner.id` is uuid, so the runner side
        needs an explicit cast — Postgres has no `varchar = uuid` operator and
        the whole sweep aborts without it.
        """
        self.psql.run(
            "CREATE TEMP TABLE doomed_box AS "
            "  SELECT id FROM box WHERE name LIKE :'box' OR name LIKE :'dbox';"
            "CREATE TEMP TABLE doomed_runner AS "
            "  SELECT id FROM runner WHERE name LIKE :'runner';"
            "DELETE FROM box_last_activity WHERE \"boxId\" IN (SELECT id FROM doomed_box);"
            "DELETE FROM box_migration     WHERE \"boxId\" IN (SELECT id FROM doomed_box);"
            "DELETE FROM job WHERE \"resourceId\" IN (SELECT id FROM doomed_box)"
            "   OR \"runnerId\" IN (SELECT id::text FROM doomed_runner);"
            "DELETE FROM box    WHERE id IN (SELECT id FROM doomed_box);"
            "DELETE FROM runner WHERE id IN (SELECT id FROM doomed_runner);",
            **self._patterns(),
        )

    def set_draining(self, runner_id: str) -> None:
        """The draining endpoint is behind a feature flag on some stacks; this
        writes the column the scheduler and the decommission cron actually read,
        so the operation still exercises control-plane behaviour."""
        self.psql.run(
            "UPDATE runner SET draining = true, \"updatedAt\" = now() WHERE id = :'id'::uuid;",
            id=runner_id,
        )
