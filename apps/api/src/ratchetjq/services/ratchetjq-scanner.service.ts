/*
 * Copyright 2026 BoxLite AI
 * SPDX-License-Identifier: AGPL-3.0
 */

import { Injectable, Logger, OnApplicationShutdown } from '@nestjs/common'
import { InjectRepository } from '@nestjs/typeorm'
import { randomUUID } from 'crypto'
import { setTimeout as sleep } from 'timers/promises'
import { Repository } from 'typeorm'
import { TypedConfigService } from '../../config/typed-config.service'
import { RatchetJQAcceptFinalizer } from '../common/accept-finalizer'
import { RatchetJQAcceptRound } from '../common/accept-round'
import { backoffElapsesAt, claimableAgainAt } from '../common/lease-sql'
import { RatchetJQScannerPool } from '../common/scanner-pool'
import { RatchetJQJob } from '../entities/ratchetjq-job.entity'
import { RatchetJQJobPeriod } from '../enums/ratchetjq-job-period.enum'

/**
 * The Scanner (spec §7, §9.2): the global backstop that advances jobs no
 * executor is pulling, and the only thing that ever retries an accept.
 *
 * `ClaimJobs` only runs when a runner comes to pull, so a runner that has gone
 * silent leaves its jobs sitting. This loop is the only thing that notices. It
 * is deliberately not a cron: it holds a slot in a Redis-backed pool bracketed
 * by a floor and a ceiling, so a service with many processes runs a few Scanners
 * rather than one per process, and never zero.
 *
 * One round does four things, and they divide by what a row still has left. The
 * two sweeps go first and take the rows with nothing left: `attempt` past the
 * ceiling and the last round over, so they are retired as `timeout` behind a
 * rollback job. Force-advance and the accept retry then take rows that still have
 * a round to spend — each tests `attempt <= ATTEMPT_MAXN`, which is what keeps
 * the two groups disjoint and the sweeps the only exit from a spent job.
 *
 * The one sweep this Scanner does not do is `ClaimJobs`'s own (spec §9.3), which
 * retires spent `running` rows for one executor as it pulls. These two are global,
 * so nothing is missed without it; it only means a spent job is retired on the
 * Scanner's cadence rather than on the runner's next poll.
 *
 * How an accept round itself runs is deliberately not here. It is
 * RatchetJQAcceptRound's, because this loop is one of three callers that run the
 * same round and the differences between them are error policy, not mechanism.
 */
@Injectable()
export class RatchetJQScannerService implements OnApplicationShutdown {
  private readonly logger = new Logger(RatchetJQScannerService.name)

  /**
   * This process's identity in the pool. Generated per process, because the pool
   * grants one slot per process and a shared id would let two processes fight
   * over one field.
   */
  private readonly proposerId = randomUUID()

  /** The running loop, kept so shutdown can wait for it to finish its round. */
  private loop: Promise<void> | null = null
  private renewalTimer: NodeJS.Timeout | null = null

  /**
   * The process is going away. Deliberately only that: it is never set by
   * anything a single run can hit, because it is never unset. A run that has to
   * stop — the slot lost under it — aborts its own controller instead, so the
   * process stays able to host the next Scanner. Conflating the two is how a
   * process that lost one slot stops answering wake-ups for good, and since a
   * wake-up is the only thing that ever refills the pool, enough processes doing
   * that leaves no global backstop at all.
   */
  private isStopping = false

  constructor(
    @InjectRepository(RatchetJQJob) private readonly jobRepository: Repository<RatchetJQJob>,
    private readonly pool: RatchetJQScannerPool,
    private readonly configService: TypedConfigService,
    private readonly acceptRound: RatchetJQAcceptRound,
    private readonly finalizer: RatchetJQAcceptFinalizer,
  ) {}

