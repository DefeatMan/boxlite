/*
 * Copyright 2026 BoxLite AI
 * SPDX-License-Identifier: AGPL-3.0
 */

import { Injectable, Logger } from '@nestjs/common'
import { InjectRepository } from '@nestjs/typeorm'
import { setTimeout as sleep } from 'timers/promises'
import { Repository } from 'typeorm'
import { RatchetJQJob } from '../entities/ratchetjq-job.entity'
import { RatchetJQJobPeriod } from '../enums/ratchetjq-job-period.enum'
import { RatchetJQAcceptFinalizer } from './accept-finalizer'
import { RatchetJQJobAcceptorRegistry } from './job-acceptor-registry'

/**
 * Floor on the heartbeat interval, so a row carrying a nonsensically small accept
 * budget cannot turn its renewal into a zero-delay interval against Postgres. Any
 * budget a submission can actually carry is a whole second or more
 * (`ratchetjq-proposer.service.ts:validate`), which renews at 500ms, so this only
 * ever applies to a row written by something other than that path.
 */
const MIN_HEARTBEAT_MS = 100

/**
 * One accept round: offer a reported outcome to its acceptor, then act on the
 * verdict (spec §4, §5, §9.2).
 *
 * It exists as one unit because three callers run the same round — a synchronous
 * `Report` accepting inline, an asynchronous one accepting with nobody waiting,
 * and the Scanner retrying an accept whose lease lapsed — and the parts they
 * share are the parts that are easy to get subtly different: what bounds the
 * wait, and that the acceptor is always told when nothing is listening for its
 * verdict any more.
 *
 * The acceptor is called directly. There is no driver in between, so an acceptor
 * runs on the stack of whoever started the round until its own first `await` —
 * which for an asynchronous `Report` is a request trying to return
 * (`ratchetjq-report.service.ts:asyncReport`). The contract carries that: an
 * acceptor decides by waiting on something, and one with real work to do before
 * it waits owes its caller a yield.
 *
 * What the two forms do *not* share is error policy, and that is the whole reason
 * there are two: an inline round's failure is the reporting executor's answer, so
 * it propagates, while an unattended round's failure has nobody to tell and is
 * logged with the row left `accepting` for its lease and the Scanner.
 *
 * Neither form decides anything about the job. The verdict comes from the
 * acceptor and the terminal writes are RatchetJQAcceptFinalizer's, so this class
 * only ever owns the round.
 */
@Injectable()
export class RatchetJQAcceptRound {
  private readonly logger = new Logger(RatchetJQAcceptRound.name)

  constructor(
    @InjectRepository(RatchetJQJob) private readonly jobRepository: Repository<RatchetJQJob>,
    private readonly acceptors: RatchetJQJobAcceptorRegistry,
    private readonly finalizer: RatchetJQAcceptFinalizer,
  ) {}

  /**
   * Run the round while the reporting executor waits on it (spec §4).
   *
   * Strict about one thing, because the caller is holding a request open and
   * would otherwise be told an accept had happened when it had not: the job type
   * must have an acceptor. It is not strict about how long that acceptor takes —
   * there is one accept form and it promises nothing about timing
   * (`job-acceptor.ts`), so the bound is the deadline the submitter set rather
   * than a property of the type.
   *
   * A heartbeat holds the accept lease for as long as the round runs, which is
   * what stops a Scanner retrying an accept that is merely slow. Nothing else
   * bounds the wait — that is the trade the heartbeat makes — so `abortSignal` is
   * what ends a round whose reporter has hung up. Without it a hung acceptor
   * would renew the lease forever and the row would never become retryable at
   * all, which is worse than the round failing.
   *
   * Anything that goes wrong throws and writes no terminal state: the heartbeat
   * stops, the error travels back to the executor, and the row stays `accepting`
   * for lease expiry plus the Scanner to push it into the next round.
   */
  async runInline(job: RatchetJQJob, abortSignal?: AbortSignal): Promise<void> {
    const acceptor = this.acceptors.acceptorFor(job.type)
    if (!acceptor) {
      throw new Error(`No RatchetJQ acceptor for job type "${job.type}"`)
    }

    const abandoned = this.abandonedWhen(abortSignal)
    const stopHeartbeat = this.startHeartbeat(job)

    try {
      const verdict = await Promise.race([
        acceptor.accept(job, abandoned.signal),
        this.reporterHungUp(job, abandoned.signal),
      ])

      await this.finalizer.finalize(job, verdict)
    } finally {
      stopHeartbeat()
      // Unconditional, on every exit, because every exit means the same thing:
      // this round is no longer waiting for that verdict. The path that needs it
      // most — a reporter that hung up on an acceptor still working — must not be
      // the path that forgets.
      abandoned.abort(new Error(`the accept of RatchetJQ job ${job.id} is no longer awaited`))
    }
  }

