/*
 * Copyright 2026 BoxLite AI
 * SPDX-License-Identifier: AGPL-3.0
 */

import { InjectRedis } from '@nestjs-modules/ioredis'
import { Injectable, Logger } from '@nestjs/common'
import { InjectRepository } from '@nestjs/typeorm'
import { Redis } from 'ioredis'
import { Repository } from 'typeorm'
import { TypedConfigService } from '../../config/typed-config.service'
import { RatchetJQJob } from '../entities/ratchetjq-job.entity'
import { RatchetJQJobPeriod } from '../enums/ratchetjq-job-period.enum'
import { backoffElapsesAt, claimableAgainAt } from '../common/lease-sql'
import { RatchetJQJobStatus } from '../enums/ratchetjq-job-status.enum'

/**
 * What an executor reports for a job it finished (spec §9.1).
 *
 * A status and, when the job produces one, its output. Deliberately not the
 * failure case: an executor whose run failed has no status to report, and what
 * the control plane should do with that — retry sooner, record it, spend a round
 * — is a policy decision this statement cannot make on its own.
 */
export interface RatchetJQReportedOutcome {
  status: RatchetJQJobStatus
  outParams?: Record<string, unknown> | null
}

/**
 * TRANSFER — where claimed jobs come from (spec §6).
 *
 * An executor polls `claimJobs`; producers call `wakeup` to hint that work has
 * arrived. The hint is only a hint: it carries no payload, and losing one costs
 * at most `ratchetjq.maxBlockSeconds` of latency because the claim re-runs
 * against the database when the block ends, however it ends. That is what keeps
 * the pushed path from becoming a second source of truth.
 */
@Injectable()
export class RatchetJQTransferService {
  private readonly logger = new Logger(RatchetJQTransferService.name)

  constructor(
    @InjectRepository(RatchetJQJob) private readonly jobRepository: Repository<RatchetJQJob>,
    @InjectRedis() private readonly redis: Redis,
    private readonly configService: TypedConfigService,
  ) {}

  /**
   * Hint to one executor instance that it has work (spec §6).
   *
   * A failure is logged and swallowed: the job is already committed, so the
   * worst a lost hint costs is that the executor finds it on its next poll
   * rather than immediately.
   */
  async wakeup(executor: string, executorId: string): Promise<void> {
    try {
      await this.redis.rpush(this.hintKey(executor, executorId), 1)
    } catch (error) {
      this.logger.warn(`Failed to hint RatchetJQ executor ${executor}/${executorId}: ${error.message}`)
    }
  }

  /**
   * Hand this executor instance the jobs it may run now (spec §6.1).
   *
   * Runs the claim block; if that came back empty, blocks for a hint and runs
   * the *whole block* again — not just the half that moves new jobs along — so a
   * retry falling due while blocked is picked up in this call rather than the
   * next one.
   *
   * `ignoreLeaseExpire` is the restart reclaim of spec §6.3: on an executor's
   * first call after starting, take back its interrupted rows without waiting
   * out leases granted to the process that died.
   */
  async claimJobs(
    executor: string,
    executorId: string,
    limit: number,
    ignoreLeaseExpire = false,
    abortSignal?: AbortSignal,
  ): Promise<RatchetJQJob[]> {
    // The executor says how many it can take; the batch size is this side's own
    // ceiling on one statement, so the smaller of the two governs. Anything
    // beyond it is left for the next claim rather than handed over to a runner
    // that would have to refuse it after its lease had already been moved.
    const budget = Math.min(limit, this.configService.get('ratchetjq.claimBatchSize'))
    if (budget <= 0) {
      return []
    }

    const firstPass = await this.runClaimBlock(executor, executorId, budget, ignoreLeaseExpire)
    if (firstPass.length > 0) {
      return firstPass
    }
    if (abortSignal?.aborted) {
      return []
    }

    await this.blockForHint(executor, executorId, abortSignal)
    if (abortSignal?.aborted) {
      return []
    }

    return this.runClaimBlock(executor, executorId, budget, ignoreLeaseExpire)
  }

