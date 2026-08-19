"""`python -m stress` — argument parsing and dispatch, nothing else.

Mirrors `compose/__main__.py`: the CLI resolves configuration and hands it to a
layer that does the work, so a flag can be added without touching the run.

Four actions: `run` drives a full run, `config` resolves and prints everything a
run would use, `ops` lists the registry, `doctor` stops after the preflight.
`config` and `doctor` exist because every portability failure this harness has
hit — a cold runner home, credentials that never reached the spawned process, a
stack that was not up — was a configuration fact nobody could see before the run
started.
"""

from __future__ import annotations

import argparse
import asyncio
import os
import sys
from pathlib import Path

from compose.config import InfraConfig

from .clients.psql import PgTarget, Psql
from .config import (
    DEFAULT_REGION,
    RUN_ID_RE,
    ArchiveStore,
    BoxSpec,
    ControlPlane,
    FaultSpec,
    FleetSpec,
    LoadSpec,
    Settings,
    TeardownSpec,
    default_run_id,
    parse_restart_window,
    parse_weights,
    read_admin_key,
    resolve_registry_auth,
)
from .console import BOLD, RESET, err, log
from .doctor import preflight
from .errors import StressError
from .ops import REGISTRY
from .report.console import EXIT_NO_EVIDENCE
from .run.session import run_session


def parse_args(argv: list[str]) -> argparse.Namespace:
    parser = argparse.ArgumentParser(prog="python -m stress", description=__doc__)
    parser.add_argument("action", nargs="?", default="run",
                        choices=["run", "config", "ops", "doctor"],
                        help="run: drive a full stress run; config: print the resolved "
                             "settings; ops: list registered operations; doctor: preflight only")
    parser.add_argument("--start-stack", action="store_true",
                        help="run `make up` when the control plane is down")

    load = parser.add_argument_group("load")
    load.add_argument("--duration", type=float, default=180, help="seconds of load")
    load.add_argument("--workers", type=int, default=4, help="concurrent operation workers")
    load.add_argument("--think-time", type=float, default=2.0,
                      help="max seconds a worker idles between operations")
    load.add_argument("--weights", default="", help="op weights, e.g. read_box=10,write_box=6")
    load.add_argument("--ops-module", default="",
                      help="dotted module whose @register_op classes are added to the registry")

    fleet = parser.add_argument_group("fleet")
    fleet.add_argument("--runners", type=int, default=3, help="runners to start before the load")
    fleet.add_argument("--max-runners", type=int, default=5, help="cap for the start-runner op")
    fleet.add_argument("--runner-port-base", type=int, default=3020)
    fleet.add_argument("--runner-ready-timeout", type=float, default=120)
    fleet.add_argument("--runner-bin", default="",
                       help="boxlite-runner binary (default <repo>/.apps-local/bin/boxlite-runner)")
    fleet.add_argument("--no-archive-store", action="store_true",
                       help="start runners without S3 config (box migration then cannot work)")
    fleet.add_argument("--s3-endpoint", default="")
    fleet.add_argument("--s3-bucket", default="",
                       help="default: InfraConfig.minio_bucket, the bucket minio-init creates")

    faults = parser.add_argument_group("faults")
    faults.add_argument("--no-chaos", action="store_true", help="do not kill runners")
    faults.add_argument("--kill-interval", type=float, default=45)
    faults.add_argument("--restart-after-kill", default="15:90",
                        help="restart a killed runner after MIN:MAX seconds on a new port; "
                             "0 leaves it dead")
    faults.add_argument("--min-alive", type=int, default=1)
    faults.add_argument("--drain-after", type=float, default=0)
    faults.add_argument("--no-park-on-drain", action="store_true")

    box = parser.add_argument_group("box")
    box.add_argument("--image", default="base")
    box.add_argument("--cpus", type=int, default=1)
    box.add_argument("--memory-mib", type=int, default=512)
    box.add_argument("--disk-gb", type=int, default=2)
    box.add_argument("--box-path", default="/root/output/stress-value")
    box.add_argument("--box-timeout", type=float, default=600)

    teardown = parser.add_argument_group("teardown")
    teardown.add_argument("--no-sweep-restart", action="store_true")
    teardown.add_argument("--keep-boxes", action="store_true")
    teardown.add_argument("--keep-runners", action="store_true")
    teardown.add_argument("--drop-truth", action="store_true")

    plane = parser.add_argument_group("control plane")
    plane.add_argument("--api-url", default="")
    plane.add_argument("--admin-key", default="")
    plane.add_argument("--region", default=DEFAULT_REGION)
    plane.add_argument("--pg-host", default="127.0.0.1")
    plane.add_argument("--pg-port", type=int, default=25432)
    plane.add_argument("--run-id", default="")
    plane.add_argument("--json-out", default="")
    return parser.parse_args(argv)


