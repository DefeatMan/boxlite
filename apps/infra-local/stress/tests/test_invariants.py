"""The rules the verdict rests on, asserted directly.

Every test here fails if the harness would report something untrue: a truth row
holding a value the box never confirmed, a comparison made across an unlocked
window, a dead runner counted as data loss — and, most importantly, a real
divergence going unreported.

Run with:  python -m unittest discover -s stress/tests -t .
"""

from __future__ import annotations

import contextlib
import io
import random
import unittest

from ..domain.box import BoxRecord, BoxRegistry
from ..ops.base import REGISTRY, Outcome
from ..ops.builtin import CreateBox, DestroyBox, ReadBox, WriteBox
from ..report.console import EXIT_CONSISTENT, EXIT_MISMATCH, Report
from ..run.sweep import Sweeper, Verdict
from ..store.truth import TruthRow
from . import fakes


def registry_with(box: BoxRecord) -> BoxRegistry:
    boxes = BoxRegistry(random.Random(1))
    boxes.boxes.append(box)
    return boxes


def running_box(box_id: str = "b1") -> BoxRecord:
    return BoxRecord(box_id=box_id, name=f"stress-test0001-{box_id}",
                     state="running", runner_id="r1", has_truth=True)


class WriteRecordsWhatTheBoxConfirmed(unittest.IsolatedAsyncioTestCase):
    async def test_truth_holds_the_read_back_value_not_the_sent_one(self):
        """The recorded value must come from the box, or the whole comparison is
        circular: the harness would be checking its own intent against itself."""
        box = running_box()
        truth, service = fakes.FakeTruth(), fakes.FakeBoxService()
        ctx = fakes.context(truth, service)
        ctx.boxes = registry_with(box)

        # The box quietly keeps different content than the write asked for.
        async def write_but_store_something_else(record, value):
            service.stored = "what-the-box-really-has"
            return fakes.OK

        service.write = write_but_store_something_else

        result = await WriteBox().run(ctx)

        self.assertIs(result.outcome, Outcome.MISMATCH)
        self.assertEqual(truth.rows[box.box_id].value, "what-the-box-really-has")

    async def test_unreadable_after_a_successful_write_is_uncertain_not_lost(self):
        """A write that succeeded but cannot be read back leaves the content
        genuinely unknown; recording it as certain would invent evidence."""
        box = running_box()
        truth, service = fakes.FakeTruth(), fakes.FakeBoxService(readable=False)
        ctx = fakes.context(truth, service)
        ctx.boxes = registry_with(box)

        result = await WriteBox().run(ctx)

        self.assertIs(result.outcome, Outcome.UNCERTAIN)
        self.assertFalse(truth.rows[box.box_id].certain)

    async def test_failed_write_records_nothing(self):
        box = running_box()
        truth = fakes.FakeTruth()
        service = fakes.FakeBoxService(accept_write=False, readable=False)
        ctx = fakes.context(truth, service)
        ctx.boxes = registry_with(box)

        result = await WriteBox().run(ctx)

        self.assertIs(result.outcome, Outcome.ERROR)
        self.assertEqual(truth.rows, {})


