"""The one exception type the harness raises on its own behalf.

Operations do not raise it: a failing operation is *data* (an outcome plus a
detail string), because a run that stops at the first failed box would never
reach the consistency verdict it exists to produce. `StressError` is for the
cases where continuing would report something untrue — a runner that never
started, a truth store that cannot be reached, a teardown that cannot finish.
"""

from __future__ import annotations


class StressError(RuntimeError):
    """Setup or teardown failed in a way the run cannot continue past."""