  /**
   * Run the round with nobody waiting on it (spec §5, §9.2).
   *
   * The same call as the inline round — there is one accept form — so what
   * separates the two is error policy and what bounds the wait, not which
   * acceptor they can reach. A type with no acceptor at all is left to its lease
   * rather than raised, exactly as the runner's poller leaves a type it cannot
   * build (`apps/runner/pkg/ratchetjq/poller.go:234`).
   *
   * The job's own accept budget bounds the wait, in place of the inline form's
   * heartbeat. Without it an acceptor that never settles would hold the round
   * open forever — costing the Scanner the force-advance duty it must not lose,
   * and leaving an asynchronous `Report` with an accept nothing can reclaim. A
   * verdict arriving after the bound is dropped rather than acted on: by then the
   * row is retryable and may already belong to a Scanner.
   *
   * Ending the wait is only half of that bound, and the weaker half. `Promise.race`
   * stops awaiting the loser, it does not stop the loser: an abandoned acceptor
   * keeps its query or request alive, so accepts in flight would grow by a whole
   * batch every budget while `ACCEPT_MAXN` capped only rows per round. The
   * controller is what closes it.
   *
   * Never rejects, which is what makes it safe to call without awaiting: an
   * asynchronous `Report` returns to its executor the moment the round starts, so
   * a rejection here would have no caller and would surface as an unhandled one.
   */
  async runUnattended(job: RatchetJQJob): Promise<void> {
    const acceptor = this.acceptors.acceptorFor(job.type)
    if (!acceptor) {
      this.logger.error(`No RatchetJQ acceptor for job type "${job.type}"; leaving job ${job.id} to its lease`)
      return
    }

    const abandoned = new AbortController()

    try {
      const verdict = await Promise.race([
        acceptor.accept(job, abandoned.signal),
        this.acceptBudgetLapse(job, abandoned.signal),
      ])

      await this.finalizer.finalize(job, verdict)
    } catch (error) {
      this.logger.error(
        `Accepting RatchetJQ job ${job.id} failed; leaving it in accepting: ${error.message}`,
        error.stack,
      )
    } finally {
      abandoned.abort(new Error(`the accept of RatchetJQ job ${job.id} is no longer awaited`))
    }
  }

  /**
   * This round's own controller, aborted either by the round ending or by the
   * caller's signal.
   *
   * One controller and not two signals handed around, because the acceptor
   * contract takes a single signal and the two reasons to stop are the same
   * reason to the acceptor: nobody is waiting any more.
   */
  private abandonedWhen(abortSignal?: AbortSignal): AbortController {
    const abandoned = new AbortController()
    if (!abortSignal) {
      return abandoned
    }
    if (abortSignal.aborted) {
      abandoned.abort(abortSignal.reason)
      return abandoned
    }

    abortSignal.addEventListener('abort', () => abandoned.abort(abortSignal.reason), { once: true })

    return abandoned
  }