class StaleTruthNeverAccuses(unittest.IsolatedAsyncioTestCase):
    """Regression: run 61999227 reported INCONSISTENT with no data lost.

    The stack's Postgres went into recovery mid-run. A write reached the box and
    then `truth.record` raised, so the row kept the previous value while still
    claiming `certain` — and the next two reads compared a stale row against
    fresh content and called it a mismatch. A checker whose own bookkeeping can
    silently fall behind will accuse the system it is checking.
    """

    async def test_a_write_whose_truth_record_fails_marks_the_box_uncomparable(self):
        box = running_box()
        truth, service = fakes.FakeTruth(), fakes.FakeBoxService(stored="old")
        truth.rows[box.box_id] = TruthRow("old", True)
        truth.fail_record = True
        ctx = fakes.context(truth, service)
        ctx.boxes = registry_with(box)

        result = await WriteBox().run(ctx)

        self.assertIs(result.outcome, Outcome.UNCERTAIN)
        self.assertTrue(box.truth_stale)

    async def test_a_stale_box_is_skipped_rather_than_compared(self):
        box = running_box()
        truth, service = fakes.FakeTruth(), fakes.FakeBoxService(stored="new-value")
        truth.rows[box.box_id] = TruthRow("stale-value", True)
        truth.fail_record = True
        ctx = fakes.context(truth, service)
        ctx.boxes = registry_with(box)

        await WriteBox().run(ctx)          # the store fails here
        truth.fail_record = False          # …and comes back
        result = await ReadBox().run(ctx)  # the row is still behind the box

        self.assertIs(result.outcome, Outcome.SKIP)

    async def test_the_sweep_calls_a_stale_box_uncertain_not_mismatched(self):
        """The same hazard at the other end of the run: the final sweep must not
        turn the harness's own gap into a verdict."""
        box = running_box()
        box.truth_stale = True
        truth, service = fakes.FakeTruth(), fakes.FakeBoxService(stored="newer")
        truth.rows[box.box_id] = TruthRow("older", True)
        ctx = fakes.context(truth, service, fleet=fakes.FakeFleet([fakes.FakeRunner()]))
        ctx.boxes = registry_with(box)

        verdicts = await Sweeper(ctx).run()

        self.assertIs(verdicts[box.box_id].verdict, Verdict.UNCERTAIN)

    async def test_a_later_successful_write_makes_the_box_comparable_again(self):
        box = running_box()
        truth, service = fakes.FakeTruth(), fakes.FakeBoxService(stored="old")
        truth.rows[box.box_id] = TruthRow("old", True)
        truth.fail_record = True
        ctx = fakes.context(truth, service)
        ctx.boxes = registry_with(box)

        await WriteBox().run(ctx)
        truth.fail_record = False
        await WriteBox().run(ctx)

        self.assertFalse(box.truth_stale)
        self.assertIs((await ReadBox().run(ctx)).outcome, Outcome.OK)


class CreateSeedsTheBox(unittest.IsolatedAsyncioTestCase):
    async def test_a_new_box_has_a_truth_row_immediately(self):
        """A box with no truth row is invisible to every later check — the sweep
        skips it and a drain reports it as migrated with nothing to verify. The
        seed write is what stops "9 boxes migrated, 2 confirmed" from being the
        normal outcome."""
        truth, service = fakes.FakeTruth(), fakes.FakeBoxService(next_box_id="fresh")
        ctx = fakes.context(truth, service, fleet=fakes.FakeFleet([fakes.FakeRunner()]))
        ctx.boxes = BoxRegistry(random.Random(1))

        result = await CreateBox().run(ctx)

        self.assertIs(result.outcome, Outcome.OK)
        self.assertIn("fresh", truth.rows)
        self.assertTrue(truth.rows["fresh"].certain)
        self.assertEqual(ctx.stats.counts["seed_write"], {"ok": 1})

    async def test_a_failed_seed_write_is_visible_but_does_not_fail_the_create(self):
        """The box exists and is running either way; hiding the failed seed would
        leave a silently uncheckable box behind."""
        truth = fakes.FakeTruth()
        service = fakes.FakeBoxService(next_box_id="fresh", accept_write=False, readable=False)
        ctx = fakes.context(truth, service, fleet=fakes.FakeFleet([fakes.FakeRunner()]))
        ctx.boxes = BoxRegistry(random.Random(1))

        result = await CreateBox().run(ctx)

        self.assertIs(result.outcome, Outcome.OK)
        self.assertIn("seed write", result.detail)
        self.assertEqual(truth.rows, {})
        self.assertEqual(list(ctx.stats.counts["seed_write"]), ["error"])


