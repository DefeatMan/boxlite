/*
 * Copyright 2026 BoxLite AI
 * SPDX-License-Identifier: AGPL-3.0
 */

import { Injectable, Logger } from '@nestjs/common'
import { InjectRepository } from '@nestjs/typeorm'
import { Repository } from 'typeorm'
import { RatchetJQJobAcceptorRegistry } from '../common/job-acceptor-registry'
import { RatchetJQSyncRunOutcome } from '../common/job-executor'
import { RatchetJQJobExecutorRegistry } from '../common/job-executor-registry'
import { RatchetJQJob } from '../entities/ratchetjq-job.entity'
import { RatchetJQJobStatus } from '../enums/ratchetjq-job-status.enum'
import { RatchetJQSyncStage, RatchetJQSyncTimeoutError } from '../errors/ratchetjq-sync-timeout.error'
import { RatchetJQJobSubmission, RatchetJQJobWriter } from './ratchetjq-job-writer.service'
import { RatchetJQReportService } from './ratchetjq-report.service'

export { RatchetJQJobSubmission }

/**
 * What a synchronous submission answers with: the row, and what the executor
 * reported for it.
 *
 * The job travels with the outcome because the row exists either way — a caller
 * that got an answer still has an id to look the job up by, and one whose push
 * failed needs that id to know the work is queued rather than lost.
 */
export interface RatchetJQSyncSubmission {
  job: RatchetJQJob
  outcome: RatchetJQSyncRunOutcome
}

/**
 * PROPOSER — where jobs come from (spec §9.1).
 *
 * Two entry points, because a submission arrives in one of two shapes and they
 * schedule differently rather than by a flag. An asynchronous submission is
 * queued and the executor picks it up on its own poll. A synchronous submission
 * is carried the whole way here: the row is written as already running, the job
 * is pushed to its executor, and the outcome that comes back is reported and
 * accepted before the caller is answered (spec §4).
 *
 * Both are orchestration. Rows are written by RatchetJQJobWriter, the push is
 * whichever ISyncJobExecutor serves the kind the submission names, and the accept
 * segment belongs to RatchetJQReportService. That split is what lets this service
 * reach the accept segment at all: the segment has to create rollback jobs, so it
 * depends on the writer — if it depended on PROPOSER instead, the graph would
 * close on itself and Nest would refuse to build it.
 *
 * The one thing this service does itself is read a job back (`findById`). It is a
 * plain point lookup with no scheduling in it, and it sits here because it has the
 * submitters' audience rather than because it fits the split: the writer is where
 * rows are created, not where they are looked at.
 *
 * It is also where a submission's job types are checked against the acceptors this
 * process has, which is deliberately not on the writer. Two reasons, and the
 * second is the load-bearing one: the writer is not exported, so every submission
 * from outside the module arrives here and this is a complete boundary — and the
 * acceptor registry must not become a dependency of the writer, because an
 * acceptor that queues work depends on the writer the way RatchetJQAcceptFinalizer
 * already does, which would close writer → registry → acceptor → writer. Nothing
 * in the accept segment depends on PROPOSER, which is what makes the edge safe in
 * this direction and only this one.
 */
@Injectable()
export class RatchetJQProposerService {
  private readonly logger = new Logger(RatchetJQProposerService.name)

  constructor(
    @InjectRepository(RatchetJQJob) private readonly jobRepository: Repository<RatchetJQJob>,
    private readonly writer: RatchetJQJobWriter,
    private readonly executors: RatchetJQJobExecutorRegistry,
    private readonly acceptors: RatchetJQJobAcceptorRegistry,
    private readonly report: RatchetJQReportService,
  ) {}

  /** Queue a job for the executor to claim on its own (spec §9.1, async form). */
  async execAsync(submission: RatchetJQJobSubmission): Promise<RatchetJQJob> {
    this.requireAcceptors(submission)

    return this.writer.queue(submission)
  }

