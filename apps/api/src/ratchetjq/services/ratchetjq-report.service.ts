/*
 * Copyright 2026 BoxLite AI
 * SPDX-License-Identifier: AGPL-3.0
 */

import { Injectable, Logger } from '@nestjs/common'
import { RatchetJQAcceptRound } from '../common/accept-round'
import { RatchetJQJob } from '../entities/ratchetjq-job.entity'
import { RatchetJQScannerService } from './ratchetjq-scanner.service'
import { RatchetJQReportedOutcome, RatchetJQTransferService } from './ratchetjq-transfer.service'

/**
 * Report (spec §9.1): where an executor's outcome enters the accept segment.
 *
 * Two entry points for the two shapes a report arrives in, and they differ in one
 * thing only — whether the reporting executor waits for the verdict. Everything
 * before that is the same three steps in the same order, because each one depends
 * on the last: the row moves to `accepting` carrying what the executor reported,
 * that report wakes a Scanner so the accept segment has a backstop at all, and
 * only then does round 1 of the accept run inline.
 *
 * The row is written as a round already underway — one `attlSeconds` of accept
 * lease from the moment it lands — which is why there is no "reported, not yet
 * accepting" stage: the inline round's own terminal write can then predicate on
 * `period = accepting` and never race an advance statement (spec §8.1). The cost
 * is stated there too: a proposer that dies between the write and the accept
 * leaves the row waiting out its whole lease.
 *
 * It is a service of its own rather than two more methods on PROPOSER, because
 * acting on a rejection means creating a rollback job, so the accept segment
 * depends on PROPOSER — `RatchetJQAcceptFinalizer` → `RatchetJQProposerService` —
 * and PROPOSER must not depend back on it.
 */
@Injectable()
export class RatchetJQReportService {
  private readonly logger = new Logger(RatchetJQReportService.name)

  constructor(
    private readonly transfer: RatchetJQTransferService,
    private readonly scanner: RatchetJQScannerService,
    private readonly acceptRound: RatchetJQAcceptRound,
  ) {}

  /**
   * Take an outcome and accept it before answering (spec §4).
   *
   * For an executor that ran the job on a `SyncRun` push and is holding that
   * request open: it gets the accept's failure as its own, which beats learning
   * nothing and waiting out a lease. `abortSignal` is how a controller says that
   * executor has hung up, and it is the only thing that bounds the accept — the
   * heartbeat deliberately holds the lease for as long as the round runs.
   *
   * The job comes back as it entered `accepting`, not as it ended: the terminal
   * write happens inside the round, so a caller that needs the final status reads
   * the row again. Null means no `running` row for this executor to report
   * against — a duplicate report, or one for a job it does not hold — which is
   * left for the caller to answer for, since only it knows which of the two it is.
   */
  async syncReport(
    executor: string,
    executorId: string,
    jobId: string,
    outcome: RatchetJQReportedOutcome,
    abortSignal?: AbortSignal,
  ): Promise<RatchetJQJob | null> {
    const job = await this.startAccepting(executor, executorId, jobId, outcome)
    if (!job) {
      return null
    }

    await this.acceptRound.runInline(job, abortSignal)

    return job
  }

  /**
   * Take an outcome and answer at once, leaving the accept to run behind it
   * (spec §5).
   *
   * For an executor that pulled the job and is reporting from its own loop:
   * holding its request open for an accept it is not waiting on would tie a
   * runner's poll to a decision that may take as long as it likes.
   *
   * So the round is started and not awaited. That is safe because
   * `runUnattended` owns its own failures and bounds itself by the job's accept
   * budget — nothing here could act on a rejection anyway, and a round that
   * overruns is the Scanner's business.
   */
  async asyncReport(
    executor: string,
    executorId: string,
    jobId: string,
    outcome: RatchetJQReportedOutcome,
  ): Promise<RatchetJQJob | null> {
    const job = await this.startAccepting(executor, executorId, jobId, outcome)
    if (!job) {
      return null
    }

    void this.acceptRound.runUnattended(job)

    return job
  }

  /**
   * The write and the wake-up: everything both forms do before they differ.
   *
   * The wake-up is second because it is only useful once the row exists, and it
   * is swallowed because it is a hint. It is also the only thing that ever grows
   * the Scanner pool or refills a slot a crash freed (spec §7), so a report is
   * exactly where it belongs — but a report whose row is already committed must
   * not fail on an unreachable Redis, or the accept segment would lose the
   * outcome it just recorded over a missing backstop.
   */
  private async startAccepting(
    executor: string,
    executorId: string,
    jobId: string,
    outcome: RatchetJQReportedOutcome,
  ): Promise<RatchetJQJob | null> {
    const job = await this.transfer.report(executor, executorId, jobId, outcome)
    if (!job) {
      return null
    }

    try {
      await this.scanner.scannerWakeup()
    } catch (error) {
      this.logger.warn(`Waking a RatchetJQ Scanner after reporting job ${job.id} failed: ${error.message}`)
    }

    return job
  }
}
