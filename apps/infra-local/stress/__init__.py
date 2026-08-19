"""Chaos + consistency stress harness for the infra-local control plane.

Layered rewrite of the single-module `stress.py` this replaced (removed once this
package took over; its final state is in git history). `DESIGN.md` holds the
layer rules and explains why each seam is where it is.

The `sys.path` insertion below: this package sits inside `apps/infra-local` and
reads the stack's own configuration from the sibling `compose` package, so
importing `stress.*` has to work from any working directory — a run driven from
the repo root, an editor, a test.
"""

from __future__ import annotations

import sys
from pathlib import Path

_INFRA_LOCAL = Path(__file__).resolve().parent.parent
if str(_INFRA_LOCAL) not in sys.path:
    sys.path.insert(0, str(_INFRA_LOCAL))