  /**
   * Read a job back by the id a submission handed out.
   *
   * `execAsync` answers with a row and then nothing: the executor claims it, the
   * accept segment finishes it, and the submitter hears none of that. This is how
   * it finds out. It belongs beside the two submit methods because it has the same
   * audience — whoever asked for the job — and because submitting is in-process
   * here, so reading back is too; there is no HTTP surface on either side to keep
   * symmetric with.
   *
   * The whole row, not a projection. A submitter wants different parts of it at
   * different times — `period` and `status` to see whether it is done, `outParams`
   * for what it produced, `rollbackJobId` to follow a compensation, `attempt` and
   * the two deadlines to explain why it is taking so long — and picking a subset
   * now would be guessing at that before a single caller exists.
   *
   * Null for a job that is not there, rather than a throw: an id that matches
   * nothing is a question with an answer, and only the caller knows whether it
   * expected one.
   */
  async findById(jobId: string): Promise<RatchetJQJob | null> {
    return this.jobRepository.findOne({ where: { id: jobId } })
  }

  /**
   * Submit a job, run it on its executor now, accept what comes back, and answer
   * with it (spec §4, §9.1 sync form).
   *
   * The order is the whole method and every step depends on the last: the row
   * exists before anything can run it, the push spends the round the row was
   * written as already holding, and the outcome is reported and accepted before
   * the caller hears about it — so a caller that got an answer knows the job
   * reached a terminal stage, not merely that a runner replied.
   *
   * `timeoutSeconds` is how long the caller will wait for all of that, and it is
   * one deadline over the whole chain rather than one per hop: what a caller can
   * say is when its own answer stops being useful, not how it should be divided
   * between a push and an accept. Zero — the default — waits indefinitely, the
   * same reading `timeout: 0` has in axios (`ratchetjq-runner.executor.ts:syncRun`) and
   * `BRPOP key 0` has in Redis (spec §6.2). It is spelled as a number of seconds
   * to sit beside `ttlSeconds` and `attlSeconds`, which are the two budgets it has
   * to be chosen against.
   *
   * Nothing else bounds this call, which is why the parameter is worth having: the
   * push has the job's `ttlSeconds`, but the inline accept has a heartbeat that
   * renews its lease for as long as the round runs (`accept-round.ts:startHeartbeat`),
   * so an acceptor that never settles would hold both this caller and the row
   * forever. The deadline is carried as one AbortSignal from here through the push
   * and into the acceptor, so whatever is waiting when it fires is what gets
   * cancelled.
   *
   * A push that fails leaves the row where it is rather than undoing it. Nothing
   * is lost by that — `visibleAt` is a second out and the lease is one
   * `ttlSeconds`, so the pulled path's retry takes the job once that lease
   * lapses, charged a round like any other retry. What the caller loses is the
   * inline answer, which is why the failure travels rather than being logged and
   * swallowed: only the caller knows whether it can wait for the queued run. A
   * deadline that fires is the same shape of failure and travels the same way, as
   * RatchetJQSyncTimeoutError so that it can be told apart from one.
   */
  async execSync(submission: RatchetJQJobSubmission, timeoutSeconds = 0): Promise<RatchetJQSyncSubmission> {
    this.requireAcceptors(submission)

    // Resolved before the row is written, because it is the one failure that no
    // amount of retrying fixes: a kind nothing here can push to will not be
    // pushed to on the next round either, and the pulled path cannot stand in —
    // the caller asked for an outcome, not for the job to be queued.
    const executor = this.executors.executorFor(submission.executor)
    if (!executor) {
      throw new Error(`No RatchetJQ executor can push to the kind "${submission.executor}"`)
    }

    // Armed before the row is written, so the deadline covers everything the
    // caller is waiting on. The insert is the one step inside it that cannot be
    // cancelled, so a deadline can be overrun by that write and no further.
    const deadline = this.deadline(timeoutSeconds)
    const job = await this.writer.start(submission)

    let outcome: RatchetJQSyncRunOutcome
    try {
      outcome = await executor.syncRun(submission.executorId, job, deadline)
    } catch (error) {
      // Asked first, because a cancelled call arrives here as a failure and is
      // not one: the executor did not refuse the job, this caller stopped waiting
      // for it. Reporting both would be two warnings for one event, the first of
      // them wrong about whose fault it was.
      const timedOut = this.asTimeout(deadline, job, 'run', timeoutSeconds)
      if (timedOut) {
        throw timedOut
      }

      // Said once, here, because the caller gets the error and may well decide
      // this is normal — the row is claimable again in one `ttlSeconds`.
      this.logger.warn(
        `Running RatchetJQ job ${job.id} inline failed; it stays claimable for the pulled path: ${error.message}`,
      )
      throw error
    }

    try {
      await this.accept(job, submission, outcome, deadline)
    } catch (error) {
      throw this.asTimeout(deadline, job, 'accept', timeoutSeconds) ?? error
    }

    return { job, outcome }
  }