  /**
   * Starts a Scanner on this process if the pool will have one (spec §7).
   *
   * This is the only thing that ever grows the pool, and the only thing that
   * refills a slot freed by a crash — nothing tops the pool up on a timer — so it
   * belongs on the path that creates work, which is where a report calls it.
   *
   * Returns whether a Scanner was started, which is for tests and logging; a
   * caller reporting a job outcome has nothing to do with the answer.
   */
  async scannerWakeup(): Promise<boolean> {
    if (this.isStopping || this.loop) {
      return false
    }
    if (!(await this.pool.acquire(this.proposerId))) {
      return false
    }

    // Scoped to this run and no wider: whatever ends it — the slot lost, the
    // renewal giving up — ends one Scanner, not this process's ability to host
    // another.
    const run = new AbortController()

    this.scheduleRenewal(run)
    // Deliberately not awaited: the loop outlives the report that woke it. It
    // owns its own failures, so nothing here can turn into an unhandled
    // rejection, and it clears `this.loop` on the way out so a later wake-up can
    // start a fresh one.
    this.loop = this.runUntilRetired(run.signal).finally(() => {
      this.loop = null
    })
    this.logger.log(`RatchetJQ Scanner started as ${this.proposerId}`)

    return true
  }

  /**
   * Stops the loop and gives the slot back, so a rolling deploy frees pool room
   * at once instead of leaving it to lapse.
   */
  async onApplicationShutdown(): Promise<void> {
    this.isStopping = true
    this.clearRenewal()

    if (this.loop) {
      await this.loop
    }
    await this.pool.release(this.proposerId)
  }

  /**
   * The loop (spec §7, §9.2). Runs rounds until this Scanner has idled out and
   * the pool can spare it.
   *
   * Every round is guarded, because this runs unattended: a failing round must
   * not end the only global backstop, and must not spin on the failure either,
   * which is why a failure rests exactly like an empty round.
   */
  private async runUntilRetired(signal: AbortSignal): Promise<void> {
    let consecutiveEmptyRounds = 0

    while (!this.isStopping && !signal.aborted) {
      let advanced = 0
      try {
        advanced = await this.runRound(signal)
      } catch (error) {
        this.logger.error(`RatchetJQ Scanner round failed: ${error.message}`, error.stack)
      }

      if (advanced > 0) {
        // A productive round clears the counter, so the limit counts consecutive
        // idle rounds and never retires a Scanner that is mostly busy.
        consecutiveEmptyRounds = 0
      } else {
        consecutiveEmptyRounds += 1

        if (
          consecutiveEmptyRounds >= this.configService.get('ratchetjq.emptyRoundLimit') &&
          (await this.pool.isAboveFloor())
        ) {
          this.logger.log(`RatchetJQ Scanner ${this.proposerId} retiring: idle and the pool is above its floor`)
          break
        }
      }

      // Rest after every unproductive round, including one that idled out at the
      // floor. The spec's loop tail rests only inside the counting branch, which
      // leaves a Scanner at the floor rescanning with no delay at all — a busy
      // poll against Postgres in exactly the state where one Scanner is all
      // there is. The spec names this as the fix in §12-10: let the limit and
      // the floor decide whether to exit, never whether to rest.
      if (advanced === 0) {
        await sleep(this.configService.get('ratchetjq.emptyRoundSleepMs'))
      }
    }

    this.clearRenewal()
    await this.pool.release(this.proposerId)
  }

  /**
   * One round of scanning. Returns how many rows it moved, which is what decides
   * whether the round counted as productive.
   */
  private async runRound(signal: AbortSignal): Promise<number> {
    // The sweeps go first, in the spec's own order (§9.2). Nothing depends on it
    // for correctness — every statement below tests `attempt <= MAXN`, so none of
    // them would touch a row the sweeps are for — but a row that has just run out
    // of rounds is retired in the round it became eligible rather than the next.
    const retiredRunning = await this.sweepExhausted(RatchetJQJobPeriod.RUNNING)
    const retiredAccepting = await this.sweepExhausted(RatchetJQJobPeriod.ACCEPTING)
    const started = await this.forceAdvancePendingRun()
    const retried = await this.forceAdvanceRunning()
    const accepted = await this.retryAccepting(signal)

    return retiredRunning + retiredAccepting + started + retried + accepted
  }

