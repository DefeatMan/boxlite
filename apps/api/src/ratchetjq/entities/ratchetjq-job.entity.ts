/*
 * Copyright 2026 BoxLite AI
 * SPDX-License-Identifier: AGPL-3.0
 */

import { Column, CreateDateColumn, Entity, Index, PrimaryGeneratedColumn } from 'typeorm'
import { RatchetJQJobChannel } from '../enums/ratchetjq-job-channel.enum'
import { RatchetJQJobPeriod } from '../enums/ratchetjq-job-period.enum'
import { RatchetJQJobStatus } from '../enums/ratchetjq-job-status.enum'

/**
 * One RatchetJQ job row (spec §2.1).
 *
 * This is the new job service's own table, sitting beside the legacy `job`
 * table rather than replacing it. A row is a unit of work plus everything the
 * scheduler needs to decide when it may next be picked up, so the two forces
 * that advance a job — an executor's own claim and the Scanner's global sweep —
 * both work off this one row and nothing else.
 *
 * Three of the four indexes are "equality prefix, then `pr`, then a time
 * column", which is what lets each claim query take its ordering straight from
 * the index and stop at its LIMIT instead of sorting a matched set. The cost is
 * that the range test on the time column filters within each `pr` group rather
 * than scanning one contiguous span — the right trade for a priority queue,
 * since dequeuing must follow `pr` first.
 */
/**
 * The priority a submission gets when it does not name one.
 *
 * Deliberately not 0. Claims order by `pr ASC` and a negative priority is refused,
 * so 0 is the most urgent value there is — defaulting to it would leave a
 * submitter no way to say "ahead of ordinary work", only ways to say "behind it".
 * Starting in the middle leaves 0–11 above the default and 13 upwards below it,
 * which is the same reason `nice` centres on 0 in a signed range and syslog
 * severities leave room on both sides.
 *
 * The value is shared with RatchetJQJobWriter rather than left to the column
 * default, because every insert names `pr` explicitly and a column default no
 * statement reaches is a default in name only.
 */
export const RATCHETJQ_DEFAULT_PR = 12

/**
 * How much of an executor's error text `errMsg` keeps.
 *
 * An error crossing a service boundary has no natural bound — a wrapped chain, a
 * driver dump, a stack — and the column is written by whatever a remote executor
 * chose to say. The limit is on the column as well as in the truncation that
 * feeds it, so a write that skipped the truncation fails loudly and the job is
 * retried, rather than storing a megabyte of somebody's stack trace on a row the
 * scheduler reads in batches.
 *
 * Long enough for a wrapped Go error chain, which is what actually arrives here,
 * and short enough that a batch of them is still one small read.
 */
export const RATCHETJQ_ERR_MSG_MAX_CHARS = 1024

@Entity('ratchetjq_job')
//  Steady-state claim: an executor instance takes its own runnable rows, newest
//  lease first within a priority. `leaseExpiresAt` alone decides claimability
//  here, which is why this is the only ordering the aggregate in `dur` needs.
@Index('ratchetjq_job_lease_expires_idx', ['executor', 'executorId', 'period', 'pr', 'leaseExpiresAt'])
//  Restart reclaim: the same prefix, ordered by backoff instead of by lease, so
//  a runner coming back up takes back its interrupted rows without waiting out
//  leases granted to the process that died (spec §6.3). Without this index that
//  path would have to pull every `running` row for the host and filter, which is
//  a scan precisely when the runner most needs to be fast.
@Index('ratchetjq_job_visible_idx', ['executor', 'executorId', 'period', 'pr', 'visibleAt'])
//  Scanner's global sweep — sweeping, force-advancing and retrying `accepting`.
//  It has no executor prefix, so the two indexes above cannot serve it.
@Index('ratchetjq_job_proposer_idx', ['period', 'pr', 'leaseExpiresAt'])
//  Deduplication (spec §2.6): at most one unfinished job per channel, executor
//  instance and resource. Partial on both counts — `channel = NONE` opts out
//  entirely, and a completed job must not block the next submission.
@Index('ratchetjq_job_dedup_unique', ['channel', 'executor', 'executorId', 'resourceId'], {
  unique: true,
  where: `"channel" <> 0 AND "period" <> 'completed'`,
})
export class RatchetJQJob {
  @PrimaryGeneratedColumn('uuid')
  id: string

  //  Deduplication channel. Numeric because NONE is 0 and the unique index is
  //  predicated on being something other than it, so opting out is the default
  //  rather than a special value a caller has to know.
  @Column({ type: 'integer', default: RatchetJQJobChannel.NONE })
  channel: number = RatchetJQJobChannel.NONE

  //  Kind of executor that runs this job, normally the runner. Left as text
  //  rather than an enum: a new kind of executor should not need a migration
  //  before it can be scheduled.
  @Column({ type: 'character varying' })
  executor: string

  //  Which executor instance owns the job. Part of the dedup key and the
  //  equality prefix of both claim indexes, so a job belongs to one instance
  //  and only that instance claims it in steady state.
  @Column({ type: 'character varying' })
  executorId: string

  //  The resource the side effect touches. Part of the dedup key, which is what
  //  narrows deduplication from "one job per channel" to "one job per channel
  //  per resource" and lets different resources in one channel run in parallel.
  @Column({ type: 'character varying' })
  resourceId: string

