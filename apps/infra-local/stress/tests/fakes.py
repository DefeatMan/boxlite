"""Stand-ins for the parts of the world a correctness test must not depend on.

The point of the suite is the harness's own logic — what it records, what it
compares, what it concludes — so the box, the truth store and the fleet are
replaced by objects whose behaviour the test dictates. Everything under test is
still this package's real code.
"""

from __future__ import annotations

import asyncio
import random
from dataclasses import dataclass, field
from pathlib import Path

from ..clients.http import Response
from ..errors import StressError
from ..clients.psql import PgTarget
from ..config import (
    BoxSpec,
    ControlPlane,
    FaultSpec,
    FleetSpec,
    LoadSpec,
    RegistryAuth,
    Settings,
    TeardownSpec,
)
from ..run.context import RunContext, Stats
from ..store.truth import TruthRow

OK = Response(200, b"")
GATEWAY_TIMEOUT = Response(504, b"proxy timeout")


def settings(run_id: str = "test0001") -> Settings:
    """A Settings whose values are never used to reach anything real."""
    return Settings(
        run_id=run_id,
        control_plane=ControlPlane(api_url="http://127.0.0.1:1/api", admin_key="k", region="us"),
        fleet=FleetSpec(
            runner_bin=Path("/nonexistent/boxlite-runner"),
            logs_dir=Path("/tmp"),
            repo_root=Path("/tmp"),
            initial=1, maximum=1, port_base=3020, ready_timeout=1,
            registry=RegistryAuth(), archive_store=None,
        ),
        box=BoxSpec(image="base", cpus=1, memory_mib=512, disk_gb=2,
                    file_path="/root/output/stress-value", timeout=1),
        load=LoadSpec(duration=1, workers=1, think_time=0, weights={}),
        faults=FaultSpec(chaos=False, kill_interval=1, restart_window=None,
                         min_alive=1, drain_after=0, park_on_drain=True),
        teardown=TeardownSpec(sweep_restart=False, keep_boxes=True,
                              keep_runners=True, drop_truth=False),
        postgres=PgTarget("127.0.0.1", 1, "u", "p", "d"),
        json_out=None,
    )


class FakeTruth:
    """The truth store, plus a record of *when* it was read.

    `locked_during_fetch` is what lets a test assert the read-under-one-lock
    rule: if the reader holds the box's lock while fetching the row, the box is
    locked at the moment this runs.
    """

    def __init__(self) -> None:
        self.rows: dict[str, TruthRow] = {}
        self.watch: dict[str, object] = {}
        self.locked_during_fetch: list[bool] = []
        # The store being unreachable is not hypothetical: the stack's Postgres
        # went into recovery mid-run and every record raised for a few seconds.
        self.fail_record = False

    def describe(self) -> str:
        return "fake"

    def setup(self) -> None:
        pass

    def record(self, box_id: str, value: str, *, certain: bool = True) -> None:
        if self.fail_record:
            raise StressError("psql failed: the database system is in recovery mode")
        self.rows[box_id] = TruthRow(value, certain)

    def fetch(self, box_id: str) -> TruthRow | None:
        box = self.watch.get(box_id)
        if box is not None:
            self.locked_during_fetch.append(box.lock.locked())
        return self.rows.get(box_id)

    def fetch_all(self) -> dict[str, TruthRow]:
        return dict(self.rows)

    def forget(self, box_id: str) -> None:
        self.rows.pop(box_id, None)

    def drop_run(self) -> None:
        self.rows.clear()


@dataclass
class FakeBoxService:
    """A box whose stored content, and whose willingness to answer, are set by
    the test. `stored` is what a read returns; `accept_write` decides whether a
    write lands; `readable` decides whether a read answers at all."""

    stored: str = ""
    accept_write: bool = True
    readable: bool = True
    started: list[str] = field(default_factory=list)

    created: list[str] = field(default_factory=list)
    destroyed: list[str] = field(default_factory=list)
    next_box_id: str = "b1"

    async def create(self, name: str):
        self.created.append(name)
        return self.next_box_id, OK

    async def write(self, box, value: str) -> Response:
        if not self.accept_write:
            return GATEWAY_TIMEOUT
        self.stored = value
        return OK

    async def read(self, box, *, timeout: int | None = None):
        if not self.readable:
            return None, GATEWAY_TIMEOUT
        return self.stored, OK

    async def stop(self, box) -> Response:
        return OK

    async def destroy(self, box, *, timeout: int = 30) -> Response:
        self.destroyed.append(box.box_id)
        return OK

    async def start(self, box) -> Response:
        self.started.append(box.box_id)
        return OK

    async def await_running(self, box_id_or_name: str) -> str:
        return "running"

    async def resolve_assignment(self, box, fleet) -> None:
        pass


class FakeFleet:
    """Only the two questions the sweep asks of a fleet."""

    def __init__(self, runners=()) -> None:
        self.runners = list(runners)

    def by_id(self, runner_id: str):
        return next((r for r in self.runners if r.runner_id == runner_id), None)

    def alive_runners(self):
        return [r for r in self.runners if r.alive]

    def schedulable(self):
        return self.alive_runners()


@dataclass
class FakeRunner:
    """A runner the sweep can ask about without a process behind it."""

    name: str = "stress-test0001-1"
    runner_id: str = "r1"
    alive: bool = True
    killed: bool = False
    draining: bool = False
    kills: int = 0
    restarts: int = 0
    drained_boxes: list = field(default_factory=list)
    drained_at: float = 0.0
    decommissioned_at: float = 0.0
    restart_gaps: list = field(default_factory=list)
    ports_used: list = field(default_factory=list)
    api_url: str = ""
    decommissioned_before_restart: bool = False


def context(truth: FakeTruth, box_service: FakeBoxService, fleet=None) -> RunContext:
    return RunContext(
        settings=settings(),
        api=None,
        fleet=fleet or FakeFleet(),
        boxes=None,
        box_service=box_service,
        drain=None,
        truth=truth,
        ledger=None,
        rng=random.Random(1),
        stats=Stats(),
        stop=asyncio.Event(),
        abort=asyncio.Event(),
    )
