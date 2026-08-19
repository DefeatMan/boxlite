"""The things under test: runners, boxes, and the drain contract between them.

Layer 2 — depends on `clients` and `config`; knows nothing about operations,
scheduling or reporting.
"""

from .box import BoxRecord, BoxRegistry, BoxService
from .drain import DrainCoordinator
from .runner import RunnerFleet, RunnerProc

__all__ = [
    "BoxRecord", "BoxRegistry", "BoxService",
    "DrainCoordinator", "RunnerFleet", "RunnerProc",
]
