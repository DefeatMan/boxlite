"""The runners this run owns: control-plane rows plus local processes.

Everything that must be unique per runner process lives here — the row (identity
comes from the API key), the TCP port, and the BoxliteRuntime home (each runtime
takes an exclusive flock on its home).

Faults belong here too, because a crash and its recovery are the same subject:
what a SIGKILL means only becomes visible in whether the row comes back.
"""

from __future__ import annotations

import asyncio
import os
import signal
import socket
import subprocess
import time
from dataclasses import dataclass, field
from pathlib import Path

from ..clients.http import Api
from ..config import FleetSpec
from ..console import ok, warn
from ..errors import StressError

# A restarted runner keeps its row but deliberately takes a NEW port, because a
# changed port is what proves the control plane re-learned the endpoint rather
# than keeping the dead one. Restart ports live in their own band so they can
# never collide with a first-start port.
RESTART_PORT_OFFSET = 100
RESTART_READY_GRACE = 30
PORT_PROBE_SPAN = 50


@dataclass
class RunnerProc:
    index: int
    name: str
    token: str
    port: int
    home: Path
    log_path: Path
    runner_id: str = ""
    proc: subprocess.Popen | None = None
    killed: bool = False
    draining: bool = False
    # Drain bookkeeping: draining is a two-part promise — the boxes move, and
    # only then does the row reach DECOMMISSIONED.
    drained_at: float = 0.0
    drained_boxes: list[str] = field(default_factory=list)
    decommissioned_at: float = 0.0
    # Crash bookkeeping. `killed` says "no process right now"; these say what
    # happened around each crash, so a report can tell "never noticed" from
    # "never came back".
    kills: int = 0
    restarts: int = 0
    restart_gaps: list[float] = field(default_factory=list)
    ports_used: list[int] = field(default_factory=list)
    api_url: str = ""
    decommissioned_before_restart: bool = False

    @property
    def alive(self) -> bool:
        return self.proc is not None and self.proc.poll() is None

    @property
    def counts_against_cap(self) -> bool:
        """Alive *or* still starting. A runner mid-launch has no process yet, and
        leaving it out of the tally lets concurrent workers blow past the cap."""
        return not self.killed and (self.proc is None or self.proc.poll() is None)