  /**
   * The claim block (spec §6.1, §9.3): two statements sharing one budget.
   *
   * `budget` is spent, not repeated: the first statement takes up to all of it,
   * and the second gets only what is left. When the first fills the budget the
   * second is not run at all — there is nothing it could be allowed to return.
   *
   * Which statement goes first is the whole of what `ignoreLeaseExpire` changes.
   * In steady state new work goes first, because a `pending_run` row has not had
   * its first round yet and should get started. On a restart, reclaiming
   * `running` goes first, because that reclaim is the one that costs no round
   * (spec §6.3) — spending the budget on new work instead would waste the free
   * round and leave interrupted jobs waiting out their leases.
   *
   * `SKIP LOCKED` means neither statement is guaranteed to have seen every
   * eligible row, so draining the queue means polling again rather than trusting
   * one pass (spec §6.4).
   */
  /**
   * Take one job's reported outcome and start its accept segment (spec §9.1).
   *
   * This is the write half of Report and nothing more: the row moves from
   * `running` to `accepting` carrying the status and output the executor gave it,
   * and it is left for an accept round to decide whether that outcome stands.
   * Whoever runs that round — a synchronous Report answering inline, or the
   * Scanner's retry — reads the row from here.
   *
   * The status is persisted because nothing else can: the finalizer completes a
   * job on `period` alone, so a row that reached `accepting` without a status
   * completes without one (`accept-finalizer.ts:48`).
   *
   * Guarded on `period = running` and on the executor pair, which is what makes
   * it safe to call twice and impossible to call for someone else's job: a second
   * report finds the row already `accepting` and changes nothing, and an executor
   * reporting a job it does not hold matches no row. Both come back as null
   * rather than an error, because the caller has something to say about each and
   * this statement cannot tell them apart.
   *
   * The three scheduling columns are written as a round already underway, and
   * plainly rather than through the retry formula: one whole `attlSeconds` of
   * accept lease, a `visibleAt` a second out, and `attempt = 2` (spec §3, §8.1,
   * §9.1). This is the accept segment's round 1 — the inline accept the caller
   * fires next — and round 1 has no backoff to serve, so `MAX(attlSeconds,
   * POW(attempt, 4))` would only obscure it.
   *
   * `attempt = 2` restarts the counter rather than carrying the execution
   * segment's over, which is what gives the accept segment its own budget of
   * rounds (spec §0: each segment has its own lease, retries and timeout). Two
   * things go wrong when it is carried over instead. The deadlines stop meaning
   * what they say — a row arriving with `attempt = 4` would take
   * `GREATEST(attlSeconds, 256)` of lease, so a 10s accept budget would be
   * un-retryable for four minutes. And a job whose execution needed every one of
   * its rounds would arrive already past `ATTEMPT_MAXN`, which no accept retry
   * will touch: its inline round would be the only one it ever got, and a single
   * failure there would see a run that actually succeeded retired as `timeout`
   * behind a rollback job.
   */
  async report(
    executor: string,
    executorId: string,
    jobId: string,
    outcome: RatchetJQReportedOutcome,
  ): Promise<RatchetJQJob | null> {
    const [job] = await this.jobRepository.query(
      `WITH reported AS (
         UPDATE "ratchetjq_job"
         SET "period" = $4,
             "status" = $5,
             "outParams" = $6,
             "leaseExpiresAt" = now() + "attlSeconds" * interval '1 second',
             "visibleAt" = now() + interval '1 second',
             "attempt" = 2
         WHERE "id" = $3 AND "executor" = $1 AND "executorId" = $2 AND "period" = $7
         RETURNING *
       )
       SELECT * FROM reported`,
      [
        executor,
        executorId,
        jobId,
        RatchetJQJobPeriod.ACCEPTING,
        outcome.status,
        outcome.outParams ?? null,
        RatchetJQJobPeriod.RUNNING,
      ],
    )
    if (!job) {
      this.logger.warn(`No running RatchetJQ job ${jobId} held by ${executor}/${executorId} to report against`)
      return null
    }

    return job
  }

