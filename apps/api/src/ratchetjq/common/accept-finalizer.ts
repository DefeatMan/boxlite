/*
 * Copyright 2026 BoxLite AI
 * SPDX-License-Identifier: AGPL-3.0
 */

import { Injectable, Logger } from '@nestjs/common'
import { InjectRepository } from '@nestjs/typeorm'
import { EntityManager, Repository } from 'typeorm'
import { RatchetJQJob } from '../entities/ratchetjq-job.entity'
import { RatchetJQJobPeriod } from '../enums/ratchetjq-job-period.enum'
import { RatchetJQJobStatus } from '../enums/ratchetjq-job-status.enum'
import { RatchetJQJobWriter } from '../services/ratchetjq-job-writer.service'
import { RatchetJQAcceptVerdict } from './job-acceptor'

/**
 * The narrow slice of TypeORM the terminal write needs, so both callers can supply
 * what they have: the repository, for a write that stands on its own, or a
 * transaction's EntityManager, for one that has to land inside a lock its caller
 * is holding. Both spell the call the same way, and naming only `query` keeps the
 * choice about which connection the write goes to rather than about ORM surface.
 */
type RatchetJQSqlRunner = Pick<EntityManager, 'query'>

/**
 * Acts on one verdict (spec §9.2): the writes that end an accept round.
 *
 * It exists as one thing rather than one per caller because there are three
 * callers of the same three lines — a synchronous `Report` that accepted inline,
 * an asynchronous one whose accept settled later, and the Scanner retrying an
 * accept nobody settled — and every one of them has to reach the same terminal
 * state for the same verdict. Splitting that across three chains is how a job
 * ends up completed on one path and rolled back on another.
 *
 * It never decides anything. The verdict arrives already made, and a failure to
 * act on it is reported to the caller rather than absorbed here: the row is still
 * `accepting`, which is what hands it back to the lease and the Scanner.
 */
@Injectable()
export class RatchetJQAcceptFinalizer {
  private readonly logger = new Logger(RatchetJQAcceptFinalizer.name)

  constructor(
    @InjectRepository(RatchetJQJob) private readonly jobRepository: Repository<RatchetJQJob>,
    private readonly writer: RatchetJQJobWriter,
  ) {}

  async finalize(job: RatchetJQJob, verdict: RatchetJQAcceptVerdict): Promise<void> {
    if (verdict === RatchetJQAcceptVerdict.ROLLBACK) {
      return this.rollback(job)
    }

    return this.complete(job)
  }

  /**
   * Retire a job whose rounds are used up (spec §8.5, triggers 1 and 2).
   *
   * The third way a job reaches `completed`, beside the two verdicts, and the only
   * one no acceptor asked for: the scheduler has run out of rounds to give it, so
   * the job is closed as `timeout` and whatever it did get done is undone by a
   * rollback job. It lands here rather than in the Scanner because closing a job
   * through a compensation is one rule with one correct order, and a rejection and
   * an exhaustion differ only in the status they close with.
   *
   * `runner` is the caller's transaction and is required, not optional, because of
   * what the caller is doing while this runs: the sweep holds the row locked `FOR
   * UPDATE` so a report cannot move it out from under the retirement. A write
   * issued on any other connection would queue behind that lock while the sweep
   * waits for the write — a deadlock with itself. Taking the caller's transaction
   * is what keeps the terminal write inside the lock that protects it.
   *
   * The `period` the row was found in is the guard, so a sweep of `running` cannot
   * close a row that has since become `accepting`, and vice versa.
   */
  async retire(job: RatchetJQJob, runner: RatchetJQSqlRunner): Promise<void> {
    this.logger.warn(
      `RatchetJQ job ${job.id} of type "${job.type}" used up its rounds in ${job.period}; ` +
        `retiring it as ${RatchetJQJobStatus.TIMEOUT}`,
    )

    return this.completeThroughRollback(job, RatchetJQJobStatus.TIMEOUT, job.period, runner)
  }

