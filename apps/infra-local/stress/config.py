"""Everything a run needs to know before it starts, resolved once.

`stress.py` carries this as one 45-field `Settings` record, which is why its
functions take the whole thing just to read two fields. Here the settings are
grouped by *who consumes them*: the fleet never sees box sizing, the load
generator never sees credentials, and a change to teardown policy cannot touch
the shape of anything else.

Values come from three places, in this order: an explicit CLI flag, the
environment, then `InfraConfig` — the same source `compose` uses, so the harness
and the stack it drives can never disagree about a port or a password.
"""

from __future__ import annotations

import os
import re
from dataclasses import dataclass
from pathlib import Path

from compose.config import InfraConfig, worktree_home

from .clients.psql import PgTarget

DEFAULT_REGION = "us"
DEFAULT_ADMIN_KEY = "local-dev-admin-key"
RUNNER_HOME_LEAF = "s"           # -> ~/.bl/<worktree-hash>/s<index>
RUN_ID_RE = re.compile(r"^[A-Za-z0-9_.:-]+$")


@dataclass(frozen=True)
class RegistryAuth:
    """Credentials the spawned runners need for image pulls.

    `stress.py` forwards `os.environ` and nothing else, so a developer whose
    ghcr token comes from `gh auth token` (not an env var) silently gets
    anonymous pulls: minutes per layer, and docker.io rate-limit failures. The
    runner reads exactly these four names — `apps/runner/cmd/runner/config/
    config.go:61-64` — so they are resolved here and injected explicitly.
    """

    ghcr_user: str = ""
    ghcr_token: str = ""
    dockerhub_user: str = ""
    dockerhub_token: str = ""

    def env(self) -> dict[str, str]:
        pairs = {
            "GHCR_USERNAME": self.ghcr_user,
            "GHCR_TOKEN": self.ghcr_token,
            "DOCKERHUB_USERNAME": self.dockerhub_user,
            "DOCKERHUB_TOKEN": self.dockerhub_token,
        }
        return {k: v for k, v in pairs.items() if v}

    def describe(self) -> str:
        hosts = []
        if self.ghcr_user and self.ghcr_token:
            hosts.append("ghcr.io")
        if self.dockerhub_user and self.dockerhub_token:
            hosts.append("docker.io")
        return ", ".join(hosts) or "none (anonymous pulls)"


@dataclass(frozen=True)
class ArchiveStore:
    """Object storage for migration archives.

    A drained runner exports each box as an archive, so without this the
    EXPORT_BOX job fails with "migration archive store is not configured", no
    box ever moves, and the runner never decommissions.
    """

    endpoint: str
    bucket: str
    user: str
    password: str

    def env(self) -> dict[str, str]:
        return {
            "AWS_ENDPOINT_URL": self.endpoint,
            "AWS_ACCESS_KEY_ID": self.user,
            "AWS_SECRET_ACCESS_KEY": self.password,
            "AWS_DEFAULT_BUCKET": self.bucket,
        }


@dataclass(frozen=True)
class ControlPlane:
    api_url: str
    admin_key: str
    region: str


@dataclass(frozen=True)
class FleetSpec:
    """The runners this run owns — never the ones `make up` owns."""

    runner_bin: Path
    logs_dir: Path
    repo_root: Path
    initial: int
    maximum: int
    port_base: int
    ready_timeout: float
    registry: RegistryAuth
    archive_store: ArchiveStore | None

    def home(self, index: int) -> Path:
        """Homes are per-index and persistent: a fresh home re-pulls the box
        base image, by far the slowest thing in the loop."""
        return worktree_home(self.repo_root, f"{RUNNER_HOME_LEAF}{index}")


@dataclass(frozen=True)
class BoxSpec:
    image: str
    cpus: int
    memory_mib: int
    disk_gb: int
    file_path: str
    timeout: float


@dataclass(frozen=True)
class LoadSpec:
    duration: float
    workers: int
    think_time: float
    weights: dict[str, int]


@dataclass(frozen=True)
class FaultSpec:
    chaos: bool
    kill_interval: float
    restart_window: tuple[float, float] | None
    min_alive: int
    drain_after: float
    park_on_drain: bool


@dataclass(frozen=True)
class TeardownSpec:
    sweep_restart: bool
    keep_boxes: bool
    keep_runners: bool
    drop_truth: bool


@dataclass(frozen=True)
class Settings:
    run_id: str
    control_plane: ControlPlane
    fleet: FleetSpec
    box: BoxSpec
    load: LoadSpec
    faults: FaultSpec
    teardown: TeardownSpec
    postgres: PgTarget
    json_out: Path | None


def parse_restart_window(raw: str) -> tuple[float, float] | None:
    """`MIN:MAX` -> the delay range between a crash and its restart.

    A single number means an exact delay; `0`/`off` leaves crashed runners dead,
    which exercises the control plane's own recovery instead of the runner's.
    """
    text = raw.strip().lower()
    if text in ("", "0", "off", "none"):
        return None
    low, _, high = text.partition(":")
    try:
        window = (float(low), float(high or low))
    except ValueError:
        raise SystemExit(f"--restart-after-kill: expected MIN:MAX seconds, got {raw!r}")
    if window[0] < 0 or window[1] < window[0]:
        raise SystemExit(f"--restart-after-kill: need 0 <= MIN <= MAX, got {raw!r}")
    return window


def parse_weights(raw: str, defaults: dict[str, int]) -> dict[str, int]:
    """`--weights read_box=10,write_box=0` against the *registered* op names.

    `defaults` comes from the op registry rather than a module constant, so a
    custom op loaded with `--ops-module` can be weighted like any built-in and a
    typo is rejected against what actually exists.
    """
    weights = dict(defaults)
    for entry in filter(None, (part.strip() for part in raw.split(","))):
        name, _, value = entry.partition("=")
        if name not in defaults or not value.isdigit():
            raise SystemExit(
                f"--weights: bad entry {entry!r}; known ops: {', '.join(sorted(defaults))}"
            )
        weights[name] = int(value)
    # An empty registry is a legitimate state while the package is still being
    # assembled; only a registry that exists and was weighted to nothing is an
    # error worth stopping for.
    if defaults and not any(weights.values()):
        raise SystemExit("--weights: at least one operation must have a non-zero weight")
    return weights


def read_admin_key(repo_root: Path) -> str:
    """`apps/api/.env` is where `compose up` seeds ADMIN_API_KEY."""
    env_file = repo_root / "apps" / "api" / ".env"
    if env_file.exists():
        for line in env_file.read_text().splitlines():
            if line.startswith("ADMIN_API_KEY="):
                return line.split("=", 1)[1].strip().strip("\"'")
    return DEFAULT_ADMIN_KEY


def resolve_registry_auth() -> RegistryAuth:
    """Ask `compose` for the credentials it already knows how to find.

    Resolution covers explicit env vars, the GitHub CLI token and Docker's
    credential store, so a machine that can `docker pull` today can run this
    harness without extra setup — the portability requirement.
    """
    from compose import _local_arm64 as creds

    ghcr_user, ghcr_token = creds.ghcr_creds()
    hub_user, hub_token = creds.dockerhub_creds()
    return RegistryAuth(
        ghcr_user=ghcr_user or "",
        ghcr_token=ghcr_token or "",
        dockerhub_user=hub_user or "",
        dockerhub_token=hub_token or "",
    )


def default_run_id() -> str:
    """Short, unique per process, and safe in a table name and a runner name."""
    import time

    return f"{int(time.time()) % 100000:05d}{os.getpid() % 1000:03d}"
