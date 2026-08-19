"""Leave the control plane with none of this run's rows in it.

The order is not obvious and is the whole content of this module: every box a
killed runner still owns is undeletable (the API refuses while the box is
`pending`), and a runner row with any such box is undeletable too. So the dead
runners come back FIRST, purely to execute their own teardown jobs, and the
processes are stopped only once the API has nothing left to ask of them.
"""

from __future__ import annotations

import asyncio
import time

from ..console import err, ok, warn
from ..errors import StressError
from .context import RunContext

BOX_DELETE_ATTEMPTS = 5          # a box mid-state-change refuses DELETE with 400
BOX_DELETE_RETRY_SECONDS = 6
BOX_DESTROY_WAIT = 90            # window for live runners to finish destroy jobs


class Teardown:
    def __init__(self, ctx: RunContext) -> None:
        self.ctx = ctx
        self.job_tally = []

    async def run(self) -> None:
        ctx = self.ctx
        # Read the job ledger before teardown erases it: whether a migration was
        # retried after its runner crashed is only visible in the job rows.
        if ctx.ledger is not None:
            try:
                self.job_tally = await asyncio.to_thread(ctx.ledger.job_tally)
            except StressError as exc:
                warn(f"job ledger unavailable: {exc}")

        if not ctx.settings.teardown.keep_boxes:
            await ctx.fleet.revive_for_teardown()
            for box in ctx.boxes.boxes:
                await self._delete_box(box)
            await self._await_destroyed()

        await ctx.fleet.shutdown()

        if not ctx.settings.teardown.keep_runners:
            await self._delete_runner_rows()
            await self._purge_rows()

        if ctx.settings.teardown.drop_truth:
            await asyncio.to_thread(ctx.truth.drop_run)
        ok("cleanup done")

    async def _delete_box(self, box) -> None:
        """Destroy one box, retrying while the control plane is mid-transition.

        A box caught in a state change answers `400 Box state change in
        progress`; giving up on the first try is how a run leaves debris.
        """
        for attempt in range(BOX_DELETE_ATTEMPTS):
            response = await self.ctx.box_service.destroy(box)
            if response.ok or response.status == 404:
                return
            if response.status not in (400, 409) or attempt == BOX_DELETE_ATTEMPTS - 1:
                warn(f"box {box.box_id} needs the row sweep: HTTP {response.status} "
                     f"{response.message()}")
                return
            await asyncio.sleep(BOX_DELETE_RETRY_SECONDS)

    async def _await_destroyed(self) -> None:
        """Bounded window for the live runners to actually tear the boxes down.
        Boxes on a runner that could not be revived never confirm, so this waits
        on a deadline rather than on all of them."""
        ctx = self.ctx
        deadline = time.monotonic() + BOX_DESTROY_WAIT
        pending = [b for b in ctx.boxes.boxes if b.state != "gone"]
        while pending and time.monotonic() < deadline:
            still = []
            for box in pending:
                response = await ctx.box_service.status(box.box_id, timeout=15)
                status = str((response.json() or {}).get("status") or "") if response.ok else ""
                # 404 = the row is gone; `unknown` is what a DESTROYED (or
                # errored) box maps to on the v1 surface.
                if response.status == 404 or status == "unknown":
                    box.state = "gone"
                    continue
                still.append(box)
            pending = still
            if pending:
                await asyncio.sleep(3)
        if pending:
            warn(f"{len(pending)} box(es) still tearing down (their runner may be dead)")

    async def _delete_runner_rows(self) -> None:
        ctx = self.ctx
        for runner in ctx.fleet.runners:
            if not runner.runner_id:
                continue
            await asyncio.to_thread(
                ctx.api.request, "PATCH", f"/admin/runners/{runner.runner_id}/scheduling",
                body={"unschedulable": True},
            )
            response = await asyncio.to_thread(
                ctx.api.request, "DELETE", f"/admin/runners/{runner.runner_id}"
            )
            if not response.ok:
                warn(f"runner row {runner.name} needs the row sweep: HTTP {response.status} "
                     f"{response.message()}")

    async def _purge_rows(self) -> None:
        """Delete whatever the API would not, and report what is left.

        The API's refusals are correct for an operator — a box whose runner is
        gone may still hold data — but this harness owns every row it deletes:
        the names are `stress-<run_id>-…`, minted by this process, and the run is
        over. Anything still there is debris the next run would inherit.
        """
        ctx = self.ctx
        if ctx.ledger is None:
            warn("no SQL access: leftover control-plane rows cannot be swept")
            return
        try:
            before = await asyncio.to_thread(ctx.ledger.count_rows)
            if not before.any():
                return
            warn(f"API left {before.boxes} box row(s) and {before.runners} runner row(s) "
                 f"behind — sweeping them in SQL")
            await asyncio.to_thread(ctx.ledger.purge_rows)
            after = await asyncio.to_thread(ctx.ledger.count_rows)
        except StressError as exc:
            err(f"row sweep failed, rows are left behind: {exc}")
            return
        if after.any():
            err(f"sweep incomplete: {after.boxes} box row(s), {after.runners} runner row(s) left")
            return
        ok(f"swept {before.boxes} box row(s) and {before.runners} runner row(s)")
