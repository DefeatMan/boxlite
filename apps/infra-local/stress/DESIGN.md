# `stress/` — design

A layered rewrite of `apps/infra-local/stress.py` (1963 lines, one module) into a
package whose layers can be read, tested and extended one at a time.

The behaviour under test does not change. What changes is who owns what, so that
adding an operation, swapping the truth store, or running on a different machine
stops being a diff to a 2000-line file.

> `stress.py` was never committed to this repository — it existed only as a
> working file, and this package replaced it. The `stress.py:NNN` citations below
> therefore cannot be opened here; they are kept as the record of what each seam
> in section 3 was extracted from, not as references a reader can follow.

## 1. What is wrong with the single module

`stress.py` grew by accretion and now mixes four altitudes in one class.
`StressRun` (`stress.py:771`) simultaneously:

- **is the transport** — builds URLs, classifies HTTP status codes
  (`op_create_box` treats `408` as "the API's start-wait elapsed", `stress.py:839`);
- **is the domain** — owns box records, runner placement, drain bookkeeping;
- **is the operation set** — every operation is a hardwired `op_*` method, and the
  worker's dispatch table is a literal written in the loop (`_worker`, `stress.py:1129`);
- **is the verdict and the renderer** — `final_sweep`, three `_render_*` methods
  and `report()` all read private state directly (`stress.py:1295-1521`).

Three concrete consequences, all hit during real runs:

1. **Operations cannot be added without editing the class.** A new operation means
   a method, an entry in `OP_WEIGHTS` (`stress.py:138`), an entry in the dispatch
   dict, and often a new `--weights` name — four edits in three places.
2. **Persistence is welded to `psql`.** `TruthStore` (`stress.py:306`) is fine, but
   `Psql` (`stress.py:273`) is a hard prerequisite (`main()` exits 2 without it,
   `stress.py:1949`), and the newer control-plane queries — job tally, row purge —
   went into `StressRun` itself (`stress.py:1590`, `stress.py:1611`) because there
   was no persistence seam to put them behind.
3. **The machine is assumed, not checked.** The run that produced this document
   spent ten minutes discovering that runner homes were cold and that registry
   credentials never reached the spawned runners (`RunnerFleet._spawn` forwards
   `os.environ` only, `stress.py:482`), while `blclient.NewClient` reads
   `GHCR_USERNAME` / `DOCKERHUB_USERNAME`
   (`apps/runner/cmd/runner/main.go:109-117`).

## 2. Prior art

**In this repository — `compose/` is the pattern to mirror.** It is the same kind
of program (drives infrastructure, one CLI, no framework) and it is already split
the way this document proposes:

| `compose` module | Role | The equivalent here |
|---|---|---|
| `config.py:72` `InfraConfig` | one source of truth for paths/ports/credentials | `stress/config.py` `Settings` |
| `services.py:33` `ServiceSpec` + `services.py:506` `SERVICES` | **declarative registry** — adding a service is one spec plus one dict entry | `stress/ops/` registry |
| `orchestrator.py:77` `build_box_options` | pure transform, spec → SDK options | `ops` build requests, never issue them |
| `native.py:227` `_components` | per-component behaviour behind one uniform record | `stress/domain/` |
| `doctor.py:1-8` | preflight checks that return messages, run before any mutation | `stress/doctor.py` |
| `__main__.py` | thin CLI that only dispatches | `stress/__main__.py` |

The `ServiceSpec`/`SERVICES` pair is the important precedent: in `compose`, adding
an L1 service is a data change. Adding a stress operation should be the same.

**Outside this repository** (patterns, not code to copy):

- **Jepsen** splits a run into *generator* (what to do next), *client* (apply one
  operation), *nemesis* (fault injection) and *checker* (verdict over the
  history). Its central discipline — the checker never shares state with the
  client, it only reads the recorded history — is why its verdicts are credible.
  This design adopts the same split: `ops/` apply, `run/sweep.py` judges, and the
  only channel between them is the truth store plus the recorded outcomes.
- **locust** registers weighted tasks through a decorator on a class, so a task
  set is discovered rather than enumerated. That is the shape used for
  `@register_op(name, weight=…)`.
- **FoundationDB's simulation workloads** keep fault injection as a first-class
  workload rather than an out-of-band script; `ops/faults.py` follows that — a
  crash is an operation with an outcome, not a side channel.

## 3. Layers

Imports may only point **downward**. Nothing below layer 3 knows what an
"operation" is; nothing in `ops/` knows what HTTP or SQL is.

```
5  cli/report     __main__.py · report/console.py · report/summary.py
4  run            run/driver.py · run/sweep.py · run/teardown.py · run/context.py
3  ops            ops/base.py (protocol + registry) · ops/builtin.py · ops/faults.py
2  domain         domain/runner.py · domain/box.py · domain/drain.py
1  store          store/truth.py (protocol) · store/postgres.py · store/sqlite.py · store/ledger.py
0  clients        clients/http.py · clients/psql.py   +   config.py · console.py · errors.py
```

Why these seams and not others:

- **clients vs domain** — `Api` already classifies transport failure as data
  (`status == 0`, `stress.py:188-196`); that judgement belongs with the transport,
  and the domain should never see a socket error.
- **domain vs ops** — `RunnerFleet` (`stress.py:407`) is already a proper facade:
  launch/kill/restart/shutdown with private helpers. `BoxRecord` is not — box
  behaviour lives in `StressRun`. Layer 2 gives boxes the same treatment, so an
  operation reads as intent (`box.write(value)`), not as URL assembly.
