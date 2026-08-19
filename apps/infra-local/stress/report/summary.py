"""The same run, as JSON, for anything that is not a terminal."""

from __future__ import annotations

import json
from pathlib import Path

from typing import TYPE_CHECKING

from ..run.sweep import BoxVerdict

if TYPE_CHECKING:  # pragma: no cover — the run assembles the report, not vice versa
    from ..run.context import RunContext


def write_json(path: Path, ctx: "RunContext", verdicts: dict[str, BoxVerdict], job_tally) -> None:
    tally: dict[str, int] = {}
    for entry in verdicts.values():
        tally[str(entry.verdict)] = tally.get(str(entry.verdict), 0) + 1

    payload = {
        "run_id": ctx.settings.run_id,
        "operations": ctx.stats.counts,
        "consistency": tally,
        "verdicts": {
            box_id: {"verdict": str(entry.verdict), "detail": entry.detail}
            for box_id, entry in verdicts.items()
        },
        "mismatches": ctx.stats.mismatches,
        "restarts": [
            {
                "runner": r.name,
                "kills": r.kills,
                "restarts": r.restarts,
                "seconds_to_ready": [round(g, 1) for g in r.restart_gaps],
                "ports": r.ports_used,
                "api_url": r.api_url,
                "decommissioned_before_restart": r.decommissioned_before_restart,
            }
            for r in ctx.fleet.runners if r.kills
        ],
        "drains": [
            {
                "runner": r.name,
                "boxes_at_drain": r.drained_boxes,
                "migrated": [
                    b.box_id for b in ctx.boxes.boxes
                    if b.box_id in r.drained_boxes and b.migrated_from == r.runner_id
                ],
                "decommissioned": bool(r.decommissioned_at),
                "seconds_to_decommission": (
                    round(r.decommissioned_at - r.drained_at, 1) if r.decommissioned_at else None
                ),
            }
            for r in ctx.fleet.runners if r.draining
        ],
        "jobs": [
            {"type": e.job_type, "status": e.status, "count": e.count} for e in job_tally
        ],
    }
    path.write_text(json.dumps(payload, indent=2))
