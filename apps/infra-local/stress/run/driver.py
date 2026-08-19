"""What runs, when: workers, the fault interval, and the scheduled drain.

The driver chooses *which* operation and *when*; it never knows *how* one works.
That is the seam that lets a custom op join the run without the driver changing.
"""

from __future__ import annotations

import asyncio

from ..console import DIM, RESET, err, log, warn
from ..domain.runner import RESTART_READY_GRACE
from ..ops.base import REGISTRY, Outcome, Result
from ..ops.builtin import stop_one_box
from .context import RunContext

WORKER_DRAIN_GRACE = 60          # seconds a worker gets to finish its last op


class Driver:
    def __init__(self, ctx: RunContext) -> None:
        self.ctx = ctx

    async def drive(self) -> None:
        ctx = self.ctx
        tasks = [asyncio.create_task(self._worker(i)) for i in range(ctx.settings.load.workers)]
        tasks.append(asyncio.create_task(ctx.drain.watch(ctx.stop)))
        tasks.append(asyncio.create_task(self._scheduled_drain()))
        if ctx.settings.faults.chaos:
            tasks.append(asyncio.create_task(self._chaos_loop()))

        await ctx.sleep(ctx.settings.load.duration)
        ctx.stop.set()
        # A worker parked in a box call can outlive the load window; give it a
        # grace period to unwind, then cancel so the sweep is not held hostage.
        _, pending = await asyncio.wait(tasks, timeout=WORKER_DRAIN_GRACE)
        for task in pending:
            task.cancel()
        await asyncio.gather(*tasks, return_exceptions=True)
        await self._settle_restarts()

    async def _worker(self, worker_id: int) -> None:
        ctx = self.ctx
        names = [n for n in REGISTRY.names() if ctx.settings.load.weights.get(n, 0) > 0]
        weights = [ctx.settings.load.weights[n] for n in names]
        if not names:
            warn(f"w{worker_id}: every operation has weight 0 — nothing to do")
            return
        while not ctx.stop.is_set():
            name = ctx.rng.choices(names, weights=weights, k=1)[0]
            try:
                result = await REGISTRY.get(name).run(ctx)
            except Exception as exc:  # noqa: BLE001 — one bad op must not end the run
                result = Result.error(f"{type(exc).__name__}: {exc}")
            ctx.stats.record(name, str(result.outcome), result.detail)
            if result.outcome in (Outcome.ERROR, Outcome.MISMATCH, Outcome.UNREADABLE):
                err(f"w{worker_id} {name}: {result.detail}")
            elif result.outcome is Outcome.UNCERTAIN:
                warn(f"w{worker_id} {name}: {result.detail}")
            elif result.outcome is not Outcome.SKIP:
                log(f"{DIM}w{worker_id} {name}: {result.outcome} {result.detail}{RESET}")
            await ctx.sleep(ctx.rng.uniform(0, ctx.settings.load.think_time))

    async def _chaos_loop(self) -> None:
        ctx = self.ctx
        killer = REGISTRY.get("kill_runner")
        while not ctx.stop.is_set():
            await ctx.sleep(ctx.settings.faults.kill_interval * ctx.rng.uniform(0.6, 1.4))
            if ctx.stop.is_set():
                return
            result = await killer.run(ctx)
            ctx.stats.record("kill_runner", str(result.outcome), result.detail)
            if result.outcome is Outcome.OK:
                warn(f"fault injected: {result.detail}")

    async def _scheduled_drain(self) -> None:
        """With --drain-after, drain the runner holding the most boxes, once.

        The random drain operation can fire before any box exists, which
        exercises nothing: an empty runner decommissions immediately. This makes
        the interesting case reproducible.
        """
        ctx = self.ctx
        if not ctx.settings.faults.drain_after:
            return
        await ctx.sleep(ctx.settings.faults.drain_after)
        if ctx.stop.is_set():
            return
        loaded = sorted(
            (r for r in ctx.fleet.schedulable() if r.runner_id),
            key=lambda r: len(ctx.boxes.on_runner(r.runner_id)),
            reverse=True,
        )
        if not loaded:
            warn("scheduled drain: no schedulable runner to drain")
            return
        runner = loaded[0]
        outcome, detail = await ctx.drain.drain(runner)
        ctx.stats.record("drain_runner", outcome, detail)
        log(f"scheduled drain: {outcome} {detail}")
        if outcome != "ok" or not ctx.settings.faults.park_on_drain:
            return

        async def stop_and_record(box) -> None:
            result = await stop_one_box(ctx, box)
            ctx.stats.record("stop_box", str(result.outcome), result.detail)

        await ctx.drain.park_boxes(runner, stop_and_record)

    async def _settle_restarts(self) -> None:
        """Let outstanding crash restarts finish before anything is judged.

        A runner still inside its restart delay when the load window closes is
        not a dead runner, and sweeping its boxes as `unreachable` would report a
        data loss the system never had.
        """
        ctx = self.ctx
        if not ctx.restarts:
            return
        budget = ctx.settings.fleet.ready_timeout + RESTART_READY_GRACE
        if ctx.settings.faults.restart_window:
            budget += ctx.settings.faults.restart_window[1]
        log(f"waiting up to {budget:.0f}s for {len(ctx.restarts)} restart(s) to settle")
        _, pending = await asyncio.wait(ctx.restarts, timeout=budget)
        for task in pending:
            task.cancel()
        await asyncio.gather(*ctx.restarts, return_exceptions=True)
        ctx.restarts.clear()
