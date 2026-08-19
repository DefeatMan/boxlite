/*
 * Copyright 2026 BoxLite AI
 * SPDX-License-Identifier: AGPL-3.0
 */

import { RatchetJQJob } from '../entities/ratchetjq-job.entity'

/**
 * What one executor reported for a job it ran inline.
 *
 * `status` is a plain string and not RatchetJQJobStatus: it is whatever the
 * executor called the outcome, and the executor is a separate service whose
 * vocabulary this side does not get to narrow. Validating it against the enum
 * belongs where the value enters the job table, not here.
 *
 * A run that raised arrives here too, as an outcome and not as a thrown error:
 * the executor ran the job and the job failed, which is something it knows and
 * this side does not. `syncRun` throws only when the push itself did not land —
 * an unreachable executor, a cancelled call — because those leave the job
 * genuinely unrun and claimable, where a failure has been run and needs
 * recording (`ratchetjq-runner.executor.ts:syncRun`).
 */
export interface RatchetJQSyncRunOutcome {
  status: string
  outParams: Record<string, unknown> | null
  errMsg: string | null
}

/**
 * The push side of the run segment: an executor kind the control plane can hand
 * a job to and wait on (spec §9.1, `Executor(x.executor).Select(x.executorId)`).
 *
 * It is the counterpart of IJobAcceptor, and deliberately built the same way,
 * because the two answer the same shape of question on opposite sides of a job:
 * which implementation serves this name, and does it promise to settle inside one
 * request. Whoever adds a kind of executor reads one vocabulary for both.
 *
 * What differs is the key. An acceptor is chosen by job *type* — one acceptor per
 * kind of work — while an executor is chosen by executor *kind*, since every job
 * type on a runner is pushed the same way and only the transport differs. That is
 * why `executor` here names the kind and not a job type.
 *
 * `syncRun` takes the executor *instance* separately from the job. The job row
 * already carries `executorId`, but passing it explicitly is what keeps this
 * usable from a submission that has no row yet, and it names the one argument a
 * caller could get wrong: a job pushed to the wrong instance of the right kind
 * would be run by a host that does not own it.
 *
 * One executor serves every job of its kind, so an implementation must hold no
 * per-job state in fields.
 *
 * Only the inline form exists, because only it is used: `Exec(sync)` is the one
 * caller, and it is waiting. A pushed form that settles later would arrive as a
 * second interface next to this one rather than as a widening of it — though note
 * the accept side went the other way and collapsed its pair into one
 * (`job-acceptor.ts`), because a promise already says "later" and the two
 * signatures were identical. A second executor form would differ in more than
 * timing, which is why the same argument does not apply here.
 */
export interface ISyncJobExecutor {
  /** The executor kind this serves, matching `ratchetjq_job.executor`. */
  readonly executor: string

  /**
   * Pushes the job and waits for its outcome.
   *
   * `signal` is the caller's deadline for the whole synchronous submission, and
   * honouring it is part of the contract for the same reason it is on the acceptor
   * side (`job-acceptor.ts`, IJobAcceptor): the push is the longest thing a submission waits
   * on, so an implementation that ignores the signal makes the deadline a
   * suggestion. Pass it to whatever the push waits on rather than checking it
   * once. Absent means the caller set no deadline and will wait as long as the
   * job's own `ttlSeconds` allows.
   */
  syncRun(executorId: string, job: RatchetJQJob, signal?: AbortSignal): Promise<RatchetJQSyncRunOutcome>
}
