<!--
Copyright 2026 BoxLite AI
SPDX-License-Identifier: AGPL-3.0
-->

# RatchetJQ job type contract

`job-types.json` lists every RatchetJQ job type the system runs. It is the third
edit that adding a job type requires, and the only one that makes the other two
check each other.

A job type has two independent halves, registered in two languages:

- the **runner** half runs the job — a prototype in
  [`jobs.jobTypes`](../../runner/pkg/ratchetjq/jobs/registry.go), keyed by its own
  `IJob.Type()`
- the **control plane** half decides whether the outcome stands — an entry in
  `RATCHETJQ_JOB_ACCEPTORS`
  ([`ratchetjq.module.ts`](../../api/src/ratchetjq/ratchetjq.module.ts)), keyed by
  its own `IJobAcceptor.type`

Both keys are plain strings that nothing compares, because each side deliberately
declares the name on the implementation rather than in a central enum — that is
what makes an implementation the single source of truth for its own name. The
cost is that a name present on one side and absent on the other is not a build
error anywhere. It is not a runtime error either: a job whose type the runner
cannot build is left to its lease
([`poller.go:dispatch`](../../runner/pkg/ratchetjq/poller.go)), and one with no
acceptor is left to its lease too
([`accept-round.ts:runUnattended`](../../api/src/ratchetjq/common/accept-round.ts)),
so a mistyped name costs the job every round it has and retires it as `timeout`
behind a rollback job — the most expensive way there is to learn about a typo.

This file closes that gap without moving either name. It asserts rather than
generates: each side keeps declaring its own type names, and one test per side
checks its own registry against this list, so drift fails CI on the side that
drifted.

- [`jobs/contract_test.go`](../../runner/pkg/ratchetjq/jobs/contract_test.go)
- [`job-types.contract.spec.ts`](../../api/src/ratchetjq/job-types.contract.spec.ts)

## Adding a job type

Three edits, in any order — the tests fail until all three are done:

1. the runner's prototype list
2. the control plane's acceptor list
3. this file

What it does not check is whether a _particular_ runner instance has been
deployed with the type yet. That is per-instance and mid-rollout it is genuinely
heterogeneous, so it belongs on the runner's healthcheck rather than in a
checked-in list.