  private async runClaimBlock(
    executor: string,
    executorId: string,
    budget: number,
    ignoreLeaseExpire: boolean,
  ): Promise<RatchetJQJob[]> {
    const first = ignoreLeaseExpire
      ? await this.reclaimAfterRestart(executor, executorId, budget)
      : await this.advancePendingRun(executor, executorId, budget)

    const remaining = budget - first.length
    if (remaining <= 0) {
      return first
    }

    const second = ignoreLeaseExpire
      ? await this.advancePendingRun(executor, executorId, remaining)
      : await this.retryExpiredLeases(executor, executorId, remaining)

    return [...first, ...second]
  }

  /**
   * `pending_run` → `running`, identical in both modes (spec §6.3, §9.3).
   *
   * `attempt` becomes 2 because handing the job to an executor *is* the first
   * round (spec §2.2). Round one's deadlines are written plainly rather than
   * through the general formula: `MAX(ttlSeconds, POW(1, 4))` is just
   * `ttlSeconds` for any budget above a second, so the `MAX` would only obscure
   * what this statement does (spec §8.1).
   */
  private async advancePendingRun(executor: string, executorId: string, budget: number): Promise<RatchetJQJob[]> {
    return this.claimWith(
      `SET "period" = $4,
           "leaseExpiresAt" = now() + "ttlSeconds" * interval '1 second',
           "visibleAt" = now() + interval '1 second',
           "attempt" = 2`,
      `WHERE "executor" = $1 AND "executorId" = $2 AND "period" = $3
             AND "leaseExpiresAt" <= now()
       ORDER BY "pr" ASC, "leaseExpiresAt" ASC`,
      [executor, executorId, RatchetJQJobPeriod.PENDING_RUN, RatchetJQJobPeriod.RUNNING],
      budget,
    )
  }

  /**
   * Steady-state retry (spec §6.3): a `running` row whose turn has come round
   * again is handed over once more and charged a round.
   *
   * The predicate reads `leaseExpiresAt` alone, which is what collapsing lease
   * and backoff into that column buys — one comparison answers both "might
   * anyone else still hold this" and "has the backoff elapsed" (spec §2.3).
   */
  private async retryExpiredLeases(executor: string, executorId: string, budget: number): Promise<RatchetJQJob[]> {
    return this.claimWith(
      `SET "leaseExpiresAt" = ${claimableAgainAt('ttlSeconds', '"attempt"')},
           "visibleAt" = ${backoffElapsesAt('"attempt"')},
           "attempt" = "attempt" + 1`,
      `WHERE "executor" = $1 AND "executorId" = $2 AND "period" = $3
             AND "leaseExpiresAt" <= now()
             AND "attempt" <= $4
       ORDER BY "pr" ASC, "leaseExpiresAt" ASC`,
      [executor, executorId, RatchetJQJobPeriod.RUNNING, this.configService.get('ratchetjq.attemptMaxN')],
      budget,
    )
  }

