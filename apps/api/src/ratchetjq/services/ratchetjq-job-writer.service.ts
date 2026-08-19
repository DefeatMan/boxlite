/*
 * Copyright 2026 BoxLite AI
 * SPDX-License-Identifier: AGPL-3.0
 */

import { Injectable, Logger } from '@nestjs/common'
import { InjectRepository } from '@nestjs/typeorm'
import { Repository } from 'typeorm'
import { RatchetJQJob } from '../entities/ratchetjq-job.entity'
import { RatchetJQJobChannel } from '../enums/ratchetjq-job-channel.enum'
import { RatchetJQJobPeriod } from '../enums/ratchetjq-job-period.enum'
import { RatchetJQJobStatus } from '../enums/ratchetjq-job-status.enum'
import { RatchetJQDuplicateJobError } from '../errors/ratchetjq-duplicate-job.error'
import { RatchetJQTransferService } from './ratchetjq-transfer.service'

/** Postgres unique_violation, raised by the partial dedup index of spec §2.6. */
const PG_UNIQUE_VIOLATION = '23505'

/** The dedup index's name, so an unrelated unique violation is not read as dedup. */
const DEDUP_CONSTRAINT = 'ratchetjq_job_dedup_unique'

/**
 * What a submitter has to say to get a job scheduled.
 *
 * One typed value rather than a long argument list, and nothing here is guessed
 * on the submitter's behalf beyond the two fields the schema itself defaults:
 * every other field decides who runs the job or how it is retried, and guessing
 * at those would be guessing about someone else's side effect.
 */
export interface RatchetJQJobSubmission {
  /** Kind of executor to run this job, matching what claims under that name. */
  executor: string
  /** Which executor instance owns it; a claim is scoped to one instance. */
  executorId: string
  /** The resource the side effect touches, and part of the dedup key (§2.6). */
  resourceId: string
  /** Job type name, which is the whole of dispatch on both sides. */
  type: string
  /** Seconds one execution round may take. */
  ttlSeconds: number
  /** Seconds one accept round may take. */
  attlSeconds: number
  /** Job input, shaped by the job type and stored opaquely. */
  inParams?: Record<string, unknown> | null
  /**
   * Deduplication channel. Omitted means NONE, which opts out: the unique index
   * is predicated on being something other than NONE, so a submitter who has not
   * thought about deduplication does not silently acquire it.
   *
   * A number and not the enum, for the reason the enum itself gives: concrete
   * channels belong to the job types that claim them, so they are declared with
   * those types rather than collected here.
   */
  channel?: number
  /** Priority; lower is claimed first. Omitted means 0. */
  pr?: number
  /** Job type to roll this job back with, when it has one. */
  rollbackType?: string | null
}

/**
 * The four columns the writer's entry points disagree about.
 *
 * `deadlines` is SQL and not values because two of the three are expressions
 * over the database's own `now()`. It supplies `leaseExpiresAt`, `visibleAt` and
 * `attempt`, in that order, and may read the statement's parameters — `$8` being
 * `ttlSeconds`, which is the only one either form needs.
 */
interface RatchetJQSchedule {
  period: RatchetJQJobPeriod
  deadlines: string
}

/**
 * Writes job rows: the one place a RatchetJQ job comes into existence.
 *
 * It is the mechanical half of PROPOSER, split out from RatchetJQProposerService
 * because two very different callers create jobs and one of them is downstream of
 * the other. A submitter calls the proposer, which pushes and then accepts; the
 * accept segment, deciding a job cannot stand, has to create the compensation for
 * it. Leaving row creation on the proposer made that second path point back at
 * PROPOSER — proposer → report → accept round → finalizer → proposer — and Nest
 * refuses to build a cycle. Nothing here depends on the accept segment, so
 * whoever needs a row can have one.
 *
 * Every entry point does the same two steps in the same order: write the row,
 * then hint the executor that owns it. Only the four scheduling columns differ,
 * which is what the two public forms are named after.
 *
 * All of them write against the database's own `now()`, never a timestamp from
 * this process: every other writer in RatchetJQ compares deadlines to `now()`, so
 * a row stamped with an application clock would be scheduled against a clock
 * nothing else reads.
 */
@Injectable()
export class RatchetJQJobWriter {
  private readonly logger = new Logger(RatchetJQJobWriter.name)

  constructor(
    @InjectRepository(RatchetJQJob) private readonly jobRepository: Repository<RatchetJQJob>,
    private readonly transfer: RatchetJQTransferService,
  ) {}

  /**
   * Write a job for an executor to claim on its own (spec §9.1, async form).
   *
   * `attempt = 1` — the first round is unspent — and both deadlines are `now()`,
   * which is what makes the row claimable on the next poll rather than after a
   * backoff it has not earned.
   */
  async queue(submission: RatchetJQJobSubmission): Promise<RatchetJQJob> {
    return this.insertAndHint(submission, {
      period: RatchetJQJobPeriod.PENDING_RUN,
      deadlines: `now(), now(), 1`,
    })
  }

