"""Fault injection, as ordinary operations.

A crash is modelled as crash-then-restart, because that is what a supervised
process does in production: the runner comes back after a random delay, reusing
its API key and its home but taking a NEW port. A crash nothing comes back from
is a machine loss — rarer, recovered through a different path — and is what
`--restart-after-kill 0` reproduces.

The fault op is registered like any other but carries weight 0: the chaos loop
schedules it on its own interval, because "every N seconds" is a different
question from "how often relative to reads and writes".
"""

from __future__ import annotations

import asyncio
from typing import TYPE_CHECKING

from ..console import err, ok, warn
from ..domain.runner import RunnerProc
from .base import Result, register_op

if TYPE_CHECKING:  # pragma: no cover — ops are below `run`; the type is not a dependency
    from ..run.context import RunContext


@register_op("kill_runner", weight=0)
class KillRunner:
    async def run(self, ctx: "RunContext") -> Result:
        candidates = ctx.fleet.alive_runners()
        if len(candidates) <= ctx.settings.faults.min_alive:
            return Result.skip("would drop below --min-alive")
        runner = ctx.rng.choice(candidates)
        await ctx.fleet.kill(runner)
        orphaned = ctx.boxes.on_runner(runner.runner_id)
        detail = f"SIGKILL {runner.name} ({len(orphaned)} box(es) orphaned)"

        window = ctx.settings.faults.restart_window
        if window is None:
            return Result.ok(f"{detail}, staying down")
        delay = ctx.rng.uniform(*window)
        ctx.restarts.append(asyncio.create_task(restart_after(ctx, runner, delay)))
        return Result.ok(f"{detail}, restarting in {delay:.0f}s")


async def restart_after(ctx: "RunContext", runner: RunnerProc, delay: float) -> None:
    """Wait out the crash window, then bring the runner back on a new port.

    A plain sleep, not `ctx.sleep`: a restart that collapsed to zero the moment
    the load window closed would report a recovery time the run never waited out.
    Only a signal cuts it short, and then teardown revives the runner anyway.
    """
    try:
        await asyncio.sleep(delay)
    except asyncio.CancelledError:
        return
    if ctx.abort.is_set():
        return
    outcome, detail = await ctx.fleet.restart(runner)
    ctx.stats.record("restart_runner", outcome, detail)
    if outcome == "ok":
        ok(f"recovered: {detail}")
    else:
        (warn if outcome == "skip" else err)(f"restart {outcome}: {detail}")