  /**
   * Restart reclaim (spec §6.3): take back this executor's interrupted rows
   * without waiting out their leases, and without charging a round for it.
   *
   * A process restart is not a failed attempt, so `attempt` is left alone —
   * otherwise an executor restarting ATTEMPT_MAXN times would time its own jobs
   * out with nothing having gone wrong — and both deadlines replay the round
   * that was interrupted, `attempt - 1`, instead of advancing a step.
   *
   * The predicate reads `visibleAt` rather than `leaseExpiresAt`, which is the
   * whole reason that column survives the merge: skipping the lease would skip
   * the backoff with it, and this mode must ignore leases while still honouring
   * backoff. The ordering follows `visibleAt` too, so `visibleIdx` serves both
   * predicate and sort. It is the one writer not ordering by `leaseExpiresAt`,
   * which is safe because `FOR UPDATE SKIP LOCKED` never waits on a lock and so
   * cannot close a cycle with another statement (spec §6.4).
   */
  private async reclaimAfterRestart(executor: string, executorId: string, budget: number): Promise<RatchetJQJob[]> {
    return this.claimWith(
      `SET "leaseExpiresAt" = ${claimableAgainAt('ttlSeconds', '"attempt" - 1')},
           "visibleAt" = ${backoffElapsesAt('"attempt" - 1')}`,
      `WHERE "executor" = $1 AND "executorId" = $2 AND "period" = $3
             AND "visibleAt" <= now()
             AND "attempt" <= $4
       ORDER BY "pr" ASC, "visibleAt" ASC`,
      [executor, executorId, RatchetJQJobPeriod.RUNNING, this.configService.get('ratchetjq.attemptMaxN')],
      budget,
    )
  }

  /**
   * Runs one claim statement: a batch is picked `FOR UPDATE SKIP LOCKED`, those
   * rows are rewritten, and the whole thing is wrapped in a CTE so the driver
   * returns rows rather than the `[rows, affectedCount]` tuple a bare
   * `UPDATE … RETURNING` comes back as.
   *
   * `SKIP LOCKED` is what stops two executors — or an executor and the Scanner —
   * queueing behind each other on one row instead of moving on to rows they can
   * have. The `ORDER BY` inside `selection` sets scheduling priority and also
   * makes writers take locks in a consistent order.
   */
  private async claimWith(
    assignments: string,
    selection: string,
    parameters: unknown[],
    budget: number,
  ): Promise<RatchetJQJob[]> {
    const budgetParameter = `$${parameters.length + 1}`

    return this.jobRepository.query(
      `WITH claimed AS (
         UPDATE "ratchetjq_job"
         ${assignments}
         WHERE "id" IN (
           SELECT "id" FROM "ratchetjq_job"
           ${selection}
           LIMIT ${budgetParameter}
           FOR UPDATE SKIP LOCKED
         )
         RETURNING *
       )
       SELECT * FROM claimed`,
      [...parameters, budget],
    )
  }

  /**
   * Waits for a hint, for no longer than the next job is away (spec §6.1, §6.2).
   *
   * `DEL` first, so the wait is edge-triggered: it returns for work pushed after
   * it started rather than for a hint left behind by a row some other claim has
   * already taken.
   */
  private async blockForHint(executor: string, executorId: string, abortSignal?: AbortSignal): Promise<void> {
    const key = this.hintKey(executor, executorId)

    try {
      await this.redis.del(key)
    } catch (error) {
      this.logger.warn(`Failed to clear the RatchetJQ hint for ${executor}/${executorId}: ${error.message}`)
    }

    const blockSeconds = await this.nextClaimableInSeconds(executor, executorId)
    // Zero means a row is due already — it was only passed over by SKIP LOCKED —
    // so re-run the claim at once. It must not reach BRPOP, where a timeout of 0
    // means block forever rather than do not wait (spec §6.2).
    if (blockSeconds === 0) {
      return
    }

    // Null means this executor has nothing upcoming at all. Blocking for the
    // full cap is still right: a job submitted a moment from now pushes a hint
    // that ends the wait immediately, so the pushed path keeps working for an
    // executor that happens to be idle.
    await this.blockOnHintKey(key, blockSeconds ?? this.maxBlockSeconds(), abortSignal)
  }