  //  Priority; every claim query is `ORDER BY pr ASC`, so lower is scheduled
  //  first. Defaults to the middle of the range rather than to 0, so a submitter
  //  that does not care need not invent a value and one that does can go either
  //  way from it (RATCHETJQ_DEFAULT_PR).
  @Column({ type: 'integer', default: RATCHETJQ_DEFAULT_PR })
  pr = RATCHETJQ_DEFAULT_PR

  //  Job type name, which decides who runs the job, how, and what it does. It
  //  matches the name the executor's own implementation reports, so this string
  //  is the whole of dispatch. Text rather than an enum for the same reason as
  //  `executor`: registering a job type is code, not schema.
  @Column({ type: 'character varying' })
  type: string

  //  Job input. Shaped by the job type, so it is stored opaquely and decoded by
  //  the only code that knows the shape.
  @Column({ type: 'jsonb', nullable: true })
  inParams?: Record<string, unknown> | null

  //  Job output, written when the job reports its result.
  @Column({ type: 'jsonb', nullable: true })
  outParams?: Record<string, unknown> | null

  //  Why the executor's round failed, in its own words; null for a job that has
  //  not failed. Written by Report beside `status = failed`, and truncated to
  //  RATCHETJQ_ERR_MSG_MAX_CHARS on the way in.
  //
  //  It is a column rather than a key inside `outParams` because the two are
  //  produced by different events: `outParams` is what a run produced, and a run
  //  that raised produced nothing. Folding a failure into the output field would
  //  make "the job returned something" and "the job blew up" the same shape, and
  //  every reader would have to look inside to tell them apart.
  //
  //  This is the only durable record of a failure. The run happens in another
  //  process, so without it a job closed as `rejected` or `timeout` behind a
  //  failed round says only that it did not work, and the reason lives in a
  //  runner's logs on a host nobody has named yet.
  @Column({ type: 'character varying', length: RATCHETJQ_ERR_MSG_MAX_CHARS, nullable: true })
  errMsg?: string | null

  //  Scheduling stage. No database default: the two creation paths deliberately
  //  start a job at different stages — an asynchronous submission at
  //  PENDING_RUN, a synchronous one already at RUNNING because the REST call
  //  itself is the first round (spec §2.2) — and a default would quietly pick
  //  one of them for a caller that forgot.
  @Column({ type: 'enum', enum: RatchetJQJobPeriod })
  period: RatchetJQJobPeriod

  //  Business result, null until the job reaches `period = completed`.
  @Column({ type: 'enum', enum: RatchetJQJobStatus, nullable: true })
  status?: RatchetJQJobStatus | null

  //  When this row may be claimed again — deliberately not "when the lease
  //  expires". Each writer stores `now() + MAX(stage lease, backoff)` here, so
  //  one comparison answers both "is the previous holder still entitled to it"
  //  and "has the backoff elapsed", and `leaseExpiresAt >= visibleAt` always
  //  holds. Collapsing the two into one column is what lets `dur` read a plain
  //  `min(leaseExpiresAt)` instead of approximating with a pair of minimums
  //  (spec §2.3).
  @Column({ type: 'timestamp with time zone' })
  leaseExpiresAt: Date

  //  The backoff deadline on its own, `now() + attempt⁴ seconds`. In steady
  //  state nothing reads it, because `leaseExpiresAt` already subsumes it; it
  //  exists for restart reclaim, which must ignore leases but must still honour
  //  backoff, and it keeps "the lease is live" distinguishable from "still
  //  backing off" when diagnosing a stuck row.
  @Column({ type: 'timestamp with time zone' })
  visibleAt: Date

  //  The number of the NEXT round to be scheduled, not the count of failures so
  //  far (spec §2.2). An asynchronous submission writes 1; anything that has
  //  already consumed a round writes 2 or `attempt + 1`. Every "may this be
  //  retried" test is therefore the same comparison against the configured
  //  maximum, and "the round that was interrupted" is always `attempt - 1`.
  @Column({ type: 'integer' })
  attempt: number

  //  Time budget in seconds for one execution round, and for one accept round.
  //  Both are carried in by the submitter, so each job has its own budget
  //  instead of sharing a global constant.
  //
  //  Seconds rather than an `interval`, so the two budgets and the backoff are
  //  all plain numbers: the scheduler compares them as numbers and converts
  //  once, `now() + GREATEST("ttlSeconds", POW(attempt, 4)) * interval '1s'`,
  //  instead of multiplying each side out before comparing. It also keeps the
  //  column a number on the way back out — node-postgres parses `interval` into
  //  an object, which would have needed a transformer here.
  //
  //  The unit is in the name because these are the only columns here whose value
  //  is meaningless without one; the spec calls them `ttl` and `attl`.
  @Column({ type: 'integer' })
  ttlSeconds: number

  @Column({ type: 'integer' })
  attlSeconds: number

  //  Job type to create a rollback job with once the rounds are used up, and
  //  the id of the job that created. Null when a job type has no rollback, and
  //  `rollbackJobId` is null until the rollback is actually created.
  @Column({ type: 'character varying', nullable: true })
  rollbackType?: string | null

  @Column({ type: 'uuid', nullable: true })
  rollbackJobId?: string | null

  //  Insertion time, for diagnosis and for measuring how long work waits. There
  //  is deliberately no `updatedAt`: the scheduler advances rows with raw
  //  statements rather than through the ORM, so an `@UpdateDateColumn` would go
  //  stale on exactly the writes worth knowing about.
  @CreateDateColumn({ type: 'timestamp with time zone' })
  createdAt: Date
}
