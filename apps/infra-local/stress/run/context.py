"""What an operation is allowed to see.

`RunContext` is the facade the ops layer talks to: the fleet, the boxes, the
truth store, the RNG, and the two events that end a run. Everything below it —
HTTP, SQL, subprocesses — is deliberately out of reach, so an operation cannot
grow a dependency on the transport by accident.
"""

from __future__ import annotations

import asyncio
import random
from dataclasses import dataclass, field

from ..clients.http import Api
from ..config import Settings
from ..domain.box import BoxRegistry, BoxService
from ..domain.drain import DrainCoordinator
from ..domain.runner import RunnerFleet
from ..store.ledger import ControlPlaneLedger
from ..store.truth import TruthStore


class Stats:
    """Per-operation outcome tallies plus the sample of failures worth reading."""

    def __init__(self) -> None:
        self.counts: dict[str, dict[str, int]] = {}
        self.failures: list[str] = []
        self.mismatches: list[str] = []

    def record(self, op: str, outcome: str, detail: str = "") -> None:
        self.counts.setdefault(op, {}).setdefault(outcome, 0)
        self.counts[op][outcome] += 1
        if outcome == "mismatch" and detail:
            self.mismatches.append(f"{op}: {detail}")
        elif outcome not in ("ok", "skip", "match") and detail and len(self.failures) < 40:
            self.failures.append(f"{op}: {detail}")

    def total(self) -> int:
        return sum(sum(o.values()) for o in self.counts.values())


@dataclass
class RunContext:
    settings: Settings
    api: Api
    fleet: RunnerFleet
    boxes: BoxRegistry
    box_service: BoxService
    drain: DrainCoordinator
    truth: TruthStore
    ledger: ControlPlaneLedger | None
    rng: random.Random
    stats: Stats
    stop: asyncio.Event                 # stop generating load
    abort: asyncio.Event                # signal received: cut long waits short too
    restarts: list[asyncio.Task] = field(default_factory=list)
    _value_seq: int = 0

    def next_value(self, box_id: str) -> str:
        """A value no other box, run or write can produce, so a mismatch names
        exactly which write leaked where."""
        self._value_seq += 1
        nonce = self.rng.randrange(1 << 32)
        return f"{self.settings.run_id}-{box_id}-{self._value_seq:06d}-{nonce:08x}"

    async def sleep(self, seconds: float) -> None:
        """Sleep that wakes immediately when the run is told to stop."""
        try:
            await asyncio.wait_for(self.stop.wait(), timeout=seconds)
        except asyncio.TimeoutError:
            pass