class ReadComparesAtomically(unittest.IsolatedAsyncioTestCase):
    async def test_truth_is_fetched_while_the_box_lock_is_held(self):
        """Both halves of the comparison must be taken under one lock. Fetching
        the row outside it lets a write land in between, and the reader then
        holds a pre-write row against post-write content — a mismatch the system
        never actually had."""
        box = running_box()
        truth, service = fakes.FakeTruth(), fakes.FakeBoxService(stored="v1")
        truth.rows[box.box_id] = TruthRow("v1", True)
        truth.watch[box.box_id] = box
        ctx = fakes.context(truth, service)
        ctx.boxes = registry_with(box)

        result = await ReadBox().run(ctx)

        self.assertIs(result.outcome, Outcome.OK)
        self.assertEqual(truth.locked_during_fetch, [True])

    async def test_divergence_is_reported(self):
        """The negative control: a checker that cannot fail proves nothing."""
        box = running_box()
        truth, service = fakes.FakeTruth(), fakes.FakeBoxService(stored="what-the-box-has")
        truth.rows[box.box_id] = TruthRow("what-the-truth-says", True)
        ctx = fakes.context(truth, service)
        ctx.boxes = registry_with(box)

        result = await ReadBox().run(ctx)

        self.assertIs(result.outcome, Outcome.MISMATCH)
        self.assertIn("what-the-box-has", result.detail)

    async def test_uncertain_truth_is_skipped_not_compared(self):
        box = running_box()
        truth, service = fakes.FakeTruth(), fakes.FakeBoxService(stored="anything")
        truth.rows[box.box_id] = TruthRow("unconfirmed", False)
        ctx = fakes.context(truth, service)
        ctx.boxes = registry_with(box)

        result = await ReadBox().run(ctx)

        self.assertIs(result.outcome, Outcome.SKIP)

    async def test_unreadable_box_is_not_a_mismatch(self):
        box = running_box()
        truth, service = fakes.FakeTruth(), fakes.FakeBoxService(readable=False)
        truth.rows[box.box_id] = TruthRow("v1", True)
        ctx = fakes.context(truth, service)
        ctx.boxes = registry_with(box)

        result = await ReadBox().run(ctx)

        self.assertIs(result.outcome, Outcome.UNREADABLE)


class DestroyLeavesNoGhost(unittest.IsolatedAsyncioTestCase):
    async def test_destroying_a_box_drops_its_truth_row(self):
        """A row naming a box the run itself removed is the one state the sweep
        cannot tell apart from real data loss."""
        box = running_box()
        truth, service = fakes.FakeTruth(), fakes.FakeBoxService(stored="v1")
        truth.rows[box.box_id] = TruthRow("v1", True)
        ctx = fakes.context(truth, service, fleet=fakes.FakeFleet([fakes.FakeRunner()]))
        ctx.boxes = registry_with(box)

        result = await DestroyBox().run(ctx)

        self.assertIs(result.outcome, Outcome.OK)
        self.assertEqual(service.destroyed, [box.box_id])
        self.assertEqual(truth.rows, {})
        self.assertEqual(box.state, "gone")

    async def test_the_sweep_then_has_nothing_to_report(self):
        """End to end: destroy, then sweep — the box must not appear at all."""
        box = running_box()
        truth, service = fakes.FakeTruth(), fakes.FakeBoxService(stored="v1")
        truth.rows[box.box_id] = TruthRow("v1", True)
        ctx = fakes.context(truth, service, fleet=fakes.FakeFleet([fakes.FakeRunner()]))
        ctx.boxes = registry_with(box)

        await DestroyBox().run(ctx)
        verdicts = await Sweeper(ctx).run()

        self.assertEqual(verdicts, {})

    async def test_a_box_on_a_draining_runner_is_left_alone(self):
        """It is the subject of a measurement in flight: destroying it would let
        the drain finish early and report a migration that never happened."""
        box = running_box()
        truth, service = fakes.FakeTruth(), fakes.FakeBoxService(stored="v1")
        draining = fakes.FakeRunner(runner_id="r1", draining=True)
        ctx = fakes.context(truth, service, fleet=fakes.FakeFleet([draining]))
        ctx.boxes = registry_with(box)

        result = await DestroyBox().run(ctx)

        self.assertIs(result.outcome, Outcome.SKIP)
        self.assertEqual(service.destroyed, [])