  /**
   * Write a job as already begun, for a caller that is about to push it (spec
   * §9.1, sync form).
   *
   * `attempt = 2` because the hand-off the caller is about to make *is* the first
   * round (spec §2.2): the row is written as underway so nothing else claims it
   * while that call is in flight, and so a call that never arrives is retried by
   * the pulled path once the lease lapses rather than sitting new forever.
   */
  async start(submission: RatchetJQJobSubmission): Promise<RatchetJQJob> {
    return this.insertAndHint(submission, {
      period: RatchetJQJobPeriod.RUNNING,
      // The lease covers the round the push is about to spend, so it is one whole
      // `ttlSeconds` — `$8` in the statement below. `visibleAt` is a second out
      // rather than `now()`: it is the backoff, and a round that has only just
      // started has not earned one.
      deadlines: `now() + $8 * interval '1 second', now() + interval '1 second', 2`,
    })
  }

  /**
   * Queue the job that undoes another one (spec §8.5, `CreateRollbackJob`).
   *
   * Always the queued form: whoever asks for a rollback — an acceptor that
   * rejected, or a sweep retiring a job whose rounds are gone — is finishing the
   * original job, not waiting on the compensation.
   *
   * The rollback job inherits the executor pair, the resource and both budgets,
   * because it undoes a side effect on the same resource on the same executor
   * instance and has no better source for how long that takes. It deliberately
   * does not inherit two things:
   *
   * - `channel` is NONE, so the rollback bypasses the dedup index. It has to: the
   *   original job is still not `completed` at this point, so it still holds the
   *   channel, and a rollback that queued on it would deadlock against the job it
   *   exists to undo. The consequence — a rollback can run beside a new job on
   *   the same channel — is the spec's own open question (§12-7).
   * - `rollbackType` is null, which is what terminates the recursion the spec
   *   names in §12-6: a rollback job that uses up its own rounds has nothing to
   *   roll back with, so it is retired as a timeout instead of queueing another.
   *
   * A job with no `rollbackType` is refused rather than silently queueing
   * nothing: the caller decides whether a job type has a compensation, and by the
   * time it is asking for one, a missing type is a bug in its own branch.
   *
   * `status` is the outcome the caller is about to close the undone job with, and
   * it is a parameter because only the caller knows it: this rollback is created
   * before that write lands, so the row itself does not carry it yet.
   */
  async queueRollbackFor(job: RatchetJQJob, status: RatchetJQJobStatus): Promise<RatchetJQJob> {
    if (!job.rollbackType) {
      throw new Error(`RatchetJQ job ${job.id} of type "${job.type}" has no rollbackType to roll it back with`)
    }

    return this.queue({
      executor: job.executor,
      executorId: job.executorId,
      resourceId: job.resourceId,
      type: job.rollbackType,
      ttlSeconds: job.ttlSeconds,
      attlSeconds: job.attlSeconds,
      pr: job.pr,
      channel: RatchetJQJobChannel.NONE,
      rollbackType: null,
      inParams: this.rollbackInParams(job, status),
    })
  }

  /**
   * What a rollback job is told about the job it undoes: which job that was, and
   * what happened to it.
   *
   * It travels as `inParams` because that is the only thing a rollback's executor
   * ever sees — it cannot read the job table. `id` and `type` name the job being
   * undone, which is what lets a rollback say whose work it is reversing and
   * recognise a repeat of itself, something at-least-once delivery makes its
   * problem. They are the undone job's own columns, not this new row's: the
   * rollback's own type is `rollbackType`, and the two are different by
   * construction. The database keeps the link in the other direction, on the
   * undone job's `rollbackJobId`, so carrying it here is what makes it readable
   * from the side that has to act on it.
   *
   * The other three are what happened. `in` says what was requested, `out` says
   * what was produced and is usually the only way to find the side effect again
   * (an archive path, an allocated id), and `status` is the outcome the undone job
   * is being closed with.
   *
   * `status` is that final outcome and not the row's current value, which is why
   * it is a parameter rather than read off `job`. At this point the undone job has
   * not been closed yet — it is closed pointing at the rollback this call is
   * creating — so its own column still holds whatever the executor reported, or
   * null for a job that never reported at all. The useful answer is the one the
   * caller is about to write: `REJECTED` because a handler refused the outcome, or
   * `TIMEOUT` because the rounds ran out. That is what tells a compensation why it
   * exists.
   */
  private rollbackInParams(job: RatchetJQJob, status: RatchetJQJobStatus): Record<string, unknown> {
    return {
      id: job.id,
      type: job.type,
      in: job.inParams ?? null,
      out: job.outParams ?? null,
      status,
    }
  }

