"""The operations that ship with the harness.

Each one is a class with a `run(ctx)`; the decorator registers it and carries its
default weight. Ops state intent and classify outcomes — they never assemble a
URL, and they never raise to signal a failed operation.
"""

from __future__ import annotations

import asyncio
from typing import TYPE_CHECKING

from ..domain.box import BoxRecord
from ..console import warn
from ..errors import StressError
from .base import Outcome, Result, register_op

if TYPE_CHECKING:  # pragma: no cover — ops are below `run`; the type is not a dependency
    from ..run.context import RunContext


@register_op("start_runner", weight=1)
class StartRunner:
    async def run(self, ctx: "RunContext") -> Result:
        try:
            runner = await ctx.fleet.launch(cap=ctx.settings.fleet.maximum)
        except StressError as exc:
            return Result.error(str(exc))
        if runner is None:
            return Result.skip("fleet at max")
        return Result.ok(runner.name)


@register_op("create_box", weight=3)
class CreateBox:
    async def run(self, ctx: "RunContext") -> Result:
        target = ctx.fleet.schedulable()
        nominated = ctx.rng.choice(target).name if target else ""
        name = await ctx.boxes.next_name(ctx.settings.run_id)

        box_id, response = await ctx.box_service.create(name)
        if box_id is None:
            return Result.error(f"create {name}: HTTP {response.status} {response.message()}")

        # Track the box before waiting on it: a box that never starts still
        # exists, still holds runner capacity, and still has to be cleaned up.
        record = BoxRecord(box_id=box_id, name=name, nominated_runner=nominated)
        await ctx.boxes.add(record)
        await ctx.box_service.resolve_assignment(record, ctx.fleet)

        record.state = await ctx.box_service.await_running(box_id)
        if record.state != "running":
            return Result.error(f"create {name}: box settled in {record.state}")
        if not record.runner_id:  # the assignment lookup raced the insert
            await ctx.box_service.resolve_assignment(record, ctx.fleet)

        where = record.runner_name or record.runner_id or "unknown runner"
        detail = f"{record.box_id} on {where}"
        if nominated and nominated != record.runner_name:
            detail += f" (nominated {nominated}; the control plane schedules)"

        # Seed the box immediately, so it has content from birth.
        #
        # Without this a box only acquires a truth row when the weighted
        # generator happens to pick it for a write, and a box that is stopped or
        # migrated before that never acquires one at all. Such a box is invisible
        # to every later check: the sweep skips it, and a drain that moves it
        # reports "migrated" with nothing to verify. A run that moved nine boxes
        # could confirm the content of two — not because migration lost data, but
        # because seven boxes never had any.
        seed = await write_one_box(ctx, record)
        ctx.stats.record("seed_write", str(seed.outcome), seed.detail)
        if seed.outcome is not Outcome.OK:
            detail += f" (seed write {seed.outcome})"
        return Result.ok(detail)


async def _record(ctx: "RunContext", box: BoxRecord, value: str, *, certain: bool) -> bool:
    """Store the box's new value; report whether the store took it.

    A store that is momentarily unreachable — the stack's Postgres went into
    recovery mid-run and refused every connection for a few seconds — leaves the
    row behind the box while it still claims to be certain. Comparing those two
    afterwards produced two mismatches against a system that had lost nothing, so
    a box whose value could not be recorded is marked uncomparable until a later
    write records cleanly.
    """
    try:
        await asyncio.to_thread(ctx.truth.record, box.box_id, value, certain=certain)
    except StressError as exc:
        box.truth_stale = True
        warn(f"{box.box_id}: truth not recorded, box is now uncomparable — {exc}")
        return False
    box.has_truth = True
    box.truth_stale = False
    return True


async def write_one_box(ctx: "RunContext", box: BoxRecord) -> Result:
    """Write a fresh value to one box and record what the box confirms.

    Shared by the scheduled operation and by `create_box`'s seed write, so both
    paths obey the same rule: the truth row holds the value the box handed back,
    never the one the harness sent.
    """
    value = ctx.next_value(box.box_id)
    async with box.lock:
        if box.state != "running":  # another worker stopped it since the pick
            return Result.skip(f"{box.box_id}: {box.state}")
        put = await ctx.box_service.write(box, value)
        # Read back before recording: the truth row must hold what the box
        # actually has, not what this harness hoped it wrote.
        stored, read = await ctx.box_service.read(box)
        if stored is None:
            if put.ok:
                # Write reported success but the content is unreadable — the
                # box's state is genuinely unknown, so say so.
                if not await _record(ctx, box, value, certain=False):
                    return Result.uncertain(f"{box.box_id}: wrote, and the truth store is down")
                return Result.uncertain(f"{box.box_id}: wrote but read-back HTTP {read.status}")
            return Result.error(f"write {box.box_id}: HTTP {put.status} {put.message()}")
        if not await _record(ctx, box, stored, certain=True):
            return Result.uncertain(
                f"{box.box_id}: box now holds a value the truth store could not accept"
            )
    if not put.ok:
        return Result.uncertain(f"{box.box_id}: write HTTP {put.status}, stored value read back")
    if stored != value:
        return Result.mismatch(f"{box.box_id}: wrote {value!r}, box returned {stored!r}")
    return Result.ok(box.box_id)


