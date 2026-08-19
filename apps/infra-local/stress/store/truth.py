"""The ground truth a run compares against.

One row per box: the value the box handed back on the last write, plus whether
that value is *certain*. The distinction is the whole point of the store — a
write whose read-back failed leaves the box's content genuinely unknown, and a
checker that treated "unknown" as "wrong" would report data loss the system
never had.

Backends live beside this module and are chosen by `open_truth_store`; the run
never names one directly.
"""

from __future__ import annotations

from dataclasses import dataclass
from pathlib import Path
from typing import Protocol

SCHEMA = "stress"
TABLE = f"{SCHEMA}.truth"


@dataclass(frozen=True)
class TruthRow:
    value: str
    certain: bool


class TruthStore(Protocol):
    """`box id -> value` for one run."""

    def describe(self) -> str:
        """One line a human can use to query the same rows by hand."""

    def setup(self) -> None: ...

    def record(self, box_id: str, value: str, *, certain: bool = True) -> None: ...

    def fetch(self, box_id: str) -> TruthRow | None: ...

    def fetch_all(self) -> dict[str, TruthRow]: ...

    def forget(self, box_id: str) -> None:
        """Discard one box's truth, for a box the run destroyed on purpose.

        Keeps the store's one invariant intact: every row here names a box the
        run still expects to be readable. Without this, deliberately destroying a
        box would leave its row behind and the final sweep would report the
        harness's own cleanup as missing data.
        """

    def drop_run(self) -> None: ...


def open_truth_store(run_id: str, target, fallback_dir: Path) -> TruthStore:
    """Postgres when `psql` is available, SQLite otherwise.

    Postgres is preferred because keeping the truth in the control plane's own
    database is what lets a human debug a mismatch afterwards with one query
    against both sides. SQLite exists so a machine without `psql` can still run
    the harness at all — the run degrades to "cannot sweep leftover rows", not
    "cannot run".
    """
    from ..clients.psql import Psql
    from .postgres import PostgresTruthStore
    from .sqlite import SqliteTruthStore

    if Psql.available():
        return PostgresTruthStore(Psql(target), run_id)
    return SqliteTruthStore(fallback_dir / f"stress-truth-{run_id}.sqlite3", run_id)