  /**
   * Refuses a submission naming a job type this process cannot accept.
   *
   * Every job that reports an outcome moves to `accepting` and needs an acceptor
   * to leave it, so a type with none is not a degraded job but a stuck one: the
   * accept round finds nothing, leaves the row to its lease
   * (`accept-round.ts:runUnattended`), and the Scanner retries until the rounds are
   * gone and the job is retired as `timeout` behind a rollback job. Checked here
   * because this is the last moment it costs nothing — past the insert the
   * scheduler is obliged to carry the row to a terminal stage, and the cheapest
   * terminal stage it can reach is that timeout.
   *
   * `rollbackType` is checked with it, and **this is the only place it can be**.
   * The compensation is created by the accept segment through
   * `writer.queueRollbackFor`, which reaches the writer's unchecked path — by
   * design, since a full queue must not stop a compensation — so it passes no
   * guard of its own. A mistyped `rollbackType` therefore surfaces only on the
   * failure path of a job that was already failing, which is the path nothing
   * exercises and the worst one to discover a typo on.
   *
   * A plain error, unlike the writer's dedup and depth refusals: those carry their
   * own types because a caller can act on them — carry on, or shed load — and this
   * one is a wiring mistake no caller can do anything about at runtime. It is the
   * same judgement `execSync` already makes for an executor kind nothing can push
   * to.
   */
  private requireAcceptors(submission: RatchetJQJobSubmission): void {
    for (const [field, type] of [
      ['type', submission.type],
      ['rollbackType', submission.rollbackType],
    ] as const) {
      // A submission without a rollback is the normal case, not a missing
      // acceptor: only a type that was actually named has to resolve.
      if (!type) {
        continue
      }
      if (!this.acceptors.acceptorFor(type)) {
        throw new Error(`No RatchetJQ acceptor for the ${field} "${type}"`)
      }
    }
  }

  /**
   * The signal that carries `timeoutSeconds`, or undefined for an unbounded wait.
   *
   * `AbortSignal.timeout` rather than a controller and a timer of this service's
   * own: its timer does not keep the event loop alive, so a submission that
   * answered early leaves nothing holding shutdown open, and there is no clearing
   * step for a later edit to forget. Everything downstream derives its own
   * controller from this signal anyway (`accept-round.ts:abandonedWhen`), so this
   * one never needs to be aborted by hand.
   *
   * The value is checked rather than coerced, because every wrong value fails
   * quietly in a different direction: a fraction becomes a millisecond count
   * nobody meant, and a negative one aborts the submission before its row is
   * written. Zero is the one falsy value that means something, so it is tested for
   * explicitly instead of relying on truthiness.
   */
  private deadline(timeoutSeconds: number): AbortSignal | undefined {
    if (!Number.isInteger(timeoutSeconds) || timeoutSeconds < 0) {
      throw new Error(
        `A RatchetJQ synchronous submission needs a whole, non-negative timeoutSeconds, got "${timeoutSeconds}"`,
      )
    }
    if (timeoutSeconds === 0) {
      return undefined
    }

    return AbortSignal.timeout(timeoutSeconds * 1_000)
  }