class RunnerFleet:
    def __init__(self, spec: FleetSpec, api: Api, region: str, run_id: str) -> None:
        self.spec = spec
        self.api = api
        self.region = region
        self.run_id = run_id
        self.runners: list[RunnerProc] = []
        self._lock = asyncio.Lock()
        self._next_index = 1

    # ── views ──────────────────────────────────────────────────────────────
    def alive_runners(self) -> list[RunnerProc]:
        return [r for r in self.runners if r.alive]

    def schedulable(self) -> list[RunnerProc]:
        return [r for r in self.alive_runners() if not r.draining]

    def by_id(self, runner_id: str) -> RunnerProc | None:
        return next((r for r in self.runners if r.runner_id == runner_id), None)

    # ── lifecycle ──────────────────────────────────────────────────────────
    async def launch(self, *, cap: int | None = None) -> RunnerProc | None:
        """Register a row, spawn the process, wait for `ready`.

        Returns None when `cap` is reached — the check and the slot reservation
        share one lock so concurrent workers cannot both squeeze past it.
        """
        async with self._lock:
            if cap is not None and sum(r.counts_against_cap for r in self.runners) >= cap:
                return None
            index = self._next_index
            self._next_index += 1
            port = self._free_port(self.spec.port_base + index)
            runner = RunnerProc(
                index=index,
                name=f"stress-{self.run_id}-{index}",
                token=f"stress-runner-token-{self.run_id}-{index}",
                port=port,
                home=self.spec.home(index),
                log_path=self.spec.logs_dir / f"stress-runner-{index}.log",
            )
            runner.ports_used.append(port)
            self.runners.append(runner)

        try:
            runner.runner_id = await asyncio.to_thread(self._register, runner)
            await asyncio.to_thread(self._spawn, runner)
            await self._wait_ready(runner)
        except StressError:
            # A half-launched runner must not keep holding a cap slot, a port and
            # a home flock; its row is dropped in teardown like any other.
            await self.kill(runner)
            runner.killed = True
            raise
        return runner

    async def restart(self, runner: RunnerProc) -> tuple[str, str]:
        """Bring a SIGKILLed runner back the way a process supervisor would.

        Identity is the API key, not the process and not the port: the restarted
        process reuses the token, so the control plane finds the same row, forces
        it back to READY and overwrites `apiUrl` with what the new process
        reports. The home is reused because that is where the runner's boxes
        live. A DECOMMISSIONED row is the one case that cannot come back — its
        healthchecks are ignored — so it is reported rather than retried.
        """
        row = await self.row(runner)
        if str(row.get("state")) == "decommissioned":
            runner.decommissioned_before_restart = True
            return "skip", f"{runner.name}: row is decommissioned, healthchecks are ignored"

        async with self._lock:
            port = self._free_port(
                self.spec.port_base + RESTART_PORT_OFFSET + runner.index * 10 + runner.restarts
            )
            was_port, runner.port = runner.port, port
            runner.ports_used.append(port)

        crashed_at = time.monotonic()
        await asyncio.to_thread(self._spawn, runner)
        runner.killed = False
        try:
            runner.api_url = await self._await_restarted_endpoint(runner, port)
        except StressError as exc:
            return "error", str(exc)

        runner.restarts += 1
        runner.restart_gaps.append(time.monotonic() - crashed_at)
        return "ok", f"{runner.name} back on :{port} (was :{was_port}), apiUrl {runner.api_url}"

    async def revive_for_teardown(self) -> list[str]:
        """Restart every runner this run killed, so teardown can finish.

        Not politeness: the API refuses to destroy a box while it is `pending`,
        and refuses to delete a runner while any box outside ARCHIVED/DESTROYED
        points at it. Both are cleared only by the runner reporting its job
        outcome, so a permanently dead runner leaves its boxes — and its own row
        — undeletable.
        """
        revived: list[str] = []
        for runner in self.runners:
            if runner.alive or not runner.runner_id:
                continue
            outcome, detail = await self.restart(runner)
            revived.append(f"{outcome}: {detail}")
            (ok if outcome == "ok" else warn)(f"teardown revive {detail}")
        return revived

    async def kill(self, runner: RunnerProc) -> None:
        """SIGKILL — the fault this test injects. No drain, no SIGTERM: the
        control plane finds out only when healthchecks stop arriving."""
        if not runner.alive:
            return
        assert runner.proc is not None
        pid = runner.proc.pid
        async with self._lock:
            try:
                os.killpg(os.getpgid(pid), signal.SIGKILL)
            except OSError as exc:
                warn(f"kill {runner.name} (pid {pid}) failed: {exc}")
                return
            runner.killed = True
            runner.kills += 1
        await asyncio.to_thread(runner.proc.wait)

    async def shutdown(self) -> None:
        for runner in self.alive_runners():
            assert runner.proc is not None
            try:
                os.killpg(os.getpgid(runner.proc.pid), signal.SIGTERM)
            except OSError:
                continue
        deadline = time.monotonic() + 20
        while time.monotonic() < deadline and self.alive_runners():
            await asyncio.sleep(1)
        for runner in self.alive_runners():
            assert runner.proc is not None
            try:
                os.killpg(os.getpgid(runner.proc.pid), signal.SIGKILL)
            except OSError:
                pass

    # ── control-plane view ─────────────────────────────────────────────────
    async def row(self, runner: RunnerProc) -> dict:
        response = await asyncio.to_thread(self.api.request, "GET", "/admin/runners")
        rows = response.json() if response.ok else []
        for candidate in rows or []:
            if isinstance(candidate, dict) and candidate.get("name") == runner.name:
                return candidate
        return {}

    async def states(self) -> dict[str, str]:
        response = await asyncio.to_thread(self.api.request, "GET", "/admin/runners")
        return {
            str(row.get("id")): str(row.get("state"))
            for row in (response.json() or []) if isinstance(row, dict)
        }

    # ── internals ──────────────────────────────────────────────────────────
    def _register(self, runner: RunnerProc) -> str:
        response = self.api.request(
            "POST", "/admin/runners",
            body={
                "name": runner.name,
                "regionId": self.region,
                "apiVersion": "2",
                "apiKey": runner.token,
            },
        )
        payload = self.api.require(response, f"register runner {runner.name}")
        runner_id = (payload or {}).get("id")
        if not runner_id:
            raise StressError(f"register runner {runner.name}: response carried no id")
        return runner_id

    def _spawn(self, runner: RunnerProc) -> None:
        runner.home.mkdir(parents=True, exist_ok=True)
        runner.log_path.parent.mkdir(parents=True, exist_ok=True)
        env = {
            **os.environ,
            "BOXLITE_API_URL": self.api.base_url,
            "BOXLITE_RUNNER_TOKEN": runner.token,
            "API_VERSION": "2",
            "API_PORT": str(runner.port),
            "RUNNER_DOMAIN": "127.0.0.1",
            "BOXLITE_HOME_DIR": str(runner.home),
            "INSECURE_REGISTRIES": "127.0.0.1:25000",
            "AWS_REGION": "us-east-1",
            # Resolved rather than inherited: a developer whose ghcr token comes
            # from `gh auth token` has nothing in the environment, and the runner
            # would fall back to anonymous pulls — minutes per layer, and
            # docker.io rate-limit failures.
            **self.spec.registry.env(),
        }
        if self.spec.archive_store:
            env |= self.spec.archive_store.env()
        with open(runner.log_path, "ab") as logfile:
            runner.proc = subprocess.Popen(
                [str(self.spec.runner_bin)],
                env=env,
                stdout=logfile,
                stderr=subprocess.STDOUT,
                start_new_session=True,  # own process group: SIGKILL takes the tree
            )

    async def _wait_ready(self, runner: RunnerProc) -> None:
        deadline = time.monotonic() + self.spec.ready_timeout
        while time.monotonic() < deadline:
            if not runner.alive:
                raise StressError(f"runner {runner.name} exited early — see {runner.log_path}")
            row = await self.row(runner)
            if row.get("state") == "ready":
                runner.api_url = str(row.get("apiUrl") or "")
                ok(f"runner {runner.name} ready ({runner.runner_id})")
                return
            await asyncio.sleep(2)
        raise StressError(
            f"runner {runner.name} never reached ready in {self.spec.ready_timeout:.0f}s "
            f"— see {runner.log_path}"
        )

    async def _await_restarted_endpoint(self, runner: RunnerProc, port: int) -> str:
        """Wait until the row describes THIS process, not the one that died.

        `state` cannot carry that: a runner killed seconds ago is still `ready`
        until the API's staleness check demotes it, so waiting on state returns
        before the restarted process has sent a single healthcheck — and then
        every field read is the dead process's. The endpoint is the one thing
        only the new process can produce.
        """
        budget = self.spec.ready_timeout + RESTART_READY_GRACE
        deadline = time.monotonic() + budget
        api_url = ""
        while time.monotonic() < deadline:
            if not runner.alive:
                raise StressError(f"runner {runner.name} exited early — see {runner.log_path}")
            row = await self.row(runner)
            api_url = str(row.get("apiUrl") or "")
            if row.get("state") == "ready" and f":{port}" in api_url:
                return api_url
            await asyncio.sleep(2)
        raise StressError(
            f"{runner.name} is up on :{port} but the control plane still records apiUrl "
            f"{api_url or '<none>'} after {budget:.0f}s"
        )

    @staticmethod
    def _free_port(preferred: int) -> int:
        for port in range(preferred, preferred + PORT_PROBE_SPAN):
            with socket.socket(socket.AF_INET, socket.SOCK_STREAM) as probe:
                probe.setsockopt(socket.SOL_SOCKET, socket.SO_REUSEADDR, 1)
                try:
                    probe.bind(("127.0.0.1", port))
                    return port
                except OSError:
                    continue
        raise StressError(f"no free runner port in [{preferred}, {preferred + PORT_PROBE_SPAN})")
