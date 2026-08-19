"""Preflight — everything that must be true before a run means anything.

Modelled on `compose/doctor.py`: each check returns a failure message or None,
and the messages are the API. The checks here are the ones this harness has
actually been stopped by on real machines, in the order they bite.
"""

from __future__ import annotations

import subprocess
import time
from pathlib import Path

from .clients.http import Api
from .clients.psql import Psql
from .config import Settings
from .console import log, ok, warn
from .errors import StressError

STACK_HEALTH_TIMEOUT = 180


def check_control_plane(settings: Settings, *, may_start: bool) -> None:
    api = Api(settings.control_plane.api_url, settings.control_plane.admin_key, timeout=10)
    if api.request("GET", "/health").ok:
        ok(f"control plane up at {settings.control_plane.api_url}")
        return
    if not may_start:
        raise StressError(
            f"control plane not answering at {settings.control_plane.api_url} — run `make up` "
            f"in apps/infra-local, or pass --start-stack"
        )
    log("control plane down — running `make up` (first run pulls the L1 images)")
    infra_local = Path(__file__).resolve().parent.parent
    result = subprocess.run(["make", "up"], cwd=str(infra_local), check=False)
    if result.returncode != 0:
        raise StressError("`make up` failed — see its output above")
    deadline = time.monotonic() + STACK_HEALTH_TIMEOUT
    while time.monotonic() < deadline:
        if api.request("GET", "/health").ok:
            ok("control plane up")
            return
        time.sleep(3)
    raise StressError(f"control plane never became healthy at {settings.control_plane.api_url}")


def check_runner_binary(settings: Settings) -> None:
    if settings.fleet.runner_bin.exists():
        ok(f"runner binary {settings.fleet.runner_bin.name}")
        return
    raise StressError(
        f"{settings.fleet.runner_bin} missing — run `make up` in apps/infra-local first, "
        f"or pass --runner-bin pointing at the checkout that built the running stack"
    )


def check_truth_backend(settings: Settings) -> None:
    if Psql.available():
        ok(f"truth store: postgres at {settings.postgres.dsn()}")
        return
    warn("psql not on PATH — falling back to a SQLite truth store; leftover "
         "control-plane rows will NOT be swept at the end")


def check_registry_auth(settings: Settings) -> None:
    hosts = settings.fleet.registry.describe()
    if hosts == "none (anonymous pulls)":
        warn("no registry credentials resolved — image pulls will be anonymous and "
             "docker.io may rate-limit them (minutes per layer)")
        return
    ok(f"registry credentials for {hosts}")


def check_archive_store(settings: Settings) -> None:
    if settings.fleet.archive_store is None:
        warn("archive store disabled — box migration on drain cannot work")
        return
    ok(f"archive store {settings.fleet.archive_store.endpoint} "
       f"(bucket {settings.fleet.archive_store.bucket})")


def check_warm_homes(settings: Settings) -> None:
    """A cold home pays a multi-hundred-MB pull before its first box can boot —
    far longer than a typical load window, which is how an entire run can end
    with nothing compared."""
    cold = []
    for index in range(1, settings.fleet.initial + 1):
        home = settings.fleet.home(index)
        images = home / "images"
        if not images.exists() or not any(images.iterdir()):
            cold.append(home.name)
    if cold:
        warn(f"cold runner home(s) {', '.join(cold)} — the first box on each pays a full "
             f"image pull; expect several minutes before the first write")
        return
    ok(f"runner homes warm (s1..s{settings.fleet.initial})")


def preflight(settings: Settings, *, may_start_stack: bool) -> None:
    check_control_plane(settings, may_start=may_start_stack)
    check_runner_binary(settings)
    check_truth_backend(settings)
    check_registry_auth(settings)
    check_archive_store(settings)
    check_warm_homes(settings)
