"""What the run produced, formatted for a human at a terminal.

Rendering only formats what the sweep and the tallies already decided; no
verdict is computed here. The exit code is derived in one place at the bottom,
so "what the report says" and "what the shell sees" can never disagree.
"""

from __future__ import annotations

from typing import TYPE_CHECKING

from ..console import BOLD, DIM, GREEN, RED, RESET, YELLOW
from ..run.sweep import BoxVerdict, Verdict

if TYPE_CHECKING:  # pragma: no cover — the run assembles the report, not vice versa
    from ..run.context import RunContext

EXIT_CONSISTENT = 0
EXIT_MISMATCH = 1
EXIT_NO_EVIDENCE = 2


class Report:
    def __init__(self, ctx: "RunContext", verdicts: dict[str, BoxVerdict], job_tally) -> None:
        self.ctx = ctx
        self.verdicts = verdicts
        self.job_tally = job_tally

    def render(self) -> int:
        ctx = self.ctx
        print()
        print(f"{BOLD}══ stress run {ctx.settings.run_id} ══{RESET}")
        self._operations()
        tally = self._consistency()
        self._restarts()
        self._drains()
        self._jobs()
        self._failures()
        return self._conclusion(tally)

    def _operations(self) -> None:
        print(f"{BOLD}operations{RESET}")
        for op in sorted(self.ctx.stats.counts):
            outcomes = self.ctx.stats.counts[op]
            summary = "  ".join(f"{k}={v}" for k, v in sorted(outcomes.items()))
            print(f"  {op:<14} {summary}")
        print(f"  {'TOTAL':<14} {self.ctx.stats.total()} operation(s)")

    def _consistency(self) -> dict[str, int]:
        tally: dict[str, int] = {}
        for entry in self.verdicts.values():
            tally[entry.verdict] = tally.get(entry.verdict, 0) + 1
        print(f"\n{BOLD}consistency (box content vs recorded truth){RESET}")
        for verdict in Verdict:
            if verdict in tally:
                colour = GREEN if verdict is Verdict.MATCH else (
                    RED if verdict is Verdict.MISMATCH else YELLOW
                )
                print(f"  {colour}{verdict:<12}{RESET} {tally[verdict]}")
        for box_id, entry in sorted(self.verdicts.items()):
            if entry.verdict is not Verdict.MATCH:
                print(f"    {box_id} {entry.verdict}: {entry.detail}")
        return tally

    def _restarts(self) -> None:
        """A runner that is ready again while the row still names the dead port
        is the failure this section exists for — it looks healthy and every call
        to it goes nowhere."""
        crashed = [r for r in self.ctx.fleet.runners if r.kills]
        if not crashed:
            return
        print(f"\n{BOLD}crash → restart → re-registration{RESET}")
        for runner in crashed:
            ports = " → ".join(f":{p}" for p in runner.ports_used)
            if runner.restarts:
                gaps = ", ".join(f"{g:.0f}s" for g in runner.restart_gaps)
                print(f"  {runner.name:<22} {GREEN}{runner.restarts}/{runner.kills} "
                      f"restart(s) ready in {gaps}{RESET}")
                print(f"    ports {ports} · control plane records {runner.api_url or '<none>'}")
            else:
                why = ("row decommissioned — healthchecks ignored"
                       if runner.decommissioned_before_restart else "never came back")
                colour = YELLOW if runner.decommissioned_before_restart else RED
                print(f"  {runner.name:<22} {colour}{runner.kills} kill(s), {why}{RESET}")
                print(f"    ports {ports}")

    def _drains(self) -> None:
        drained = [r for r in self.ctx.fleet.runners if r.draining]
        if not drained:
            return
        print(f"\n{BOLD}drain → migration → decommission{RESET}")
        for runner in drained:
            attached = runner.drained_boxes
            # Attributed to THIS drain: a box that reached the runner by an
            # earlier migration still carries migrated_to, and counting that as
            # this runner's work inflates the figure.
            migrated = [
                b for b in self.ctx.boxes.boxes
                if b.box_id in attached and b.migrated_from == runner.runner_id
            ]
            verified = [
                b for b in migrated
                if self.verdicts.get(b.box_id, BoxVerdict(Verdict.UNCERTAIN, "")).verdict
                is Verdict.MATCH
            ]
            if runner.decommissioned_at:
                took = f"decommissioned in {runner.decommissioned_at - runner.drained_at:.0f}s"
                colour = GREEN
            else:
                took = "still draining (never decommissioned)"
                colour = YELLOW if not attached else RED
            print(f"  {runner.name:<22} {colour}{took}{RESET}")
            print(f"    boxes attached at drain: {len(attached)}"
                  f" · migrated: {len(migrated)}"
                  f" · migrated+read-verified: {len(verified)}")
            if attached and len(migrated) < len(attached):
                stuck = [b for b in attached if b not in {m.box_id for m in migrated}]
                print(f"    {YELLOW}never migrated{RESET}: {', '.join(stuck[:6])}"
                      f"{' …' if len(stuck) > 6 else ''}")

    def _jobs(self) -> None:
        """A migration retried after a crash is a second job row for the same
        box; one abandoned is a row stuck IN_PROGRESS or FAILED with no successor."""
        if not self.job_tally:
            return
        print(f"\n{BOLD}control-plane jobs (this run's boxes){RESET}")
        for entry in self.job_tally:
            colour = RED if entry.status == "FAILED" else (
                YELLOW if entry.status == "IN_PROGRESS" else ""
            )
            print(f"  {entry.job_type:<22} {colour}{entry.status:<12}"
                  f"{RESET if colour else ''} {entry.count}")

    def _failures(self) -> None:
        stats = self.ctx.stats
        if stats.mismatches:
            print(f"\n{BOLD}{RED}in-run mismatches{RESET}")
            for line in stats.mismatches:
                print(f"  {line}")
        if stats.failures:
            print(f"\n{BOLD}failure sample{RESET}")
            for line in stats.failures[:15]:
                print(f"  {DIM}{line}{RESET}")

    def _conclusion(self, tally: dict[str, int]) -> int:
        stats = self.ctx.stats
        in_run_reads = stats.counts.get("read_box", {})
        mismatches = tally.get(Verdict.MISMATCH, 0) + len(stats.mismatches)
        compared = (
            tally.get(Verdict.MATCH, 0) + tally.get(Verdict.MISMATCH, 0)
            + in_run_reads.get("ok", 0) + in_run_reads.get("mismatch", 0)
        )
        print()
        if mismatches:
            print(f"{RED}{BOLD}INCONSISTENT{RESET} — {mismatches} mismatch(es)")
        elif compared == 0:
            print(f"{YELLOW}{BOLD}NO EVIDENCE{RESET} — nothing was compared "
                  f"(no box reached a readable state)")
        else:
            print(f"{GREEN}{BOLD}CONSISTENT{RESET} — {compared} comparison(s), no mismatch")
        print(f"{DIM}truth rows: {self.ctx.truth.describe()}{RESET}")

        if mismatches:
            return EXIT_MISMATCH
        return EXIT_CONSISTENT if compared else EXIT_NO_EVIDENCE
