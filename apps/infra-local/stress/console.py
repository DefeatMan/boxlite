"""Timestamped console output for a run.

Named `console`, not `logging`: it is deliberately not the stdlib's logger. A
stress run is watched live, so the requirements are a monotonic clock reading on
every line (to correlate with the runner logs and the control plane's own
timestamps) and colour only when a human is looking. Levels, handlers and
formatters would buy nothing here.

The clock starts when this module is first imported, which is process start —
the same origin the run's own `[   12.3s]` prefixes use everywhere else.
"""

from __future__ import annotations

import sys
import time


def _tty(code: str) -> str:
    """Colour codes collapse to nothing when stdout is redirected, so a log file
    holds the same text a terminal shows."""
    return code if sys.stdout.isatty() else ""


GREEN, YELLOW, RED, DIM, BOLD, RESET = (
    _tty("\033[32m"), _tty("\033[33m"), _tty("\033[31m"),
    _tty("\033[2m"), _tty("\033[1m"), _tty("\033[0m"),
)

_T0 = time.monotonic()


def elapsed() -> float:
    """Seconds since the process started — the run's own clock."""
    return time.monotonic() - _T0


def log(message: str) -> None:
    print(f"{DIM}[{elapsed():7.1f}s]{RESET} {message}", flush=True)


def ok(message: str) -> None:
    log(f"{GREEN}✓{RESET} {message}")


def warn(message: str) -> None:
    log(f"{YELLOW}⚠{RESET} {message}")


def err(message: str) -> None:
    log(f"{RED}✗{RESET} {message}")
