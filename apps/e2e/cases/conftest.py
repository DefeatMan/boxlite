"""Pytest fixtures for the e2e suite.

Every fixture here forces the **REST** path. There is no `Boxlite.default()`
fixture in this file by design — local-FFI tests belong under
`sdks/python/tests/`, not `apps/e2e/`.

The autouse fixture `verify_runner_saw_all_boxes` proves per-test that
every box the test created actually reached the runner via the API. If a
test accidentally swaps to local-FFI or talks to the wrong endpoint,
that fixture fails the test with a path-bypass error.
"""
from __future__ import annotations

import asyncio
import os
import sys
import time
from pathlib import Path

import pytest
import pytest_asyncio

import boxlite

sys.path.insert(0, str(Path(__file__).parent.parent / "lib"))
from e2e_auth import auth_context, credentials_path
from images import default_image
from path_verification import runner_journal_seek, runner_hits_for_box

DEFAULT_IMAGE = default_image()

# Every box this suite creates gets a lifetime a dead run cannot outlive.
#
# `auto_remove=True` is a no-op over REST and the API defaults auto_delete to
# disabled, so a box whose teardown never ran used to stay in the org for
# good. That is what killed the last cloud run against dev (30787280531,
# 2026-08-03): 53 failures and 12 errors, every single one of them
# "Organization quota exceeded: disk limit exceeded (max 512GB)" — the org's
# disk was full of boxes earlier runs had stranded.
#
# auto_stop stops an idle box and auto_delete then removes the stopped one;
# both checks run on a 10-second cron against lastActivityAt
# (apps/api/src/box/managers/box.manager.ts:69,154). E2B bounds its own cloud
# test sandboxes the same way — `kwargs.setdefault("timeout", 300)` in
# packages/python-sdk/tests/conftest.py:75, inside the factory every case
# builds its sandbox through (conftest.py:71-88).
#
# The windows must outlast a single test, not shorten it: CI bounds each test
# at 180s, and a box stopped from under a running test would fail it. A test
# that needs a different policy sets it on BoxOptions and keeps it.
#
# Two doors lead to a box and both are bounded: `bound_box_lifetime` for the
# SDK's BoxOptions, `with_bounded_lifetime` for a case that hand-builds the
# REST body instead.
E2E_AUTO_STOP_SECONDS = 300
E2E_AUTO_DELETE_SECONDS = 600


def bound_box_lifetime(options) -> None:
    """Fill in this suite's auto_stop/auto_delete on BoxOptions, in place.

    Applied to every `rt.create` by the tracking runtime below. A case that
    builds its own REST body instead — to inspect response headers, or to send
    a shape the SDK would refuse — must go through `with_bounded_lifetime`,
    which is the same policy for the same reason.

    Boxes created by the polyglot drivers (`apps/e2e/sdks/`) and the CLI pass
    through neither; `apps/e2e/sweep.py` is what reclaims those.
    """
    if getattr(options, "auto_stop", None) is None:
        options.auto_stop = E2E_AUTO_STOP_SECONDS
    if getattr(options, "auto_delete", None) is None:
        options.auto_delete = E2E_AUTO_DELETE_SECONDS


def with_bounded_lifetime(body: dict) -> dict:
    """Return a hand-built create body carrying this suite's lifetime.

    Anything the caller set explicitly wins — a case testing a rejected
    auto_stop keeps the value under test.
    """
    return {
        "auto_stop": E2E_AUTO_STOP_SECONDS,
        "auto_delete": E2E_AUTO_DELETE_SECONDS,
        **body,
    }


class _TrackingRuntime:
    """Wraps a REST Boxlite runtime so we can intercept .create() and
    record the box ids per test. Other methods pass through unchanged
    via __getattr__. Designed to be transparent — any failure inside the
    tracking layer must not mask the underlying runtime behaviour."""

    def __init__(self, inner):
        object.__setattr__(self, "_inner", inner)
        # Per-test bucket of (box_id, created_at_monotonic). Reset by
        # the autouse fixture before each test.
        object.__setattr__(self, "_created", [])

    async def create(self, *args, **kwargs):
        # Loud rather than tolerant: a create this wrapper cannot find the
        # options of is a create whose box would have no bounded lifetime,
        # and that failure has to surface here instead of as an exhausted
        # org quota three runs later.
        options = kwargs["options"] if "options" in kwargs else (args[0] if args else None)
        if options is None:
            raise TypeError(
                "rt.create() was called with no BoxOptions; the e2e suite's "
                "lifetime bound has nothing to apply (see bound_box_lifetime)"
            )
        bound_box_lifetime(options)
        box = await self._inner.create(*args, **kwargs)
        try:
            self._created.append((box.id, time.monotonic()))
        except Exception:
            pass  # never mask the real return
        return box

    def __getattr__(self, name):
        return getattr(self._inner, name)