  /**
   * Names a failure as the deadline firing, when that is what it was.
   *
   * The distinction is the caller's to act on and cannot be read off the error
   * that arrives: axios reports a cancelled request as `CanceledError: canceled`,
   * and an abandoned accept round rejects with its own wording
   * (`accept-round.ts:reporterHungUp`), so neither says whose deadline it was. The
   * signal does, which is why this asks it rather than inspecting the error.
   *
   * It reads the signal instead of comparing elapsed time so that a caller's
   * cancellation and a plain failure can never be confused: only an abort that
   * actually happened produces this error.
   */
  private asTimeout(
    deadline: AbortSignal | undefined,
    job: RatchetJQJob,
    stage: RatchetJQSyncStage,
    timeoutSeconds: number,
  ): RatchetJQSyncTimeoutError | null {
    if (!deadline?.aborted) {
      return null
    }

    this.logger.warn(`Stopped waiting on RatchetJQ job ${job.id} after ${timeoutSeconds}s during its ${stage} segment`)

    return new RatchetJQSyncTimeoutError(job.id, stage, timeoutSeconds)
  }

  /**
   * Reports the outcome this proposer already holds, and accepts it inline
   * (spec §4).
   *
   * The spec has the runner make this call over REST from inside its own
   * `SyncRun`, one level deeper in the nested chain. Here the runner answers with
   * the outcome instead, so the report is made in-process by the side that
   * received it — the same two writes and the same inline `SyncAccept`, with one
   * hop fewer and one less timeout to nest (spec §12-8).
   *
   * The synchronous form, because this is exactly the case it exists for: a
   * caller is waiting on the whole chain, so an accept that throws has to reach
   * it rather than be logged behind an answer that already said the job was done.
   * The row then stays `accepting` for lease expiry and the Scanner, with the
   * outcome already on it — so a caller treating that failure as fatal is
   * discarding a job that the next accept round will very likely complete.
   *
   * A report matching no `running` row means the Scanner got there first —
   * force-advanced or retried the row while the push was in flight — so there is
   * nothing to accept here and no reason to fail the caller: it asked for the
   * outcome, which it has, and that row's next round will offer one again.
   *
   * The deadline goes with it, and this is the hop that most needs one: the inline
   * round's heartbeat holds the accept lease for as long as the acceptor runs, so
   * without a bound an acceptor that never settles keeps both this caller and the
   * row it renews (`accept-round.ts:runInline`).
   */
  private async accept(
    job: RatchetJQJob,
    submission: RatchetJQJobSubmission,
    outcome: RatchetJQSyncRunOutcome,
    deadline?: AbortSignal,
  ): Promise<void> {
    const reported = await this.report.syncReport(
      submission.executor,
      submission.executorId,
      job.id,
      {
        status: this.asJobStatus(outcome.status, job),
        outParams: outcome.outParams,
        errMsg: outcome.errMsg,
      },
      deadline,
    )

    if (!reported) {
      this.logger.warn(
        `RatchetJQ job ${job.id} was no longer running when its own push reported it; leaving the accept to the Scanner`,
      )
    }
  }

  /**
   * Reads the executor's reported status as one this scheduler knows.
   *
   * Checked here because this is where a remote service's word enters the job
   * table: `status` is a Postgres enum, so an unknown value would fail the
   * report's UPDATE with a type error naming neither the job nor the executor
   * that sent it. The pulled path gets this from the report DTO's `@IsEnum`; this
   * is the pushed path's equivalent, and the reason ISyncJobExecutor keeps the
   * field a plain string.
   */
  private asJobStatus(status: string, job: RatchetJQJob): RatchetJQJobStatus {
    const known = Object.values(RatchetJQJobStatus) as string[]
    if (!known.includes(status)) {
      throw new Error(
        `Executor ${job.executor}/${job.executorId} reported RatchetJQ job ${job.id} with an unknown status "${status}"`,
      )
    }

    return status as RatchetJQJobStatus
  }
}
