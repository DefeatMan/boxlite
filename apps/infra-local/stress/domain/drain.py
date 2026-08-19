"""Draining a runner, and following it to its end state.

Draining is checked as a two-part contract, not a flag flip: every box the
runner carried must be reassigned to another runner, and only then may the row
reach DECOMMISSIONED. Both halves are recorded so a report can say which one, if
any, failed.
"""

from __future__ import annotations

import asyncio
import time

from ..clients.http import Api, Response
from ..console import log, ok, warn
from ..store.ledger import ControlPlaneLedger
from .box import BoxRegistry, BoxService
from .runner import RunnerFleet, RunnerProc

POLL_SECONDS = 5


def _is_flag_gated(response: Response) -> bool:
    """OpenFeature's RequireFlagsEnabled hides a disabled route by throwing
    `NotFoundException("Cannot <METHOD> <url>")`, so a gated endpoint is
    indistinguishable from a missing one except by that message."""
    return response.status == 404 and response.message().startswith("Cannot ")


class DrainCoordinator:
    def __init__(
        self,
        api: Api,
        fleet: RunnerFleet,
        boxes: BoxRegistry,
        box_service: BoxService,
        ledger: ControlPlaneLedger | None,
    ) -> None:
        self.api = api
        self.fleet = fleet
        self.boxes = boxes
        self.box_service = box_service
        self.ledger = ledger
        self._warned_fallback = False

    async def drain(self, runner: RunnerProc) -> tuple[str, str]:
        response = await asyncio.to_thread(
            self.api.request, "PATCH", f"/runners/{runner.runner_id}/draining",
            body={"draining": True},
        )
        if response.ok:
            await self._mark_draining(runner)
            return "ok", f"{runner.name} (api)"
        if not _is_flag_gated(response):
            return "error", f"drain {runner.name}: HTTP {response.status} {response.message()}"
        if self.ledger is None:
            return "skip", f"drain {runner.name}: endpoint is flag-gated and no SQL fallback"

        # The endpoint is behind the organization-infrastructure feature flag and
        # no admin route exposes draining. Set the column the scheduler and the
        # decommission cron actually read, so the operation still exercises
        # control-plane behaviour — just not through HTTP.
        if not self._warned_fallback:
            self._warned_fallback = True
            warn("draining endpoint is feature-flagged off here — writing runner.draining in SQL")
        await asyncio.to_thread(self.ledger.set_draining, runner.runner_id)
        await self._mark_draining(runner)
        return "ok", f"{runner.name} (sql fallback)"

    async def _mark_draining(self, runner: RunnerProc) -> None:
        """Snapshot what the runner was carrying when it was told to drain.

        Taken from the control plane, not from cached placement: an assignment
        resolved at create time can be stale (an earlier drain may have migrated
        the box onto *this* runner), and every box the control plane still
        assigns here blocks the decommission.
        """
        for box in list(self.boxes.boxes):
            if box.state != "gone":
                await self.box_service.resolve_assignment(box, self.fleet)
        runner.draining = True
        runner.drained_at = time.monotonic()
        runner.drained_boxes = [
            b.box_id for b in self.boxes.boxes
            if b.runner_id == runner.runner_id and b.state != "gone"
        ]
        log(f"{runner.name} draining with {len(runner.drained_boxes)} box(es) attached")

    async def park_boxes(self, runner: RunnerProc, stop_box) -> int:
        """Stop the drained runner's boxes so migration can claim them.

        `BoxRepository.lockParkedBoxes` only marks boxes that are STOPPED with
        desiredState STOPPED, so a runner whose boxes are all running drains
        forever. Production gets there through auto-stop; here the stop is
        explicit so the migration path is actually reachable.
        """
        targets = [
            b for b in self.boxes.boxes
            if b.runner_id == runner.runner_id and b.state == "running"
        ]
        log(f"parking {len(targets)} box(es) on {runner.name} so migration can claim them")
        for box in targets:
            await stop_box(box)
        return len(targets)

    async def watch(self, stop: asyncio.Event) -> None:
        """Follow every drained runner to its end state until the run stops."""
        while not stop.is_set():
            try:
                await asyncio.wait_for(stop.wait(), timeout=POLL_SECONDS)
            except asyncio.TimeoutError:
                pass
            drained = [r for r in self.fleet.runners if r.draining and not r.decommissioned_at]
            if not drained:
                continue

            states = await self.fleet.states()
            for runner in drained:
                await self._follow(runner, states)

    async def _follow(self, runner: RunnerProc, states: dict[str, str]) -> None:
        for box_id in runner.drained_boxes:
            box = self.boxes.by_id(box_id)
            if box is None or box.migrated_to:
                continue
            before = box.runner_id
            await self.box_service.resolve_assignment(box, self.fleet)
            if box.runner_id and box.runner_id != before:
                box.migrated_from, box.migrated_to = before, box.runner_id
                moved_to = self.fleet.by_id(box.runner_id)
                log(f"{box.box_id} migrated off {runner.name} → "
                    f"{moved_to.name if moved_to else box.runner_id}")
        if states.get(runner.runner_id) == "decommissioned":
            runner.decommissioned_at = time.monotonic()
            migrated = sum(
                1 for b in self.boxes.boxes
                if b.box_id in runner.drained_boxes and b.migrated_from == runner.runner_id
            )
            ok(f"{runner.name} decommissioned after "
               f"{runner.decommissioned_at - runner.drained_at:.0f}s "
               f"({migrated}/{len(runner.drained_boxes)} box(es) migrated)")
