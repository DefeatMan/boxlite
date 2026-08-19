"""The operation seam: what an operation is, and how one gets registered.

An operation is the unit the load generator schedules. It reports its result
rather than raising, because a run that stopped at the first failed box would
never reach the consistency verdict it exists to produce — the failure *is* the
measurement.

Registration is a decorator keyed by name, mirroring `compose`'s
`ServiceSpec`/`SERVICES` pair (`compose/services.py:33`, `compose/services.py:506`),
where adding a service is a data change rather than an edit to the orchestrator.
Adding an operation is the same: one class, one decorator, no edits anywhere
else — and `--ops-module` lets that class live outside this package entirely.
"""

from __future__ import annotations

import importlib
from dataclasses import dataclass
from enum import StrEnum
from typing import TYPE_CHECKING, Protocol, runtime_checkable

if TYPE_CHECKING:  # pragma: no cover — import cycle only matters to type checkers
    from ..run.context import RunContext


class Outcome(StrEnum):
    """Why the tallies distinguish five results rather than pass/fail:

    `SKIP` means the operation had nothing to act on (no running box yet) — it
    is not a failure and must not dilute the failure count. `UNCERTAIN` means
    the system's state could not be observed, which is different from knowing it
    is wrong: a write whose read-back fails leaves the box's content genuinely
    unknown, and reporting that as a mismatch would be a lie. `MISMATCH` is the
    only result that makes a run inconsistent.
    """

    OK = "ok"
    SKIP = "skip"
    ERROR = "error"
    MISMATCH = "mismatch"
    UNCERTAIN = "uncertain"
    UNREADABLE = "unreadable"


@dataclass(frozen=True)
class Result:
    outcome: Outcome
    detail: str = ""

    @classmethod
    def ok(cls, detail: str = "") -> "Result":
        return cls(Outcome.OK, detail)

    @classmethod
    def skip(cls, detail: str = "") -> "Result":
        return cls(Outcome.SKIP, detail)

    @classmethod
    def error(cls, detail: str) -> "Result":
        return cls(Outcome.ERROR, detail)

    @classmethod
    def mismatch(cls, detail: str) -> "Result":
        return cls(Outcome.MISMATCH, detail)

    @classmethod
    def uncertain(cls, detail: str) -> "Result":
        return cls(Outcome.UNCERTAIN, detail)

    @classmethod
    def unreadable(cls, detail: str) -> "Result":
        return cls(Outcome.UNREADABLE, detail)


@runtime_checkable
class Op(Protocol):
    """One scheduled action against the system under test."""

    name: str
    default_weight: int

    async def run(self, ctx: "RunContext") -> Result: ...


class OpRegistry:
    """Name -> operation. One instance per process, populated by decorators."""

    def __init__(self) -> None:
        self._ops: dict[str, Op] = {}

    def register(self, op: Op) -> Op:
        if op.name in self._ops:
            raise ValueError(f"operation {op.name!r} is already registered")
        self._ops[op.name] = op
        return op

    def get(self, name: str) -> Op:
        try:
            return self._ops[name]
        except KeyError:
            raise KeyError(f"no operation named {name!r}; known: {', '.join(self.names())}")

    def names(self) -> list[str]:
        return sorted(self._ops)

    def default_weights(self) -> dict[str, int]:
        return {name: op.default_weight for name, op in sorted(self._ops.items())}

    def load_module(self, dotted: str) -> list[str]:
        """Import a module so its `@register_op` decorators run.

        This is the whole extension mechanism: a user's operations live in their
        own module, are imported by name, and are then indistinguishable from
        the built-ins — same weights, same tallies, same report.
        """
        before = set(self._ops)
        importlib.import_module(dotted)
        return sorted(set(self._ops) - before)


REGISTRY = OpRegistry()


def register_op(name: str, *, weight: int):
    """Class decorator: `@register_op("write_box", weight=5)`.

    The weight travels with the operation instead of living in a table that has
    to be edited in lockstep — the arrangement that made adding an operation to
    `stress.py` a four-edit change.
    """

    def decorate(cls):
        cls.name = name
        cls.default_weight = weight
        REGISTRY.register(cls())
        return cls

    return decorate
