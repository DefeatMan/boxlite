"""The verdict: every box with a truth row, compared one last time.

The sweep only reads — the truth store and the boxes. It shares no state with
the operations that produced the history, which is what makes its verdict worth
anything: if the checker could be influenced by the writer, agreement would
prove nothing.

Stopped boxes are restarted first, because surviving a stop/start cycle is part
of what "consistent" has to mean.
"""

from __future__ import annotations

import asyncio
from dataclasses import dataclass
from enum import StrEnum

from ..console import log
from .context import RunContext

SWEEP_READ_TIMEOUT = 30          # per-box read budget


class Verdict(StrEnum):
    MATCH = "match"
    MISMATCH = "MISMATCH"
    MISSING = "missing"
    UNREACHABLE = "unreachable"
    UNCERTAIN = "uncertain"


@dataclass(frozen=True)
class BoxVerdict:
    verdict: Verdict
    detail: str


class Sweeper:
    def __init__(self, ctx: RunContext) -> None:
        self.ctx = ctx
        self.verdicts: dict[str, BoxVerdict] = {}

    async def run(self) -> dict[str, BoxVerdict]:
        ctx = self.ctx
        truth = await asyncio.to_thread(ctx.truth.fetch_all)
        log(f"final sweep over {len(truth)} box(es) with a truth row")
        for box_id, row in sorted(truth.items()):
            self.verdicts[box_id] = await self._judge(box_id, row)
        return self.verdicts

    async def _judge(self, box_id: str, row) -> BoxVerdict:
        ctx = self.ctx
        box = ctx.boxes.by_id(box_id)
        if box is None:
            return BoxVerdict(Verdict.UNCERTAIN, "box not tracked by this run")
        if not row.certain:
            return BoxVerdict(Verdict.UNCERTAIN, "write outcome was unobservable")
        if box.truth_stale:
            # A write reached the box while the truth store was unreachable, so
            # this row is behind the box's real content by an unknown amount.
            # Comparing them would report a divergence the harness itself caused.
            return BoxVerdict(Verdict.UNCERTAIN, "truth store missed a write to this box")

        # A box whose runner this run killed cannot answer and cannot be
        # restarted: the start job would sit in the queue of a process that no
        # longer exists, so waiting on it burns the whole sweep.
        owner = ctx.fleet.by_id(box.runner_id)
        if owner is not None and not owner.alive:
            return BoxVerdict(
                Verdict.UNREACHABLE,
                f"{self._where(box)}: its runner is gone, box never migrated",
            )

        if ctx.settings.teardown.sweep_restart and box.state != "running":
            response = await ctx.box_service.start(box)
            if response.ok or response.status == 408:
                box.state = await ctx.box_service.await_running(box.box_id)
            elif not response.ok:
                return BoxVerdict(
                    Verdict.UNREACHABLE,
                    f"{self._where(box)}: HTTP {response.status} {response.message()}",
                )

        stored, response = await ctx.box_service.read(box, timeout=SWEEP_READ_TIMEOUT)
        if stored is None:
            verdict = Verdict.MISSING if response.status == 404 else Verdict.UNREACHABLE
            return BoxVerdict(
                verdict, f"{self._where(box)}: HTTP {response.status} {response.message()}"
            )
        if stored == row.value:
            return BoxVerdict(Verdict.MATCH, self._where(box))
        return BoxVerdict(
            Verdict.MISMATCH,
            f"{self._where(box)}: truth {row.value!r} != box {stored!r}",
        )

    def _where(self, box) -> str:
        owner = self.ctx.fleet.by_id(box.runner_id)
        where = f"on {owner.name}{' (KILLED)' if owner.killed else ''}" if owner else (
            f"on {box.runner_name or 'unknown runner'}"
        )
        if box.migrated_to:
            source = self.ctx.fleet.by_id(box.migrated_from)
            where += f", migrated from {source.name if source else box.migrated_from}"
        return where