  /**
   * Rejects once this round has been abandoned, which is how an inline accept
   * whose reporter hung up stops being waited on.
   *
   * It is raced against the accept rather than left to the acceptor, because an
   * acceptor that ignores its signal would otherwise keep the round — and its
   * heartbeat — alive after the request that wanted it had gone.
   */
  private async reporterHungUp(job: RatchetJQJob, signal: AbortSignal): Promise<never> {
    await new Promise<void>((resolve) => {
      if (signal.aborted) {
        resolve()
        return
      }
      signal.addEventListener('abort', () => resolve(), { once: true })
    })

    throw new Error(`nothing is waiting for the accept of RatchetJQ job ${job.id} any more`)
  }

  /**
   * Rejects once the job's accept budget is spent, which is how an unattended
   * accept that never settles loses its round.
   *
   * Unreferenced, so an accept that settled early does not hold the event loop
   * open for the rest of a budget nobody is waiting on, and it takes the round's
   * signal so that path clears the timer outright — without it every fast accept
   * would leave a timer and the row it closed over alive for a whole budget.
   */
  private async acceptBudgetLapse(job: RatchetJQJob, signal: AbortSignal): Promise<never> {
    await sleep(job.attlSeconds * 1000, undefined, { ref: false, signal })

    throw new Error(`the accept outlived its ${job.attlSeconds}s budget`)
  }

  /**
   * Holds the accept lease while an inline round runs, and hands back the way to
   * stop (spec §4, §8.1).
   *
   * Every `attlSeconds / 2` seconds, so a renewal always lands well inside the
   * lease it is renewing. Unreferenced for the reason Nest's shutdown gives: a
   * pending renewal would hold the event loop open for half a budget.
   *
   * A renewal that touches no row means the row has left `accepting` — someone
   * else's round finalized it — so there is no lease left to hold and the
   * heartbeat stops. The accept itself is not abandoned: the caller is still
   * waiting for a verdict, and an acceptor is idempotent by contract, so the
   * worst case is a decision that lands on an already-terminal row and no-ops.
   */
  private startHeartbeat(job: RatchetJQJob): () => void {
    const everyMs = Math.max(MIN_HEARTBEAT_MS, Math.floor(job.attlSeconds * 500))

    const timer = setInterval(() => {
      void this.renewAcceptLease(job)
        .then((held) => {
          if (!held) {
            this.logger.warn(`RatchetJQ job ${job.id} left accepting under its own accept; heartbeat stopped`)
            clearInterval(timer)
          }
        })
        .catch((error) => {
          // One missed renewal does not lose the lease — the next one lands
          // inside it — so a blip must not end a round that is still running.
          this.logger.warn(`Renewing the accept lease of RatchetJQ job ${job.id} failed: ${error.message}`)
        })
    }, everyMs)
    timer.unref()

    return () => clearInterval(timer)
  }

  /**
   * Pushes one row's accept lease back out to a full budget, and reports whether
   * the row was still `accepting` to push.
   *
   * `GREATEST` is what keeps renewal monotonic. The spec renews to
   * `now + attlSeconds` flat, but a row that has already been retried holds
   * `now + MAX(attlSeconds, attempt⁴)` (§8.1), so a flat write would *shorten*
   * the very lease this exists to hold — and would drop `leaseExpiresAt` below
   * `visibleAt`, the one invariant every other writer maintains (§12-3). A
   * renewal is not a new round, so it never re-applies the backoff term either;
   * it only ever refuses to move the deadline backwards.
   */
  private async renewAcceptLease(job: RatchetJQJob): Promise<boolean> {
    const renewed = await this.jobRepository.query(
      `WITH renewed AS (
         UPDATE "ratchetjq_job"
         SET "leaseExpiresAt" = GREATEST("leaseExpiresAt", now() + "attlSeconds" * interval '1 second')
         WHERE "id" = $1 AND "period" = $2
         RETURNING "id"
       )
       SELECT * FROM renewed`,
      [job.id, RatchetJQJobPeriod.ACCEPTING],
    )

    return renewed.length > 0
  }
}