@pytest_asyncio.fixture(scope="session")
async def rt():
    """REST-mode Boxlite runtime against the local API, wrapped in a
    tracking shim so the autouse fixture can verify each box reached
    the runner."""
    try:
        ctx = auth_context()
    except RuntimeError as exc:
        pytest.exit(str(exc), returncode=2)
    opts = boxlite.BoxliteRestOptions(
        url=ctx.url,
        credential=boxlite.ApiKeyCredential(ctx.token),
        path_prefix=ctx.path_prefix,
    )
    runtime = boxlite.Boxlite.rest(opts)
    tracking = _TrackingRuntime(runtime)
    yield tracking
    if hasattr(runtime, "close"):
        try:
            close = runtime.close()
            import inspect
            if inspect.isawaitable(close):
                await close
        except Exception:
            pass


@pytest_asyncio.fixture(autouse=True)
async def verify_runner_saw_all_boxes(rt):
    """Per-test path-bypass guard.

    Before each test runs, snapshot the runner journal timestamp and
    reset the tracking runtime's per-test bucket. After the test,
    every box id created via `rt.create` MUST appear in the runner
    journal — if not, the SDK silently bypassed the API → Runner
    chain (e.g. degraded to local FFI, or the runner-side journal
    write broke). Tests that don't create any boxes are unaffected.

    Set ``BOXLITE_E2E_SKIP_PATH_VERIFY=1`` to bypass this check entirely.
    Intended for cloud-CI runs where the runner journal lives on a
    remote EC2 instance and isn't reachable from ``journalctl`` on the
    pytest host.
    """
    if os.environ.get("BOXLITE_E2E_SKIP_PATH_VERIFY", "").lower() in ("1", "true", "yes", "on"):
        yield
        return

    since = runner_journal_seek()
    object.__setattr__(rt, "_created", [])

    yield

    # Give the runner a brief window to flush its log buffer. The
    # CREATE_BOX journal entry is written as the job completes —
    # if we check immediately we can race the journald write.
    created = list(rt._created)
    if not created:
        return

    deadline = time.time() + 5.0
    missing = []
    while True:
        missing = [bid for bid, _ in created
                   if runner_hits_for_box(since, bid) < 1]
        if not missing or time.time() > deadline:
            break
        await asyncio.sleep(0.3)

    assert not missing, (
        f"box(es) created in this test never reached the runner journal: "
        f"{missing}. Either the SDK degraded to local FFI, the API did not "
        f"forward to the runner, or journalctl access broke. See "
        f"apps/e2e/README.md for the chain spec."
    )


@pytest.fixture(scope="session")
def e2e_auth():
    return auth_context()


@pytest.fixture(scope="session")
def e2e_credentials_path() -> Path:
    return credentials_path()


@pytest.fixture(scope="session")
def image() -> str:
    return DEFAULT_IMAGE


@pytest_asyncio.fixture
async def box(rt, image):
    """Create a box per test, auto-removed on teardown."""
    b = await rt.create(boxlite.BoxOptions(image=image, auto_remove=True))
    yield b
    try:
        await rt.remove(b.id, force=True)
    except Exception:
        pass


# ─── helpers shared across cases ────────────────────────────────────────────

async def collect_stream(stream) -> str:
    if stream is None:
        return ""
    chunks: list[str] = []
    async for ch in stream:
        chunks.append(ch.decode("utf-8", "replace") if isinstance(ch, bytes) else str(ch))
    return "".join(chunks)


async def drain(ex) -> tuple[str, str]:
    """Drain stdout + stderr concurrently — required for REST exec."""
    import asyncio
    out_t = asyncio.create_task(collect_stream(ex.stdout()))
    err_t = asyncio.create_task(collect_stream(ex.stderr()))
    return await asyncio.gather(out_t, err_t)


def stdout_line_count(s: str) -> int:
    return len([ln for ln in s.splitlines() if ln])
