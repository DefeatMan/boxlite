"""`psql` plumbing — no driver, so the harness runs on a stock interpreter.

Layer 0: this module runs SQL and returns text. Which SQL, and what the text
means, belongs to `stress/store/`.

Unlike the version in `stress.py`, the connection is its own value rather than a
slice of the run's `Settings`: the truth store and the control-plane ledger are
free to point at different databases, and a test can build a `PgTarget` without
constructing a whole run.
"""

from __future__ import annotations

import os
import shutil
import subprocess
from dataclasses import dataclass

from ..errors import StressError

QUERY_TIMEOUT_SECONDS = 30


@dataclass(frozen=True)
class PgTarget:
    host: str
    port: int
    user: str
    password: str
    database: str

    def dsn(self) -> str:
        """Printable connection string — no password, it ends up in reports."""
        return f"postgresql://{self.user}@{self.host}:{self.port}/{self.database}"


class Psql:
    """Runs SQL through the `psql` binary.

    SQL is fed on **stdin**, not `-c`: psql expands `:'name'` variables (with
    correct literal quoting) only for input it reads itself, so `-c` would send
    the placeholders to the server verbatim.
    """

    def __init__(self, target: PgTarget) -> None:
        self.target = target

    @staticmethod
    def available() -> bool:
        """Whether this machine can use a psql-backed store at all — the check a
        preflight makes before choosing a truth-store backend."""
        return shutil.which("psql") is not None

    def run(self, sql: str, **params: str) -> str:
        argv = [
            "psql",
            "-h", self.target.host,
            "-p", str(self.target.port),
            "-U", self.target.user,
            "-d", self.target.database,
            "-tAF", "|",
            "-v", "ON_ERROR_STOP=1",
        ]
        for key, value in params.items():
            argv += ["-v", f"{key}={value}"]
        result = subprocess.run(
            argv,
            input=sql,
            env={**os.environ, "PGPASSWORD": self.target.password},
            capture_output=True,
            text=True,
            timeout=QUERY_TIMEOUT_SECONDS,
            check=False,
        )
        if result.returncode != 0:
            raise StressError(f"psql failed: {result.stderr.strip() or result.stdout.strip()}")
        return result.stdout.strip()

    def rows(self, sql: str, **params: str) -> list[list[str]]:
        """`run` split into fields — every caller was doing this by hand.

        `-tAF |` gives one record per line with `|` between fields, so a row is
        just a split; empty output means no rows, not one empty row.
        """
        out = self.run(sql, **params)
        return [line.split("|") for line in out.splitlines() if line]
