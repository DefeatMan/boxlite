"""Boxes: the thing whose content this test is checking.

`BoxRegistry` is the run's own view of its boxes — never the control plane's.
`BoxService` turns intent ("write this value", "read it back") into API calls,
so an operation never assembles a URL or classifies an HTTP status itself.

The tar helpers live here because the files route *is* the box's content
interface: a value goes in as a one-file tar and comes back as one.
"""

from __future__ import annotations

import asyncio
import io
import random
import tarfile
from dataclasses import dataclass, field

from ..clients.http import Api, Response
from ..config import BoxSpec

BOX_FILE_NAME = "stress-value"


@dataclass
class BoxRecord:
    box_id: str
    name: str
    runner_id: str = ""
    runner_name: str = ""
    nominated_runner: str = ""
    # This run's view, not the control plane's. Starts at `creating` so a box
    # still booting is never picked for a write.
    state: str = "creating"          # creating | running | stopped | gone | ...
    has_truth: bool = False
    # Set when a write reached the box but recording the new value did not: the
    # row is now behind the box's real content while still claiming to be
    # certain, so comparing them would accuse the system of a divergence the
    # harness itself caused. Cleared by the next write that records cleanly.
    truth_stale: bool = False
    migrated_from: str = ""
    migrated_to: str = ""
    lock: asyncio.Lock = field(default_factory=asyncio.Lock)


class BoxRegistry:
    """Every box this run created, and how to pick one to act on."""

    def __init__(self, rng: random.Random) -> None:
        self.rng = rng
        self.boxes: list[BoxRecord] = []
        self._lock = asyncio.Lock()
        self._seq = 0

    async def next_name(self, run_id: str) -> str:
        async with self._lock:
            self._seq += 1
            return f"stress-{run_id}-b{self._seq}"

    async def add(self, record: BoxRecord) -> None:
        async with self._lock:
            self.boxes.append(record)

    def by_id(self, box_id: str) -> BoxRecord | None:
        return next((b for b in self.boxes if b.box_id == box_id), None)

    def on_runner(self, runner_id: str) -> list[BoxRecord]:
        return [b for b in self.boxes if b.runner_id == runner_id]

    def pick(self, *, running_only: bool = False, with_truth: bool = False) -> BoxRecord | None:
        """A locked box is skipped rather than waited on: the point is to keep
        the workers moving across many boxes, not to queue on one."""
        candidates = [
            b for b in self.boxes
            if (not running_only or b.state == "running")
            and (not with_truth or b.has_truth)
            and not b.lock.locked()
        ]
        return self.rng.choice(candidates) if candidates else None