  /**
   * How long until this executor's next row may be claimed, in seconds, or null
   * when it has no upcoming work at all (spec §6.2).
   *
   * One round trip does all four steps — take the earlier of the two stages'
   * next claimable moments, subtract now, clamp to [0, cap], convert to seconds.
   * `GREATEST` catches the negative left by a row already due and `LEAST` applies
   * the cap, which has to be a minimum or "a job in five seconds" would be
   * stretched into a full-cap sleep. Both subqueries read `leaseExpiresAt`, the
   * same column the claim predicates compare, so this is the exact next moment
   * and not a lower bound that could disagree with them.
   *
   * The `CASE` is load-bearing and departs from the spec's expression. Postgres
   * `GREATEST`/`LEAST` *ignore* nulls rather than propagating them, so
   * `GREATEST(nxt - now(), interval '0')` yields `interval '0'` — not null — when
   * there is no next row, which would collapse "nothing upcoming" into "a row is
   * due now" and spin an idle executor through the claim instead of letting it
   * block. Only the inner `LEAST` over the two stages relies on nulls being
   * skipped, and there that is exactly what is wanted.
   */
  private async nextClaimableInSeconds(executor: string, executorId: string): Promise<number | null> {
    const rows: Array<{ seconds: string | null }> = await this.jobRepository.query(
      `SELECT CASE
                WHEN t.nxt IS NULL THEN NULL
                ELSE EXTRACT(EPOCH FROM LEAST(GREATEST(t.nxt - now(), interval '0'), make_interval(secs => $5)))
              END AS seconds
       FROM (
         SELECT LEAST(
           (SELECT min("leaseExpiresAt") FROM "ratchetjq_job"
              WHERE "executor" = $1 AND "executorId" = $2 AND "period" = $3),
           (SELECT min("leaseExpiresAt") FROM "ratchetjq_job"
              WHERE "executor" = $1 AND "executorId" = $2 AND "period" = $4)
         ) AS nxt
       ) t`,
      [executor, executorId, RatchetJQJobPeriod.PENDING_RUN, RatchetJQJobPeriod.RUNNING, this.maxBlockSeconds()],
    )

    const seconds = rows[0]?.seconds
    if (seconds === null || seconds === undefined) {
      return null
    }

    return Number(seconds)
  }

  /**
   * Blocks on the hint list, on a connection of its own.
   *
   * BRPOP occupies whichever connection runs it, so the shared client cannot be
   * used — one polling executor would stall every other command on it. The
   * connection is closed on every path, including abort, which is also how the
   * wait is cancelled when the polling executor hangs up.
   */
  private async blockOnHintKey(key: string, timeoutSeconds: number, abortSignal?: AbortSignal): Promise<void> {
    let blockingClient: Redis | null = null

    try {
      blockingClient = this.redis.duplicate({
        commandTimeout: timeoutSeconds * 1000 + this.configService.get('ratchetjq.blockingCommandTimeoutBufferMs'),
        retryStrategy: () => null,
      })

      const popped = blockingClient.brpop(key, timeoutSeconds)
      if (!abortSignal) {
        await popped
        return
      }

      await Promise.race([
        popped,
        new Promise<void>((resolve) => {
          if (abortSignal.aborted) {
            resolve()
          } else {
            abortSignal.addEventListener('abort', () => resolve(), { once: true })
          }
        }),
      ])
    } catch (error) {
      // A hint that never arrives is indistinguishable from one that arrives
      // late, and the caller re-runs the claim either way, so a Redis failure
      // degrades this to plain polling instead of failing the request.
      this.logger.warn(`RatchetJQ hint wait on ${key} failed: ${error.message}`)
    } finally {
      blockingClient?.disconnect()
    }
  }

  /**
   * The cap on one wait, read in one place because it is used twice and the two
   * uses have to agree: SQL clamps the computed wait to it, and a wait with
   * nothing upcoming falls back to it. Two different values there would let a
   * clamped wait exceed the fallback, or the reverse.
   */
  private maxBlockSeconds(): number {
    return this.configService.get('ratchetjq.maxBlockSeconds')
  }

  /**
   * The hint list for one executor instance. Lower-case by convention: every
   * Redis key in this project is, whatever case the name carries in prose.
   */
  private hintKey(executor: string, executorId: string): string {
    return `ratchetjq:${executor}:${executorId}`
  }
}