  /**
   * Writes the row and hints the executor — the two steps every form shares.
   *
   * The hint goes out after the insert has committed, so an executor that acts
   * on it at once finds the row. It is deliberately not part of the failure
   * story: `wakeup` swallows its own errors, because a lost hint costs one poll
   * interval while a submission that failed on an unreachable Redis would cost
   * the caller its job.
   */
  private async insertAndHint(submission: RatchetJQJobSubmission, schedule: RatchetJQSchedule): Promise<RatchetJQJob> {
    this.validate(submission)

    const [job] = await this.insert(submission, schedule)
    if (!job) {
      throw new Error(`Inserting a RatchetJQ job of type "${submission.type}" returned no row`)
    }

    this.logger.log(`Submitted RatchetJQ job ${job.id} of type ${job.type} as ${job.period}`)
    await this.transfer.wakeup(submission.executor, submission.executorId)

    return job
  }

  /**
   * The INSERT of spec §9.1.
   *
   * The column list puts everything every form agrees on first, so the parameters
   * read in order and the schedule's SQL lands at the end where the forms differ.
   *
   * `RETURNING *` needs no CTE wrapper here, unlike the claim and scan
   * statements: TypeORM rewrites a result into a `[rows, affected]` tuple only
   * for UPDATE and DELETE, and an INSERT comes back as plain rows
   * (`typeorm/driver/postgres/PostgresQueryRunner.js:198-205`).
   */
  private async insert(submission: RatchetJQJobSubmission, schedule: RatchetJQSchedule): Promise<RatchetJQJob[]> {
    try {
      return await this.jobRepository.query(
        `INSERT INTO "ratchetjq_job"
           ("channel", "executor", "executorId", "resourceId", "pr", "type", "inParams",
            "ttlSeconds", "attlSeconds", "rollbackType",
            "period", "leaseExpiresAt", "visibleAt", "attempt")
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, ${schedule.deadlines})
         RETURNING *`,
        [
          submission.channel ?? RatchetJQJobChannel.NONE,
          submission.executor,
          submission.executorId,
          submission.resourceId,
          submission.pr ?? 0,
          submission.type,
          submission.inParams ?? null,
          submission.ttlSeconds,
          submission.attlSeconds,
          submission.rollbackType ?? null,
          schedule.period,
        ],
      )
    } catch (error) {
      throw this.asDuplicate(error, submission) ?? error
    }
  }

  /**
   * Turns a dedup collision into a domain error, and leaves anything else alone.
   *
   * A collision is the design working: something unfinished already holds this
   * channel for this resource on this executor instance, and a second job would
   * be the duplicate the index exists to refuse. It is matched on the index name
   * as well as the code, so another table's unique constraint is never reported
   * as a RatchetJQ duplicate.
   */
  private asDuplicate(error: unknown, submission: RatchetJQJobSubmission): RatchetJQDuplicateJobError | null {
    const failure = error as { code?: string; constraint?: string }
    if (failure?.code !== PG_UNIQUE_VIOLATION || failure.constraint !== DEDUP_CONSTRAINT) {
      return null
    }

    return new RatchetJQDuplicateJobError({
      channel: submission.channel ?? RatchetJQJobChannel.NONE,
      executor: submission.executor,
      executorId: submission.executorId,
      resourceId: submission.resourceId,
    })
  }

  /**
   * Checks what only the submitter can get wrong, where it enters.
   *
   * The budgets are checked because a zero or negative one does not fail loudly:
   * it writes a lease that has already expired, so the job is claimed, timed out
   * and retried until its rounds are gone — a submission that looks accepted and
   * quietly burns its attempts. The names are checked because each one is
   * dispatch: an empty `type` reaches no job type and no acceptor, and an empty
   * executor pair addresses a hint nobody is listening for.
   */
  private validate(submission: RatchetJQJobSubmission): void {
    for (const [field, value] of [
      ['executor', submission.executor],
      ['executorId', submission.executorId],
      ['resourceId', submission.resourceId],
      ['type', submission.type],
    ] as const) {
      if (!value) {
        throw new Error(`A RatchetJQ submission needs a ${field}`)
      }
    }

    for (const [field, value] of [
      ['ttlSeconds', submission.ttlSeconds],
      ['attlSeconds', submission.attlSeconds],
    ] as const) {
      if (!Number.isInteger(value) || value <= 0) {
        throw new Error(`A RatchetJQ submission needs a positive whole ${field}, got "${value}"`)
      }
    }

    if (submission.pr !== undefined && (!Number.isInteger(submission.pr) || submission.pr < 0)) {
      throw new Error(`A RatchetJQ submission's pr must be a whole number and not negative, got "${submission.pr}"`)
    }
  }
}