  /**
   * Retire the jobs in one stage whose rounds are used up (spec §8.5 triggers 1
   * and 2, §9.2): queue each one's rollback job, then close it as `timeout`.
   *
   * This is the only thing that ever writes `status = timeout`, and the only exit
   * for a job every other statement here has stopped touching: force-advance and
   * both retries test `attempt <= MAXN`, so past that a row would sit in `running`
   * or `accepting` forever without this. `pending_run` is deliberately not swept —
   * it is never abandoned directly, which is exactly why the `pending_run`
   * force-advance exists to move a silent runner's jobs into `running` first
   * (§8.3).
   *
   * The predicate is the two conditions together. `attempt > MAXN` alone would
   * retire a job whose current round is still running: the counter names the
   * *next* round (§2.2), so a job on its last round already carries a number past
   * the ceiling. Waiting for `leaseExpiresAt <= now()` as well is what makes this
   * "the rounds are used up *and* the last one is over".
   *
   * It runs in a transaction, unlike the statements below it, because the work per
   * row is not one statement: a rollback job is created between reading the row
   * and closing it, and the row has to stay put across that gap. `FOR UPDATE`
   * holds it — a report arriving mid-sweep waits and then finds the row no longer
   * `running` — and `SKIP LOCKED` keeps two Scanners off each other's rows rather
   * than queueing them. The batch is `{N}` like the force-advance statements, and
   * the rows are retired one at a time: the transaction holds locks for its whole
   * length, so this trades a slower round for a shorter reach, and there is no
   * reason to fan out work whose whole cost is two small statements.
   */
  private async sweepExhausted(period: RatchetJQJobPeriod): Promise<number> {
    return this.jobRepository.manager.transaction(async (transaction) => {
      const exhausted: RatchetJQJob[] = await transaction.query(
        `SELECT * FROM "ratchetjq_job"
         WHERE "period" = $1 AND "leaseExpiresAt" <= now() AND "attempt" > $2
         ORDER BY "pr" ASC, "leaseExpiresAt" ASC
         LIMIT $3
         FOR UPDATE SKIP LOCKED`,
        [period, this.configService.get('ratchetjq.attemptMaxN'), this.configService.get('ratchetjq.claimBatchSize')],
      )

      let retired = 0
      for (const job of exhausted) {
        try {
          await this.finalizer.retire(job, transaction)
          retired += 1
        } catch (error) {
          // One row's rollback failing must not cost the rest of the batch their
          // retirement: the row keeps its expired lease and its spent rounds, so
          // the next sweep finds it again.
          this.logger.error(
            `Retiring RatchetJQ job ${job.id} failed; leaving it for the next sweep: ${error.message}`,
            error.stack,
          )
        }
      }

      return retired
    })
  }

  /**
   * Force-advance `pending_run → running` (spec §8.3).
   *
   * It looks wrong — no executor has actually begun — but it is the only route by
   * which a silent runner's jobs ever reach rollback: the sweeps recognise
   * `running` and `accepting` only, and a `pending_run` row is never abandoned.
   *
   * Both deadlines are set to `now()`, clearing lease and backoff together,
   * because the point is to make the row claimable immediately. The throttle is
   * `TIME_TO_FORCE`, not the backoff: the trigger needs the lease to have been
   * dead that long, so one row can be pushed at most once per interval.
   */
  private async forceAdvancePendingRun(): Promise<number> {
    const forced = await this.advanceWith(
      `SET "period" = $2, "leaseExpiresAt" = now(), "visibleAt" = now(), "attempt" = 2`,
      `WHERE "period" = $1 AND "leaseExpiresAt" <= now() - make_interval(secs => $3)`,
      `AND "period" = $1`,
      [RatchetJQJobPeriod.PENDING_RUN, RatchetJQJobPeriod.RUNNING, this.timeToForceSeconds()],
      this.configService.get('ratchetjq.claimBatchSize'),
    )

    return forced.length
  }