def build_settings(args: argparse.Namespace) -> Settings:
    config = InfraConfig.load()
    repo_root = config.repo_root
    run_id = args.run_id or default_run_id()
    if not RUN_ID_RE.match(run_id):
        raise SystemExit(f"--run-id must match {RUN_ID_RE.pattern}")

    if args.ops_module:
        added = REGISTRY.load_module(args.ops_module)
        log(f"{args.ops_module} added op(s): {', '.join(added) or 'none'}")

    api_port = os.environ.get("BOXLITE_LOCAL_API_PORT", "3001")
    archive = None if args.no_archive_store else ArchiveStore(
        endpoint=args.s3_endpoint or f"http://127.0.0.1:{config.minio_host_port}",
        bucket=args.s3_bucket or config.minio_bucket,
        user=config.minio_user,
        password=config.minio_password,
    )
    return Settings(
        run_id=run_id,
        control_plane=ControlPlane(
            api_url=args.api_url or f"http://localhost:{api_port}/api",
            admin_key=args.admin_key or read_admin_key(repo_root),
            region=args.region,
        ),
        fleet=FleetSpec(
            runner_bin=Path(args.runner_bin).expanduser() if args.runner_bin
            else repo_root / ".apps-local" / "bin" / "boxlite-runner",
            logs_dir=repo_root / ".apps-local" / "logs",
            repo_root=repo_root,
            initial=args.runners,
            maximum=max(args.max_runners, args.runners),
            port_base=args.runner_port_base,
            ready_timeout=args.runner_ready_timeout,
            registry=resolve_registry_auth(),
            archive_store=archive,
        ),
        box=BoxSpec(
            image=args.image,
            cpus=args.cpus,
            memory_mib=args.memory_mib,
            disk_gb=args.disk_gb,
            file_path=args.box_path,
            timeout=args.box_timeout,
        ),
        load=LoadSpec(
            duration=args.duration,
            workers=args.workers,
            think_time=args.think_time,
            weights=parse_weights(args.weights, REGISTRY.default_weights()),
        ),
        faults=FaultSpec(
            chaos=not args.no_chaos,
            kill_interval=args.kill_interval,
            restart_window=parse_restart_window(args.restart_after_kill),
            min_alive=args.min_alive,
            drain_after=args.drain_after,
            park_on_drain=not args.no_park_on_drain,
        ),
        teardown=TeardownSpec(
            sweep_restart=not args.no_sweep_restart,
            keep_boxes=args.keep_boxes,
            keep_runners=args.keep_runners,
            drop_truth=args.drop_truth,
        ),
        postgres=PgTarget(
            host=args.pg_host,
            port=args.pg_port,
            user=config.pg_user,
            password=config.pg_password,
            database=config.pg_db,
        ),
        json_out=Path(args.json_out).expanduser() if args.json_out else None,
    )


def print_config(settings: Settings) -> None:
    fleet = settings.fleet
    homes = ", ".join(str(fleet.home(i).name) for i in range(1, fleet.initial + 1))
    print(f"{BOLD}run {settings.run_id}{RESET}")
    print(f"  control plane   {settings.control_plane.api_url} (region {settings.control_plane.region})")
    print(f"  postgres        {settings.postgres.dsn()}  psql={'yes' if Psql.available() else 'NO'}")
    print(f"  runner binary   {fleet.runner_bin}"
          f"{'' if fleet.runner_bin.exists() else '   ← MISSING'}")
    print(f"  runner homes    {homes} (under {fleet.home(1).parent})")
    print(f"  registry auth   {fleet.registry.describe()}")
    print(f"  archive store   {fleet.archive_store.endpoint if fleet.archive_store else 'disabled'}")
    print(f"  load            {settings.load.duration:.0f}s · {settings.load.workers} worker(s)")
    print(f"  weights         {settings.load.weights}")
    window = settings.faults.restart_window
    print(f"  faults          chaos={'on' if settings.faults.chaos else 'off'} · "
          f"kill every ~{settings.faults.kill_interval:.0f}s · "
          f"restart {f'{window[0]:.0f}-{window[1]:.0f}s' if window else 'disabled'}")


def print_ops() -> None:
    print(f"{BOLD}registered operations{RESET}")
    for name, weight in REGISTRY.default_weights().items():
        print(f"  {name:<16} default weight {weight}")


def main(argv: list[str]) -> int:
    args = parse_args(argv)
    if args.action == "ops":
        if args.ops_module:
            REGISTRY.load_module(args.ops_module)
        print_ops()
        return 0

    settings = build_settings(args)
    if args.action == "config":
        print_config(settings)
        return 0

    try:
        preflight(settings, may_start_stack=args.start_stack)
    except StressError as exc:
        err(str(exc))
        return EXIT_NO_EVIDENCE
    if args.action == "doctor":
        return 0

    print_config(settings)
    try:
        return asyncio.run(run_session(settings))
    except StressError as exc:
        err(str(exc))
        return EXIT_NO_EVIDENCE


if __name__ == "__main__":
    sys.exit(main(sys.argv[1:]))
