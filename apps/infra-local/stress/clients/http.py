"""The control-plane HTTP surface.

Layer 0: this module knows about requests, responses and failure *shapes*. It
knows nothing about boxes, runners or operations — everything above it receives
a `Response` and decides what that means for the thing it was doing.
"""

from __future__ import annotations

import json
import urllib.error
import urllib.parse
import urllib.request
from dataclasses import dataclass

from ..errors import StressError


@dataclass(frozen=True)
class Response:
    """An HTTP outcome. `status == 0` means the transport itself failed — the
    normal shape of "the runner died mid-request", which every caller has to
    classify rather than crash on."""

    status: int
    body: bytes

    @property
    def ok(self) -> bool:
        return 200 <= self.status < 300

    def json(self) -> dict | list | None:
        if not self.body:
            return None
        try:
            return json.loads(self.body)
        except json.JSONDecodeError:
            return None

    def message(self) -> str:
        payload = self.json()
        if isinstance(payload, dict) and payload.get("message"):
            return str(payload["message"])
        return self.body[:200].decode("utf-8", "replace")


class Api:
    """One authenticated control plane, addressed with one admin API key.

    Blocking on purpose (urllib): callers hop it onto a thread with
    `asyncio.to_thread` so the harness stays dependency-free.
    """

    def __init__(
        self, base_url: str, token: str, *, prefix: str = "", timeout: int = 30
    ) -> None:
        self.base_url = base_url.rstrip("/")
        self.token = token
        self.prefix = prefix
        self.timeout = timeout

    def v1(self, route: str, **query: str) -> str:
        # `route`, not `path`: the files endpoints pass a `path=` query
        # parameter, which would collide with the positional argument's name.
        segment = f"/{self.prefix}" if self.prefix else ""
        suffix = f"?{urllib.parse.urlencode(query)}" if query else ""
        return f"/v1{segment}/{route.lstrip('/')}{suffix}"

    def request(
        self,
        method: str,
        path: str,
        *,
        body: bytes | dict | list | None = None,
        content_type: str | None = None,
        timeout: int | None = None,
    ) -> Response:
        headers = {"Authorization": f"Bearer {self.token}"}
        payload: bytes | None
        if isinstance(body, (dict, list)):
            payload = json.dumps(body).encode()
            headers["Content-Type"] = "application/json"
        else:
            payload = body
            if content_type:
                headers["Content-Type"] = content_type
        request = urllib.request.Request(
            self.base_url + path, method=method, headers=headers, data=payload
        )
        try:
            with urllib.request.urlopen(request, timeout=timeout or self.timeout) as response:
                return Response(response.status, response.read())
        except urllib.error.HTTPError as exc:
            return Response(exc.code, exc.read())
        except Exception as exc:  # noqa: BLE001 — URLError, socket.timeout, http.client
            # Deliberately broad: a runner dying mid-request surfaces as any of
            # a dozen transport errors, and every one of them is data this
            # harness classifies rather than a crash.
            return Response(0, f"{type(exc).__name__}: {exc}".encode())

    def require(self, response: Response, what: str) -> dict | list | None:
        """For setup calls only — the ones whose failure invalidates the run."""
        if not response.ok:
            raise StressError(f"{what} failed (HTTP {response.status}): {response.message()}")
        return response.json()