- **ops vs run** — the driver should choose *which* operation and *when*, never
  *how*. Today `_worker` does both.
- **run vs report** — the verdict is computed from the truth store and the
  recorded outcomes; rendering only formats what the sweep produced.

## 4. The operation seam

```python
# stress/ops/base.py
class Outcome(StrEnum):
    OK = "ok"; SKIP = "skip"; ERROR = "error"
    MISMATCH = "mismatch"; UNCERTAIN = "uncertain"

@dataclass(frozen=True)
class Result:
    outcome: Outcome
    detail: str = ""

class Op(Protocol):
    name: str
    default_weight: int
    async def run(self, ctx: RunContext) -> Result: ...
```

Registration is a decorator, and the weight is the op's own default rather than a
constant maintained elsewhere:

```python
# stress/ops/builtin.py
@register_op("write_box", weight=5)
class WriteBox:
    async def run(self, ctx: RunContext) -> Result:
        box = ctx.boxes.pick(running_only=True)
        ...
```

Three properties this buys:

1. `--weights write_box=0` keeps working, but the name list comes from the
   registry, so an unknown name is rejected against real ops instead of a literal
   dict (`parse_weights`, `stress.py:1758`).
2. **Custom operations need no edit to the package**: `--ops-module my_ops`
   imports the module, its decorators register, and the driver picks them up.
   This is the "op 可自定义添加" requirement, and it is why the registry is keyed
   by name rather than by import order.
3. Faults become ordinary ops. `kill_runner` and `restart_runner` are already
   recorded in the same stats table as everything else (`stress.py:1246`,
   `stress.py:1053`); making them registered ops removes the parallel
   `_chaos_loop` scheduling path in favour of one weighted generator plus an
   explicit interval for the fault op.

`RunContext` (layer 4) is the only thing an op sees: settings, the fleet, the box
registry, the truth store, the RNG, and the clock. It is a facade over the layers
below, so an op cannot reach the transport by accident.

## 5. Persistence

Two responsibilities are conflated today and are split here:

```python
# stress/store/truth.py — the ground truth this test compares against
class TruthStore(Protocol):
    def setup(self) -> None: ...
    def record(self, box_id: str, value: str, *, certain: bool) -> None: ...
    def fetch(self, box_id: str) -> TruthRow | None: ...
    def fetch_all(self) -> dict[str, TruthRow]: ...
    def drop_run(self) -> None: ...
```

- `store/postgres.py` — today's behaviour, `stress.truth` in the control plane's
  own database, reached through `psql` on stdin (the `:'name'` quoting reason in
  `stress.py:274-279` moves with it).
- `store/sqlite.py` — same protocol, a file under the run's log directory, no
  external binary. This is what makes a machine without `psql` able to run the
  harness; the postgres backend stays the default when it is available because
  keeping truth in the same database as the control plane is what makes the
  comparison meaningful for a human debugging afterwards.

```python
# stress/store/ledger.py — reading and cleaning the CONTROL PLANE's own rows
class ControlPlaneLedger:
    def job_tally(self, run_id) -> list[JobCount]: ...
    def count_run_rows(self, run_id) -> RowCounts: ...
    def purge_run_rows(self, run_id) -> None: ...
```

This is deliberately *not* the truth store: it reads the system under test rather
than the test's own bookkeeping, it is always SQL (there is no API for it), and it
is only used by teardown and the report. Keeping them apart is what lets the
sqlite backend exist at all — the ledger still needs Postgres, but only for
cleanup, so a machine without `psql` degrades to "cannot sweep leftover rows"
instead of "cannot run".

## 6. One command on any machine

`python -m stress` is the whole entry point, and `stress/doctor.py` runs before
any mutation so the facts that decide a run are visible up front rather than
discovered ten minutes in. `preflight` is six checks; each either passes, warns
and degrades, or fails with the command that fixes it:

| Check | Failure it prevents | Doctor's action |
|---|---|---|
| control plane healthy | `ECONNREFUSED` mid-run | `make up` when `--start-stack`, else fail naming the URL |
| runner binary present | exit late, after setup | fail with `make up` / `--runner-bin` |
| `psql` present | exit 2 | warn, and fall back to the sqlite truth store |
| registry credentials | 10-minute anonymous pulls, `docker.io` rate-limit errors | resolve via `compose._local_arm64`, warn when none |
| archive store configured | drain migrates nothing | warn — box migration cannot work without it |
| runner homes warm | first box per home waits 5-10 min for a cold pull | warn, naming the cold homes |

Beyond `make up` under an explicit `--start-stack`, it reports rather than
repairs: pre-pulling images or building the binary would be a mutation nobody
asked for, which is exactly what a preflight should not do.

Nothing in the package hardcodes a path or a port: `Settings` derives everything
from `InfraConfig` (`compose/config.py:72`) and CLI flags, and homes come from
`worktree_home` (`compose/config.py:59`) so two checkouts never share a flock.

## 7. What the correctness suite has to prove

`stress/tests/` is the gate, and it is deliberately *not* a differential run
against `stress.py`. Comparing two implementations would only show that they
agree; what has to be established is that this one is right — above all that it
can still fail. A consistency checker that never reports a mismatch is
indistinguishable from a broken one, so the suite injects a divergence and
requires it to surface as `MISMATCH`, `INCONSISTENT`, and exit code 1.

## 8. Out of scope

- No change to what is tested or to the consistency rules — the read-under-lock
  discipline (`stress.py:916-926`) and the read-back-before-record rule
  (`stress.py:891-897`) move verbatim, comments included.
- No product changes to boxlite or the control plane.
- No new dependencies: standard library only, as today.