  /**
   * The outcome stands, so the job reaches its one terminal stage.
   *
   * Guarded by `period = accepting`, which makes the write idempotent: an accept
   * offered twice — a retried round, an acceptor settling late — completes the job
   * once and no-ops after that.
   *
   * `period` and nothing else. The spec's `status = ret.status` can only mean the
   * row's own status when the Scanner is the caller, and that column is not
   * written until a job completes, so it is still null there; copying null over
   * null would only make the statement look like it knew something. The status a
   * completing job carries is the one Report already wrote on the way into
   * `accepting` (`ratchetjq-transfer.service.ts:report`), which is what makes
   * `period` the only column left to move.
   */
  private async complete(job: RatchetJQJob): Promise<void> {
    await this.jobRepository.query(`UPDATE "ratchetjq_job" SET "period" = $2 WHERE "id" = $1 AND "period" = $3`, [
      job.id,
      RatchetJQJobPeriod.COMPLETED,
      RatchetJQJobPeriod.ACCEPTING,
    ])
  }

  /**
   * The outcome does not stand: the compensation is queued, and the job completes
   * as `REJECTED` pointing at it (spec §8.5).
   *
   * The rollback job is created first and recorded second, which is the only
   * order that cannot drop a side effect. Reversed, a failure between the two
   * would leave a job that reads as finished with nothing undoing it; this way a
   * failure leaves the row `accepting`, so a later round asks the acceptor again —
   * which is what makes idempotency a contract rather than a nicety, since that
   * round can create a second rollback job for the same original.
   *
   * A job type with no `rollbackType` completes as `REJECTED` with no rollback job
   * at all. The verdict still stands — the acceptor refused it, and retrying would
   * refuse it again — there is simply nothing registered to undo, and leaving the
   * row for a rollback that can never be created would only burn its rounds down
   * to a timeout. It is also what terminates the chain: a rollback job is created
   * without a `rollbackType` of its own (spec §12-6), so a rejected rollback ends
   * here instead of queueing another.
   */
  private async rollback(job: RatchetJQJob): Promise<void> {
    return this.completeThroughRollback(
      job,
      RatchetJQJobStatus.REJECTED,
      RatchetJQJobPeriod.ACCEPTING,
      this.jobRepository,
    )
  }

  /**
   * Queues the compensation, then closes the job pointing at it — the one order
   * that cannot drop a side effect, shared by both ways a job ends this way.
   *
   * Reversed, a failure between the two would leave a job that reads as finished
   * with nothing undoing it; this way a failure leaves the row where it was, so a
   * later round — another accept, or the next sweep — comes back to it. That is
   * what makes idempotency a contract rather than a nicety, since the later round
   * can create a second rollback job for the same original.
   *
   * The rollback job is deliberately written on the writer's own connection rather
   * than the caller's transaction. It has to survive a caller that rolls back:
   * losing the compensation while keeping the job open is recoverable, but closing
   * the job while losing the compensation is not.
   *
   * A job type with no `rollbackType` closes with no rollback job at all. There is
   * simply nothing registered to undo, and leaving the row for a rollback that can
   * never be created would only burn its remaining rounds. It is also what
   * terminates the chain: a rollback job is created without a `rollbackType` of
   * its own (spec §12-6), so a failed rollback ends here instead of queueing
   * another.
   */
  private async completeThroughRollback(
    job: RatchetJQJob,
    status: RatchetJQJobStatus,
    fromPeriod: RatchetJQJobPeriod,
    runner: RatchetJQSqlRunner,
  ): Promise<void> {
    // The status goes with it, because the compensation is told why it exists and
    // this write is the only place that knows: the row still carries whatever the
    // executor reported until the statement below lands.
    const rollbackJobId = job.rollbackType ? (await this.writer.queueRollbackFor(job, status)).id : null
    if (!rollbackJobId) {
      this.logger.warn(
        `RatchetJQ job ${job.id} of type "${job.type}" completes as ${status} with no rollbackType to undo it`,
      )
    }

    await runner.query(
      `UPDATE "ratchetjq_job" SET "period" = $2, "status" = $3, "rollbackJobId" = $4
       WHERE "id" = $1 AND "period" = $5`,
      [job.id, RatchetJQJobPeriod.COMPLETED, status, rollbackJobId, fromPeriod],
    )
  }
}
