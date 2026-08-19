"""Assembling and running one session: prepare → drive → sweep → teardown.

This is the only module that knows the order of the phases, and it is written so
each phase's failure cannot destroy the previous phase's findings: a broken sweep
still reports the load, and a broken teardown still reports the verdict.
"""

from __future__ import annotations

import asyncio
import random
import signal

from ..clients.http import Api
from ..clients.psql import Psql
from ..config import Settings
from ..console import err, log, ok, warn
from ..domain.box import BoxRegistry, BoxService
from ..domain.drain import DrainCoordinator
from ..domain.runner import RunnerFleet
from ..errors import StressError
from ..report.console import Report
from ..report.summary import write_json
from ..store.ledger import ControlPlaneLedger
from ..store.truth import open_truth_store
from .context import RunContext, Stats
from .driver import Driver
from .sweep import Sweeper
from .teardown import Teardown


def build_context(settings: Settings) -> RunContext:
    api = Api(settings.control_plane.api_url, settings.control_plane.admin_key)
    stop, abort = asyncio.Event(), asyncio.Event()
    rng = random.Random(settings.run_id)
    boxes = BoxRegistry(rng)
    box_service = BoxService(api, settings.box, abort)
    fleet = RunnerFleet(settings.fleet, api, settings.control_plane.region, settings.run_id)
    ledger = (
        ControlPlaneLedger(Psql(settings.postgres), settings.run_id)
        if Psql.available() else None
    )
    return RunContext(
        settings=settings,
        api=api,
        fleet=fleet,
        boxes=boxes,
        box_service=box_service,
        drain=DrainCoordinator(api, fleet, boxes, box_service, ledger),
        truth=open_truth_store(settings.run_id, settings.postgres, settings.fleet.logs_dir),
        ledger=ledger,
        rng=rng,
        stats=Stats(),
        stop=stop,
        abort=abort,
    )


async def prepare(ctx: RunContext) -> None:
    prefix = await asyncio.to_thread(_resolve_path_prefix, ctx.api)
    ctx.api.prefix = prefix
    log(f"control plane {ctx.api.base_url} (path prefix {prefix or '<none>'})")
    await asyncio.to_thread(ctx.truth.setup)
    ok(f"truth store ready: {ctx.truth.describe().split(' ')[0]} (run {ctx.settings.run_id})")
    for _ in range(ctx.settings.fleet.initial):
        await ctx.fleet.launch()


def _resolve_path_prefix(api: Api) -> str:
    payload = api.require(api.request("GET", "/v1/me"), "GET /v1/me")
    return str((payload or {}).get("path_prefix") or "")


async def run_session(settings: Settings) -> int:
    ctx = build_context(settings)

    def stop_early() -> None:
        warn("signal received — winding down (sweep + cleanup still run)")
        ctx.stop.set()
        ctx.abort.set()

    loop = asyncio.get_running_loop()
    for sig in (signal.SIGINT, signal.SIGTERM):
        loop.add_signal_handler(sig, stop_early)

    sweeper = Sweeper(ctx)
    teardown = Teardown(ctx)
    try:
        await prepare(ctx)
        log(f"driving {settings.load.workers} worker(s) for {settings.load.duration:.0f}s "
            f"(chaos {'on' if settings.faults.chaos else 'off'})")
        await Driver(ctx).drive()
        try:
            await sweeper.run()
        except StressError as exc:
            # A broken sweep must not swallow the load phase's findings.
            err(f"final sweep incomplete: {exc}")
    finally:
        ctx.stop.set()
        try:
            await teardown.run()
        except StressError as exc:
            # Teardown runs before the report, so anything it raises would
            # silently destroy the findings of the run it cleaned up after.
            err(f"cleanup incomplete: {exc}")

    exit_code = Report(ctx, sweeper.verdicts, teardown.job_tally).render()
    if settings.json_out:
        write_json(settings.json_out, ctx, sweeper.verdicts, teardown.job_tally)
        log(f"json summary → {settings.json_out}")
    return exit_code