  /**
   * Force-advance `running → running` (spec §8.3).
   *
   * Fires a further `TIME_TO_FORCE` after the lease has already expired, so a job
   * being executed normally is never disturbed — the target is only "the lease
   * has been dead this long and its owner still has not come back for it".
   */
  private async forceAdvanceRunning(): Promise<number> {
    const forced = await this.advanceWith(
      `SET "leaseExpiresAt" = now(), "visibleAt" = now(), "attempt" = "attempt" + 1`,
      `WHERE "period" = $1 AND "leaseExpiresAt" <= now() - make_interval(secs => $2)
             AND "attempt" <= $3`,
      `AND "period" = $1 AND "attempt" <= $3`,
      [RatchetJQJobPeriod.RUNNING, this.timeToForceSeconds(), this.configService.get('ratchetjq.attemptMaxN')],
      this.configService.get('ratchetjq.claimBatchSize'),
    )

    return forced.length
  }

  /**
   * Retry the accept segment (spec §9.2): take an `accepting` row whose accept
   * lease has expired, charge it a round, and offer the outcome to its acceptor
   * again.
   *
   * There is no `TIME_TO_FORCE` grace here, unlike the two force-advance
   * statements, and the difference is who holds the lease. A `running` lease
   * belongs to a remote executor, so the grace is what stops the Scanner
   * disturbing one that is merely slow. An `accepting` lease belongs to a
   * proposer, and a proposer that has not settled by its own deadline has nothing
   * to be given extra time for.
   *
   * Deadlines follow the general formula rather than being cleared to `now()`:
   * this statement is taking the round, not making the row available to someone
   * else, so it holds `attlSeconds` of accept lease for the accept it is about to
   * run (spec §2.3).
   *
   * `ACCEPT_MAXN` and not the claim batch, even though the two force-advance
   * statements above use the batch. A row taken here is not just a row rewritten:
   * it is an acceptor about to run and a write about to be issued, and they all
   * run at once. The connection pool is ten by default, shared with every HTTP
   * request, and the Scanner pool allows four of these loops — so a batch of a
   * hundred would put four hundred acceptors in front of user traffic. This repo
   * has been here before, with an unbounded fan-out over pending rows at
   * pool-size concurrency (`box-migration.manager.spec.ts:244`).
   *
   * The ceiling is spent by taking fewer rows rather than by queueing a full
   * batch behind a semaphore, which is how the runner's poller spends its own
   * gate — `p.claim(ctx, cap(p.slots), true)`
   * (`apps/runner/pkg/ratchetjq/poller.go:134`). The difference matters here: the
   * lease is written by this statement, so a row waiting its turn in a queue
   * would be spending an accept budget its accept had not started using.
   */
  private async retryAccepting(signal: AbortSignal): Promise<number> {
    // A run whose slot is gone stops taking accepts for the same reason it stops
    // scanning: the pool has stopped counting it, so another Scanner may already
    // be working the same rows.
    if (this.isStopping || signal.aborted) {
      return 0
    }

    const retried = await this.advanceWith(
      `SET "leaseExpiresAt" = ${claimableAgainAt('attlSeconds', '"attempt"')},
           "visibleAt" = ${backoffElapsesAt('"attempt"')},
           "attempt" = "attempt" + 1`,
      `WHERE "period" = $1 AND "leaseExpiresAt" <= now()
             AND "attempt" <= $2`,
      `AND "period" = $1 AND "attempt" <= $2`,
      [RatchetJQJobPeriod.ACCEPTING, this.configService.get('ratchetjq.attemptMaxN')],
      this.configService.get('ratchetjq.acceptMaxN'),
    )
    if (retried.length === 0) {
      return 0
    }

    // Waiting for the batch is the other half of the bound. A productive round
    // does not rest, and the leases just written stop the next statement
    // re-picking these rows, so a loop that dispatched and moved on would keep
    // finding a fresh batch and leave `ACCEPT_MAXN` meaning nothing. Every
    // dispatch is itself bounded, so this can only take one accept budget.
    await Promise.all(retried.map((job) => this.acceptRound.runUnattended(job)))

    return retried.length
  }

