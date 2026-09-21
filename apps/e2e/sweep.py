#!/usr/bin/env python3
"""Reclaim boxes an earlier e2e run stranded in a cloud org.

Why this exists: the cloud run against dev (30788880372's predecessor,
30787280531, 2026-08-03) failed 53 tests and errored 12, and every single
failure read "Organization quota exceeded: disk limit exceeded (max 512GB)".
Nothing in the stack reclaims a box whose test process died before teardown —
`auto_remove=True` is a no-op over REST and the API defaults `auto_delete` to
disabled — so the org's disk filled with boxes from runs that had long since
finished, and the suite could not pass no matter what the code did.

`conftest.bound_box_lifetime` stops that happening again for boxes the pytest
cases create. This script is the other half: it clears what earlier runs left
behind, and covers the boxes the polyglot drivers (`apps/e2e/sdks/`) and the
CLI create, which never pass through that fixture.

Scope, stated plainly: every box in the organization the credential belongs to
that has been idle past the threshold — not only the ones an e2e run created.
Nothing on a box records which run made it, so a maintainer's own box, left
stopped for longer than the window, is a candidate too. That is why the
default window is a day rather than an hour (any run is done inside 45
minutes), why the default is a report and `--apply` is opt-in, and why
.github/workflows/e2e-cloud.yml runs this on dev only. Staleness comes from
`last_activity_at`, falling back to `created_at` for a box that never recorded
any, so a box in use is never a candidate.

    python3 apps/e2e/sweep.py                     # report only
    python3 apps/e2e/sweep.py --apply             # delete what it reports
    python3 apps/e2e/sweep.py --idle-minutes 120  # narrower window

Credentials come from the same place the suite's fixtures read them
(`apps/e2e/lib/e2e_auth.py`): BOXLITE_E2E_* env vars, else the profile in
~/.boxlite/credentials.toml.
"""
from __future__ import annotations

import argparse
from datetime import datetime, timezone
from pathlib import Path
import sys

sys.path.insert(0, str(Path(__file__).resolve().parent / "lib"))

from e2e_auth import auth_context, request_json  # noqa: E402


DEFAULT_IDLE_MINUTES = 24 * 60


def _parse_timestamp(raw: str | None) -> datetime | None:
    if not raw:
        return None
    try:
        parsed = datetime.fromisoformat(raw.replace("Z", "+00:00"))
    except ValueError:
        return None
    return parsed if parsed.tzinfo else parsed.replace(tzinfo=timezone.utc)


def _idle_since(box: dict) -> datetime | None:
    """When this box was last touched, as the control plane sees it."""
    return _parse_timestamp(box.get("last_activity_at")) or _parse_timestamp(box.get("created_at"))


def _list_boxes() -> list[dict]:
    status, body = request_json("GET", auth_context().v1("boxes"))
    if status != 200:
        raise SystemExit(f"GET boxes returned HTTP {status}: {body}")
    return list((body or {}).get("boxes") or [])


def _delete(box_id: str) -> tuple[int, dict | None]:
    return request_json("DELETE", auth_context().v1(f"boxes/{box_id}"))


def sweep(idle_minutes: int, apply: bool) -> int:
    """Report — and with `apply`, delete — every box idle past the threshold."""
    now = datetime.now(timezone.utc)
    boxes = _list_boxes()
    stale: list[tuple[dict, float]] = []
    for box in boxes:
        since = _idle_since(box)
        if since is None:
            # No timestamp at all: the box's age is unknown, and guessing it is
            # stale would delete something that might be seconds old.
            continue
        idle_minutes_actual = (now - since).total_seconds() / 60
        if idle_minutes_actual >= idle_minutes:
            stale.append((box, idle_minutes_actual))

    print(f"{len(boxes)} box(es) visible to this credential; {len(stale)} idle >= {idle_minutes}m")
    for box, idle in sorted(stale, key=lambda item: -item[1]):
        print(
            f"  {box.get('box_id')}  status={box.get('status')}  "
            f"idle={idle:.0f}m  image={box.get('image')}  name={box.get('name')}"
        )

    if not apply:
        if stale:
            print("report only — pass --apply to delete the boxes listed above")
        return 0

    failures = 0
    for box, _ in stale:
        box_id = str(box.get("box_id"))
        status, body = _delete(box_id)
        # 404 means someone (or auto-delete) got there first — the desired end
        # state either way.
        if status in (200, 202, 204, 404):
            print(f"  deleted {box_id} (HTTP {status})")
            continue
        failures += 1
        print(f"  FAILED to delete {box_id}: HTTP {status}: {body}")

    if failures:
        print(f"{failures} deletion(s) failed; the org's quota may still be exhausted")
        return 1
    return 0


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__.splitlines()[0])
    parser.add_argument(
        "--idle-minutes",
        type=int,
        default=DEFAULT_IDLE_MINUTES,
        help=f"treat a box idle at least this long as stranded (default {DEFAULT_IDLE_MINUTES})",
    )
    parser.add_argument(
        "--apply",
        action="store_true",
        help="delete the reported boxes instead of only listing them",
    )
    args = parser.parse_args()
    if args.idle_minutes < 1:
        parser.error("--idle-minutes must be at least 1")
    return sweep(args.idle_minutes, args.apply)


if __name__ == "__main__":
    raise SystemExit(main())