class BoxService:
    """Every box call the run makes, in the box's own vocabulary."""

    def __init__(self, api: Api, spec: BoxSpec, stop: asyncio.Event) -> None:
        self.api = api
        self.spec = spec
        # `stop` is the abort signal, not the end of the load window: waits the
        # final sweep depends on must not be cut short by the load ending.
        self.abort = stop

    async def create(self, name: str) -> tuple[str | None, Response]:
        """Returns the new box id, or None with the response that explains why.

        A 408 is not a failure: it means the API's start-wait elapsed, and the
        box exists under the name we chose — so the id is looked up rather than
        assumed lost.
        """
        body = {
            "name": name,
            "image": self.spec.image,
            "cpus": self.spec.cpus,
            "memory_mib": self.spec.memory_mib,
            # Explicit and small: the API default multiplied by a few dozen live
            # boxes walks straight into the organization's disk quota.
            "disk_size_gb": self.spec.disk_gb,
        }
        response = await asyncio.to_thread(
            self.api.request, "POST", self.api.v1("boxes"),
            body=body, timeout=int(self.spec.timeout),
        )
        if not response.ok and response.status != 408:
            return None, response
        box_id = (response.json() or {}).get("box_id") if response.ok else None
        if box_id:
            return str(box_id), response
        lookup = await asyncio.to_thread(self.api.request, "GET", self.api.v1(f"boxes/{name}"))
        box_id = (lookup.json() or {}).get("box_id") if lookup.ok else None
        return (str(box_id) if box_id else None), response

    async def write(self, box: BoxRecord, value: str) -> Response:
        return await asyncio.to_thread(
            self.api.request, "PUT",
            self.api.v1(f"boxes/{box.box_id}/files", path=self.spec.file_path),
            body=_tar_bytes(BOX_FILE_NAME, value.encode()),
            content_type="application/x-tar",
            timeout=int(self.spec.timeout),
        )

    async def read(self, box: BoxRecord, *, timeout: int | None = None) -> tuple[str | None, Response]:
        """The box's bytes, or None with the response that explains why not."""
        response = await asyncio.to_thread(
            self.api.request, "GET",
            self.api.v1(f"boxes/{box.box_id}/files", path=self.spec.file_path),
            timeout=timeout or int(self.spec.timeout),
        )
        if not response.ok:
            return None, response
        content = _first_file_from_tar(response.body)
        if content is None:
            return None, Response(response.status, b"tar carried no regular file")
        return content.decode("utf-8", "replace"), response

    async def stop(self, box: BoxRecord) -> Response:
        return await asyncio.to_thread(
            self.api.request, "POST", self.api.v1(f"boxes/{box.box_id}/stop"),
            timeout=int(self.spec.timeout),
        )

    async def start(self, box: BoxRecord) -> Response:
        return await asyncio.to_thread(
            self.api.request, "POST", self.api.v1(f"boxes/{box.box_id}/start"),
            timeout=int(self.spec.timeout),
        )

    async def destroy(self, box: BoxRecord, *, timeout: int = 30) -> Response:
        return await asyncio.to_thread(
            self.api.request, "DELETE", self.api.v1(f"boxes/{box.box_id}"), timeout=timeout
        )

    async def status(self, box_id_or_name: str, *, timeout: int | None = None) -> Response:
        return await asyncio.to_thread(
            self.api.request, "GET", self.api.v1(f"boxes/{box_id_or_name}"),
            timeout=timeout or int(self.spec.timeout),
        )

    async def await_running(self, box_id_or_name: str) -> str:
        import time

        deadline = time.monotonic() + self.spec.timeout
        status = "unknown"
        while time.monotonic() < deadline and not self.abort.is_set():
            response = await self.status(box_id_or_name)
            if response.ok:
                status = str((response.json() or {}).get("status") or "unknown")
                if status in ("running", "stopped", "unknown"):
                    return status
            elif response.status == 404:
                return "gone"
            await asyncio.sleep(2)
        return f"timeout({status})"

    async def resolve_assignment(self, box: BoxRecord, fleet) -> None:
        """Placement is the control plane's call — read back where the box
        actually landed so faults can be attributed to the right runner."""
        response = await asyncio.to_thread(
            self.api.request, "GET", f"/runners/by-box/{box.box_id}"
        )
        if not response.ok:
            return
        payload = response.json() or {}
        box.runner_id = str(payload.get("id") or "")
        owner = fleet.by_id(box.runner_id)
        box.runner_name = owner.name if owner else str(payload.get("name") or box.runner_id)


def _tar_bytes(name: str, payload: bytes) -> bytes:
    """One-file tar, the upload shape the runner's file route expects."""
    buffer = io.BytesIO()
    with tarfile.open(fileobj=buffer, mode="w") as archive:
        info = tarfile.TarInfo(name)
        info.size = len(payload)
        info.mode = 0o644
        archive.addfile(info, io.BytesIO(payload))
    return buffer.getvalue()


def _first_file_from_tar(payload: bytes) -> bytes | None:
    try:
        with tarfile.open(fileobj=io.BytesIO(payload), mode="r") as archive:
            for member in archive:
                if member.isfile():
                    handle = archive.extractfile(member)
                    return handle.read() if handle else None
    except tarfile.TarError:
        return None
    return None