  /**
   * Runs one advancing statement and returns the rows it moved.
   *
   * `recheck` repeats the selection's own predicate on the UPDATE, which the spec
   * asks for so the write can never apply to a row that stopped qualifying. The
   * rows are already locked by `FOR UPDATE SKIP LOCKED`, so it is belt and
   * braces rather than the thing that makes this safe — what it does buy is that
   * the statement stays correct if the lock is ever relaxed.
   *
   * Wrapped in a CTE for the same reason the claim statements are: a bare
   * `UPDATE … RETURNING` comes back from the driver as a tuple, not as rows.
   *
   * `RETURNING *` rather than the ids the force-advance statements need, because
   * the accept retry has to hand whole jobs to their acceptors, and one shape for
   * both keeps the CTE and its recheck in one place.
   */
  private async advanceWith(
    assignments: string,
    selection: string,
    recheck: string,
    parameters: unknown[],
    budget: number,
  ): Promise<RatchetJQJob[]> {
    const budgetParameter = `$${parameters.length + 1}`

    return this.jobRepository.query(
      `WITH advanced AS (
         UPDATE "ratchetjq_job"
         ${assignments}
         WHERE "id" IN (
           SELECT "id" FROM "ratchetjq_job"
           ${selection}
           ORDER BY "pr" ASC, "leaseExpiresAt" ASC
           LIMIT ${budgetParameter}
           FOR UPDATE SKIP LOCKED
         )
         ${recheck}
         RETURNING *
       )
       SELECT * FROM advanced`,
      [...parameters, budget],
    )
  }

  /**
   * Keeps this run's slot alive, and ends the run if it ever lost it.
   *
   * A renewal that reports the slot gone means this process stalled past the TTL
   * and the pool has already stopped counting it — possibly having handed the
   * room to someone else — so continuing would scan uncounted and defeat the
   * ceiling. It ends that run and nothing more: the process is healthy, and the
   * next wake-up should be free to acquire a fresh slot. Only shutdown makes a
   * process stop hosting Scanners, which is why the abort goes to the run's
   * controller and never to `isStopping`.
   */
  private scheduleRenewal(run: AbortController, delayMs = this.renewSeconds() * 1000): void {
    if (run.signal.aborted || this.isStopping) {
      return
    }

    this.renewalTimer = setTimeout(() => {
      void this.pool
        .renew(this.proposerId)
        .then((held) => {
          if (!held) {
            this.logger.warn(`RatchetJQ Scanner ${this.proposerId} lost its pool slot; ending this run`)
            run.abort(new Error(`RatchetJQ Scanner ${this.proposerId} lost its pool slot`))
            return
          }
          this.scheduleRenewal(run)
        })
        .catch((error) => {
          // Redis being briefly unreachable must not stop the backstop: the slot
          // outlives one missed renewal, so try again — but inside what is left of
          // it, not a whole renewal period later, which would land past the
          // deadline and lose the slot to one blip.
          this.logger.warn(`Renewing the RatchetJQ Scanner slot failed: ${error.message}`)
          this.scheduleRenewal(run, this.renewRetryDelayMs())
        })
    }, delayMs)

    // Nest waits for the event loop to drain on shutdown, and a pending renewal
    // would hold it open for a whole renewal period.
    this.renewalTimer.unref()
  }

  private renewSeconds(): number {
    return this.configService.get('ratchetjq.scannerSlotRenewSeconds')
  }

  /**
   * How soon to try again after a renewal that failed to reach Redis.
   *
   * Half of what the slot has left, so a blip costs an attempt rather than the
   * slot. Retrying after another full renewal period is what makes the comment
   * above false: against the defaults — renew at 25s, TTL 30s — the second
   * attempt would land at 50s, twenty seconds after the field lapsed and any
   * other proposer's purge could delete it, so a single failed renewal would end
   * the run.
   */
  private renewRetryDelayMs(): number {
    const remainingMs = (this.configService.get('ratchetjq.scannerSlotTtlSeconds') - this.renewSeconds()) * 1000

    return Math.max(1_000, Math.floor(remainingMs / 2))
  }

  private clearRenewal(): void {
    if (this.renewalTimer) {
      clearTimeout(this.renewalTimer)
      this.renewalTimer = null
    }
  }

  private timeToForceSeconds(): number {
    return this.configService.get('ratchetjq.timeToForceSeconds')
  }
}