class SweepSeparatesLossFromSilence(unittest.IsolatedAsyncioTestCase):
    async def test_dead_runner_is_unreachable_not_mismatch(self):
        """A box whose runner this run killed cannot answer. Calling that a
        mismatch would blame the system for the test's own fault injection."""
        box = running_box()
        truth, service = fakes.FakeTruth(), fakes.FakeBoxService(stored="v1")
        truth.rows[box.box_id] = TruthRow("v1", True)
        fleet = fakes.FakeFleet([fakes.FakeRunner(runner_id="r1", alive=False, killed=True)])
        ctx = fakes.context(truth, service, fleet=fleet)
        ctx.boxes = registry_with(box)

        verdicts = await Sweeper(ctx).run()

        self.assertIs(verdicts[box.box_id].verdict, Verdict.UNREACHABLE)

    async def test_matching_content_is_a_match(self):
        box = running_box()
        truth, service = fakes.FakeTruth(), fakes.FakeBoxService(stored="v1")
        truth.rows[box.box_id] = TruthRow("v1", True)
        ctx = fakes.context(truth, service, fleet=fakes.FakeFleet([fakes.FakeRunner()]))
        ctx.boxes = registry_with(box)

        verdicts = await Sweeper(ctx).run()

        self.assertIs(verdicts[box.box_id].verdict, Verdict.MATCH)

    async def test_diverged_content_is_a_mismatch(self):
        box = running_box()
        truth, service = fakes.FakeTruth(), fakes.FakeBoxService(stored="drifted")
        truth.rows[box.box_id] = TruthRow("v1", True)
        ctx = fakes.context(truth, service, fleet=fakes.FakeFleet([fakes.FakeRunner()]))
        ctx.boxes = registry_with(box)

        verdicts = await Sweeper(ctx).run()

        self.assertIs(verdicts[box.box_id].verdict, Verdict.MISMATCH)


class VerdictReachesTheExitCode(unittest.IsolatedAsyncioTestCase):
    async def _report_for(self, sweep_verdict: Verdict, stored: str, truth_value: str) -> int:
        box = running_box()
        truth, service = fakes.FakeTruth(), fakes.FakeBoxService(stored=stored)
        truth.rows[box.box_id] = TruthRow(truth_value, True)
        ctx = fakes.context(truth, service, fleet=fakes.FakeFleet([fakes.FakeRunner()]))
        ctx.boxes = registry_with(box)
        verdicts = await Sweeper(ctx).run()
        self.assertIs(verdicts[box.box_id].verdict, sweep_verdict)
        # The report prints; capture it so the suite's own output stays readable.
        rendered = io.StringIO()
        with contextlib.redirect_stdout(rendered):
            exit_code = Report(ctx, verdicts, []).render()
        self.rendered = rendered.getvalue()
        return exit_code

    async def test_mismatch_exits_nonzero(self):
        """The last link: a divergence has to leave the process with a failing
        status, or automation will treat a broken run as a good one."""
        self.assertEqual(await self._report_for(Verdict.MISMATCH, "drifted", "v1"), EXIT_MISMATCH)
        self.assertIn("INCONSISTENT", self.rendered)

    async def test_agreement_exits_zero(self):
        self.assertEqual(await self._report_for(Verdict.MATCH, "v1", "v1"), EXIT_CONSISTENT)


class RegistryGuardsTheWeights(unittest.TestCase):
    def test_every_builtin_op_is_registered(self):
        self.assertEqual(
            set(REGISTRY.names()),
            {"create_box", "write_box", "read_box", "stop_box", "destroy_box",
             "drain_runner", "start_runner", "kill_runner"},
        )

    def test_unknown_op_name_is_rejected(self):
        from ..config import parse_weights

        with self.assertRaises(SystemExit):
            parse_weights("no_such_op=3", REGISTRY.default_weights())

    def test_all_zero_weights_is_rejected(self):
        from ..config import parse_weights

        with self.assertRaises(SystemExit):
            parse_weights(
                ",".join(f"{name}=0" for name in REGISTRY.names()),
                REGISTRY.default_weights(),
            )


class RestartWindowParsing(unittest.TestCase):
    def test_forms(self):
        from ..config import parse_restart_window

        self.assertEqual(parse_restart_window("15:90"), (15.0, 90.0))
        self.assertEqual(parse_restart_window("30"), (30.0, 30.0))
        self.assertIsNone(parse_restart_window("0"))
        with self.assertRaises(SystemExit):
            parse_restart_window("90:15")


if __name__ == "__main__":
    unittest.main()