@register_op("write_box", weight=5)
class WriteBox:
    async def run(self, ctx: "RunContext") -> Result:
        box = ctx.boxes.pick(running_only=True)
        if box is None:
            return Result.skip("no running box")
        return await write_one_box(ctx, box)


@register_op("read_box", weight=6)
class ReadBox:
    async def run(self, ctx: "RunContext") -> Result:
        # Running boxes only: whether content survives a stop is what the final
        # sweep checks, with a restart first, instead of guessing here.
        box = ctx.boxes.pick(with_truth=True, running_only=True)
        if box is None:
            return Result.skip("no running box with truth")
        # Truth row and box content are read under the SAME lock, or the
        # comparison is not a comparison: fetching the row first and taking the
        # lock after lets a write land in between, and the reader then holds a
        # pre-write row against post-write content — a mismatch the system never
        # actually had.
        async with box.lock:
            if box.state != "running":
                return Result.skip(f"{box.box_id}: {box.state}")
            if box.truth_stale:
                # The box moved on while the store was unreachable; the row is
                # behind by an unknown amount and cannot be compared.
                return Result.skip(f"{box.box_id}: truth is stale")
            row = await asyncio.to_thread(ctx.truth.fetch, box.box_id)
            if row is None:
                return Result.skip(f"{box.box_id}: no truth row")
            if not row.certain:
                return Result.skip(f"{box.box_id}: truth uncertain")
            stored, read = await ctx.box_service.read(box)
        if stored is None:
            return Result.unreadable(f"{box.box_id}: HTTP {read.status} {read.message()}")
        if stored != row.value:
            return Result.mismatch(f"{box.box_id}: postgres {row.value!r} != box {stored!r}")
        return Result.ok(box.box_id)


async def stop_one_box(ctx: "RunContext", box: BoxRecord) -> Result:
    """Shared by the operation and by the drain's parking step."""
    async with box.lock:
        if box.state != "running":
            return Result.skip(f"{box.box_id}: {box.state}")
        response = await ctx.box_service.stop(box)
        if not response.ok:
            return Result.error(f"stop {box.box_id}: HTTP {response.status} {response.message()}")
        box.state = "stopped"
    return Result.ok(box.box_id)


@register_op("stop_box", weight=1)
class StopBox:
    async def run(self, ctx: "RunContext") -> Result:
        box = ctx.boxes.pick(running_only=True)
        if box is None:
            return Result.skip("no running box")
        return await stop_one_box(ctx, box)


@register_op("destroy_box", weight=1)
class DestroyBox:
    """Give a box back, so the run does not strangle itself on the org's cap.

    Without this the box population only grows: every create counts against the
    organization's concurrent-box quota, so a long run spends its tail failing
    every create, and the final sweep cannot even restart a stopped box to read
    it — a run once had a migrated box it could not verify for exactly this
    reason, with nothing wrong in the system under test.

    Two boxes are deliberately off limits. One on a draining runner is the
    subject of a measurement in flight: destroying it would let the drain finish
    early and report a migration that never had to happen. And a box that still
    has a truth row is only safe to destroy once that row is dropped — the store
    must never name a box the run itself removed, or the sweep reports the
    harness's own cleanup as missing data.
    """

    async def run(self, ctx: "RunContext") -> Result:
        draining = {r.runner_id for r in ctx.fleet.runners if r.draining}
        candidates = [
            b for b in ctx.boxes.boxes
            if b.state not in ("gone", "creating")
            and b.runner_id not in draining
            and not b.lock.locked()
        ]
        if not candidates:
            return Result.skip("no box free to destroy")
        box = ctx.rng.choice(candidates)

        async with box.lock:
            if box.state in ("gone", "creating"):
                return Result.skip(f"{box.box_id}: {box.state}")
            response = await ctx.box_service.destroy(box)
            if not response.ok and response.status != 404:
                return Result.error(
                    f"destroy {box.box_id}: HTTP {response.status} {response.message()}"
                )
            # Forget first, mark second: a crash between the two would leave a
            # row for a box that no longer exists, which is the one state the
            # sweep cannot tell apart from real data loss.
            if box.has_truth:
                await asyncio.to_thread(ctx.truth.forget, box.box_id)
                box.has_truth = False
            box.state = "gone"
        return Result.ok(box.box_id)


@register_op("drain_runner", weight=1)
class DrainRunner:
    async def run(self, ctx: "RunContext") -> Result:
        candidates = [r for r in ctx.fleet.schedulable() if r.runner_id]
        if len(candidates) <= ctx.settings.faults.min_alive:
            return Result.skip("would leave no schedulable runner")
        outcome, detail = await ctx.drain.drain(ctx.rng.choice(candidates))
        return Result(Outcome(outcome), detail)
