"""Operations: the units the load generator schedules.

`base` defines what an operation is and holds the registry; `builtin` and
`faults` register the ones that ship with the harness. Importing this package
is what makes the built-ins discoverable, so the CLI imports it once and then
talks only to `REGISTRY`.
"""

from .base import REGISTRY, Op, OpRegistry, Outcome, Result, register_op
from . import builtin, faults  # noqa: F401,E402 — imported for their registrations

__all__ = ["REGISTRY", "Op", "OpRegistry", "Outcome", "Result", "register_op"]
