/*
 * Copyright 2026 BoxLite AI
 * SPDX-License-Identifier: AGPL-3.0
 */

import { Injectable, Logger } from '@nestjs/common'
import { InjectRepository } from '@nestjs/typeorm'
import { Repository } from 'typeorm'
import { RatchetJQJob } from '../entities/ratchetjq-job.entity'
import { RatchetJQJobPeriod } from '../enums/ratchetjq-job-period.enum'
import { RatchetJQAcceptVerdict } from './job-acceptor'

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

  constructor(@InjectRepository(RatchetJQJob) private readonly jobRepository: Repository<RatchetJQJob>) {}

  async finalize(job: RatchetJQJob, verdict: RatchetJQAcceptVerdict): Promise<void> {
    if (verdict === RatchetJQAcceptVerdict.ROLLBACK) {
      return this.rollback(job)
    }

    return this.complete(job)
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
   * null would only make the statement look like it knew something. Report has to
   * persist the executor's reported status when it moves a row to `accepting`, or
   * a job the Scanner completes ends with no status at all. That is a gap in
   * Report, not one this statement can close.
   */
  private async complete(job: RatchetJQJob): Promise<void> {
    await this.jobRepository.query(`UPDATE "ratchetjq_job" SET "period" = $2 WHERE "id" = $1 AND "period" = $3`, [
      job.id,
      RatchetJQJobPeriod.COMPLETED,
      RatchetJQJobPeriod.ACCEPTING,
    ])
  }

  /**
   * The outcome does not stand, which cannot be acted on yet: it needs the same
   * rollback job the two sweeps need, and the PROPOSER's job-creation path does
   * not exist.
   *
   * The row is left `accepting` rather than completed. Completing it would drop
   * the rollback silently — the job would read as finished with its side effect
   * never undone — whereas leaving it means a later round offers the outcome to
   * the acceptor again, which is why an acceptor must be idempotent, until its
   * rounds are used up and the sweep takes it.
   */
  private async rollback(job: RatchetJQJob): Promise<void> {
    this.logger.error(
      `RatchetJQ job ${job.id} needs a rollback job the PROPOSER cannot create yet; leaving it in accepting`,
    )
  }
}
