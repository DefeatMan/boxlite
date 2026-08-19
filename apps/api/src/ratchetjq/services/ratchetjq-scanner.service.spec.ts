/*
 * Copyright 2026 BoxLite AI
 * SPDX-License-Identifier: AGPL-3.0
 */

import { RatchetJQAcceptRound } from '../common/accept-round'
import { IJobAcceptor, RatchetJQAcceptVerdict } from '../common/job-acceptor'
import { RatchetJQJob } from '../entities/ratchetjq-job.entity'
import { RatchetJQJobPeriod } from '../enums/ratchetjq-job-period.enum'
import { RatchetJQScannerService } from './ratchetjq-scanner.service'

const ATTEMPT_MAX_N = 5
const CLAIM_BATCH_SIZE = 100
// Deliberately not CLAIM_BATCH_SIZE: the accept statement asserts on this one, so
// the two must differ for that assertion to mean anything.
const ACCEPT_MAX_N = 16
const EMPTY_ROUND_LIMIT = 3
const TIME_TO_FORCE_SECONDS = 60

const CONFIG: Record<string, number> = {
  'ratchetjq.attemptMaxN': ATTEMPT_MAX_N,
  'ratchetjq.claimBatchSize': CLAIM_BATCH_SIZE,
  'ratchetjq.acceptMaxN': ACCEPT_MAX_N,
  'ratchetjq.emptyRoundLimit': EMPTY_ROUND_LIMIT,
  // Zero keeps the tests quick; the loop still has to take the rest branch to
  // read it, which is what the at-the-floor test asserts on.
  'ratchetjq.emptyRoundSleepMs': 0,
  'ratchetjq.scannerSlotRenewSeconds': 25,
  'ratchetjq.scannerSlotTtlSeconds': 30,
  'ratchetjq.timeToForceSeconds': TIME_TO_FORCE_SECONDS,
}

/** Resolves after the event loop has turned, which is where the loop's own exit runs. */
function loopTurn(): Promise<void> {
  return new Promise((resolve) => setImmediate(resolve))
}

/**
 * The statements one round runs on the shared connection, in `runRound`'s order:
 * force-advance `pending_run`, force-advance `running`, retry `accepting`. The
 * round's two sweeps are not among them — each opens its own transaction, so they
 * are counted by `sweepSelects` instead.
 */
const STATEMENTS_PER_ROUND = 3

/**
 * Builds the Scanner over stubs.
 *
 * `rows` is what each successive statement on the shared connection returns, as
 * row arrays; three of those run per round — force-advance `pending_run`,
 * force-advance `running`, retry `accepting` — so entries are consumed in threes.
 * The sweeps answer from `sweeps`, on their own connection.
 *
 * `acceptors` is the registry's contents by job type, and `finalize` stands in for
 * the terminal writes, which have their own spec. `aboveFloor` answers the pool
 * floor check, and `retired` resolves when the loop has given its slot back —
 * which is how a test waits for a loop that `scannerWakeup` deliberately does not
 * await.
 */
function makeScanner(options: {
  acquire?: boolean
  rows?: Array<Array<Partial<RatchetJQJob>>>
  acceptors?: Record<string, IJobAcceptor>
  aboveFloor?: boolean[]
  failRounds?: number
  // What each successive renewal answers: true still holds the slot, false lost
  // it, an Error could not reach Redis. Renewals past the end of the list hold.
  renewals?: Array<boolean | Error>
  // Zero fires the renewal on the next tick, which is the only way a test running
  // on real timers reaches the renewal paths at all.
  renewSeconds?: number
  // What each successive sweep SELECT returns, `running` then `accepting` per
  // round. Kept apart from `rows` because the sweeps genuinely run on another
  // connection — their own transaction — so a test that does not care about them
  // sequences `rows` against the three global scans exactly as before.
  sweeps?: Array<Array<Partial<RatchetJQJob>>>
  retireFails?: Error
}) {
  const rows = options.rows ?? []
  const aboveFloorAnswers = options.aboveFloor ?? [true]
  let selectCount = 0
  let failuresLeft = options.failRounds ?? 0

  const query = jest.fn(async () => {
    if (failuresLeft > 0) {
      failuresLeft -= 1
      throw new Error('database unavailable')
    }
    const answer = rows[selectCount] ?? []
    selectCount += 1
    return answer
  })

  // The sweeps' own connection. `transaction` hands the callback a runner whose
  // `query` is this one, which is what the real transactional EntityManager does
  // and what lets a test assert that the terminal write goes to the same runner
  // that holds the row locked.
  const sweepRows = options.sweeps ?? []
  let sweepCount = 0
  const sweepQuery = jest.fn(async () => {
    const answer = sweepRows[sweepCount] ?? []
    sweepCount += 1
    return answer
  })
  const sweepRunner = { query: sweepQuery }
  const manager = {
    transaction: jest.fn(async (run: (runner: typeof sweepRunner) => Promise<number>) => run(sweepRunner)),
  }

  let releaseResolve: () => void = () => undefined
  const retired = new Promise<void>((resolve) => {
    releaseResolve = resolve
  })

  let floorCheck = 0
  let renewCount = 0
  const pool = {
    acquire: jest.fn(async () => options.acquire ?? true),
    renew: jest.fn(async () => {
      const answer = (options.renewals ?? [])[renewCount] ?? true
      renewCount += 1
      if (answer instanceof Error) {
        throw answer
      }
      return answer
    }),
    release: jest.fn(async () => {
      releaseResolve()
    }),
    isAboveFloor: jest.fn(async () => {
      const answer = aboveFloorAnswers[Math.min(floorCheck, aboveFloorAnswers.length - 1)]
      floorCheck += 1
      return answer
    }),
    liveCount: jest.fn(async () => 2),
  }

  const configService = {
    get: jest.fn((key: string) => {
      if (key === 'ratchetjq.scannerSlotRenewSeconds' && options.renewSeconds !== undefined) {
        return options.renewSeconds
      }
      if (!(key in CONFIG)) {
        throw new Error(`unexpected config key: ${key}`)
      }
      return CONFIG[key]
    }),
  }

  const acceptors = options.acceptors ?? {}
  const registry = { acceptorFor: jest.fn((type: string) => acceptors[type]) }
  const finalizer = {
    finalize: jest.fn(async () => undefined),
    retire: jest.fn(async () => {
      if (options.retireFails) {
        throw options.retireFails
      }
    }),
  }
  // The real accept round over stubbed halves, because the Scanner delegates the
  // whole of one accept to it: a stub in its place would leave these tests
  // asserting that the loop calls something, not that it accepts. Its repository
  // is a separate one that refuses to be used, which is what says an unattended
  // round holds no lease of its own — and keeps `rows` sequenced against the
  // three statements a round actually runs.
  const acceptQuery = jest.fn(async () => {
    throw new Error('an unattended accept round issues no statement of its own')
  })
  const acceptRound = new RatchetJQAcceptRound({ query: acceptQuery } as never, registry as never, finalizer as never)

  const service = new RatchetJQScannerService(
    { query, manager } as never,
    pool as never,
    configService as never,
    acceptRound as never,
    finalizer as never,
  )

  const sleepReads = (): number =>
    configService.get.mock.calls.filter(([key]) => key === 'ratchetjq.emptyRoundSleepMs').length
  const selects = (): Array<[string, unknown[]]> => query.mock.calls as unknown as Array<[string, unknown[]]>
  const roundCount = (): number => Math.ceil(selects().length / STATEMENTS_PER_ROUND)

  const sweepSelects = (): Array<[string, unknown[]]> => sweepQuery.mock.calls as unknown as Array<[string, unknown[]]>

  return {
    service,
    query,
    pool,
    registry,
    finalizer,
    configService,
    retired,
    sleepReads,
    selects,
    roundCount,
    sweepRunner,
    sweepSelects,
  }
}

describe('RatchetJQScannerService pool slot', () => {
  it('starts nothing when the pool will not have another Scanner', async () => {
    const { service, pool, query } = makeScanner({ acquire: false })

    await expect(service.scannerWakeup()).resolves.toBe(false)

    expect(pool.acquire).toHaveBeenCalled()
    expect(query).not.toHaveBeenCalled()
  })

  it('runs and gives the slot back once it retires', async () => {
    const { service, pool, retired } = makeScanner({ aboveFloor: [true] })

    await expect(service.scannerWakeup()).resolves.toBe(true)
    await retired

    expect(pool.release).toHaveBeenCalledWith(expect.any(String))
  })

  // One Scanner per process is the pool's whole invariant, so a second wake-up
  // on a process that is already scanning must not take another slot.
  it('does not start a second Scanner on the same process', async () => {
    const { service, pool, retired } = makeScanner({ aboveFloor: [false, false, false, false, true] })

    await service.scannerWakeup()
    await expect(service.scannerWakeup()).resolves.toBe(false)
    await retired

    expect(pool.acquire).toHaveBeenCalledTimes(1)
  })

  // Losing a slot is a fact about one run, not about the process: the pool has
  // stopped counting this Scanner, so that loop must end, but the process is
  // healthy and a wake-up is the only thing that ever refills the pool. A process
  // that answered no here for the rest of its life would take a share of the
  // global backstop out of service with nothing visibly wrong.
  it('hosts another Scanner after one lost its pool slot', async () => {
    // Never above the floor, so nothing retires on its own: the only way either
    // run can end is the slot going out from under it, which both do.
    const { service, pool, retired } = makeScanner({
      aboveFloor: [false],
      renewSeconds: 0,
      renewals: [false, false],
    })

    expect(await service.scannerWakeup()).toBe(true)
    await retired
    await loopTurn()

    expect(pool.renew).toHaveBeenCalled()
    expect(await service.scannerWakeup()).toBe(true)

    // Leave nothing running behind this test.
    await service.onApplicationShutdown()
  })

  // The other half of that split: shutdown is the case that really is permanent,
  // so it must keep refusing.
  it('hosts nothing more after shutdown', async () => {
    const { service } = makeScanner({ aboveFloor: [false], renewSeconds: 0 })

    await service.onApplicationShutdown()

    expect(await service.scannerWakeup()).toBe(false)
  })

  it('releases the slot on shutdown', async () => {
    const { service, pool, retired } = makeScanner({ aboveFloor: [true] })

    await service.scannerWakeup()
    await retired
    await service.onApplicationShutdown()

    expect(pool.release).toHaveBeenCalled()
  })
})

describe('RatchetJQScannerService retirement policy', () => {
  it('retires only after the limit of consecutive empty rounds', async () => {
    const { service, retired, roundCount } = makeScanner({ aboveFloor: [true] })

    await service.scannerWakeup()
    await retired

    expect(roundCount()).toBe(EMPTY_ROUND_LIMIT)
  })

  // A productive round clears the counter, so a Scanner that is busy most of the
  // time is never retired by scattered idle rounds.
  it('lets a productive round reset the empty counter', async () => {
    const { service, retired, roundCount } = makeScanner({
      // Round 1 empty; round 2's second statement forces a job on, which resets
      // the counter; then empty rounds until it retires.
      rows: [[], [], [], [], [{ id: 'job-1' }], [], [], [], [], [], [], [], []],
      aboveFloor: [true],
    })

    await service.scannerWakeup()
    await retired

    // Without the reset this would have retired at round 3.
    expect(roundCount()).toBeGreaterThan(EMPTY_ROUND_LIMIT)
  })

  it('keeps scanning at the pool floor instead of retiring', async () => {
    const { service, retired, roundCount } = makeScanner({
      // At the floor for the first four checks, then the pool grows.
      aboveFloor: [false, false, false, false, true],
    })

    await service.scannerWakeup()
    await retired

    expect(roundCount()).toBeGreaterThan(EMPTY_ROUND_LIMIT)
  })

  // The spec's loop tail rests only inside the counting branch, which leaves a
  // Scanner at the floor rescanning with no delay — a busy poll against Postgres
  // in the one state where this Scanner is all there is. §12-10 names the fix:
  // rest on every empty round, and let the limit and the floor decide only
  // whether to exit.
  it('still rests on the empty rounds it runs at the floor', async () => {
    const { service, retired, sleepReads, roundCount } = makeScanner({
      aboveFloor: [false, false, false, false, true],
    })

    await service.scannerWakeup()
    await retired

    // One rest per empty round, including every round run while at the floor —
    // all but the last, which retires instead of resting. Under the spec's
    // literal tail only the rounds below the limit would rest, so this count
    // separates the two: 6 rather than EMPTY_ROUND_LIMIT - 1.
    expect(sleepReads()).toBe(roundCount() - 1)
    expect(sleepReads()).toBeGreaterThan(EMPTY_ROUND_LIMIT)
  })

  // This loop is the only global backstop, so a failing round must neither end
  // it nor let it spin on the failure.
  it('survives a failing round and rests before trying again', async () => {
    const { service, retired, roundCount, sleepReads } = makeScanner({
      failRounds: 1,
      aboveFloor: [true],
    })

    await service.scannerWakeup()
    await retired

    expect(roundCount()).toBeGreaterThanOrEqual(EMPTY_ROUND_LIMIT)
    expect(sleepReads()).toBeGreaterThan(0)
  })
})

describe('RatchetJQScannerService sweeps', () => {
  // Both conditions, and the second is the one worth asserting: `attempt` names
  // the *next* round, so a job on its last round already carries a number past
  // the ceiling — retiring on the counter alone would close a job that is still
  // being executed.
  it('takes only rows whose rounds are used up and whose last round is over', async () => {
    const { service, sweepSelects, retired } = makeScanner({ aboveFloor: [true] })

    await service.scannerWakeup()
    await retired

    const [sql, parameters] = sweepSelects()[0]
    expect(sql).toContain('"leaseExpiresAt" <= now()')
    expect(sql).toContain('"attempt" > $2')
    expect(parameters).toEqual([RatchetJQJobPeriod.RUNNING, ATTEMPT_MAX_N, CLAIM_BATCH_SIZE])
  })

  // The row has to stay put between being read and being closed, because a
  // rollback job is created in that gap; SKIP LOCKED is what keeps two Scanners
  // off the same rows instead of queueing them.
  it('locks the rows it is about to retire, and steps over locked ones', async () => {
    const { service, sweepSelects, retired } = makeScanner({ aboveFloor: [true] })

    await service.scannerWakeup()
    await retired

    expect(sweepSelects()[0][0]).toContain('FOR UPDATE SKIP LOCKED')
  })

  it('sweeps running first, then accepting', async () => {
    const { service, sweepSelects, retired } = makeScanner({ aboveFloor: [true] })

    await service.scannerWakeup()
    await retired

    expect(sweepSelects()[0][1][0]).toBe(RatchetJQJobPeriod.RUNNING)
    expect(sweepSelects()[1][1][0]).toBe(RatchetJQJobPeriod.ACCEPTING)
  })

  // `pending_run` is never retired directly — that is why the `pending_run`
  // force-advance exists, to move a silent runner's jobs into `running` where a
  // sweep can reach them (spec §3, §8.3).
  it('never sweeps pending_run', async () => {
    const { service, sweepSelects, retired } = makeScanner({ aboveFloor: [true] })

    await service.scannerWakeup()
    await retired

    // Both halves matter. The absence on its own would pass just as well if no
    // sweep ran at all, so it is paired with a liveness check — over every round
    // the loop ran, not just the first, since one sweeping the wrong stage later
    // would be exactly as wrong.
    const swept = sweepSelects().map(([, parameters]) => parameters[0])
    expect(swept.length).toBeGreaterThan(0)
    expect(swept).not.toContain(RatchetJQJobPeriod.PENDING_RUN)
  })

  // The terminal write has to go to the runner that holds the row locked. On any
  // other connection it would queue behind that lock while the sweep waits for
  // the write, which is a deadlock with itself.
  it('retires each row through the transaction that holds it locked', async () => {
    const { service, finalizer, sweepRunner, retired } = makeScanner({
      aboveFloor: [true],
      sweeps: [
        [
          { id: 'job-1', period: RatchetJQJobPeriod.RUNNING },
          { id: 'job-2', period: RatchetJQJobPeriod.RUNNING },
        ],
      ],
    })

    await service.scannerWakeup()
    await retired

    expect(finalizer.retire).toHaveBeenCalledWith({ id: 'job-1', period: RatchetJQJobPeriod.RUNNING }, sweepRunner)
    expect(finalizer.retire).toHaveBeenCalledWith({ id: 'job-2', period: RatchetJQJobPeriod.RUNNING }, sweepRunner)
  })

  // One job type with a broken rollback must not cost the rest of the batch their
  // retirement: the row keeps its spent rounds and expired lease, so the next
  // sweep finds it again.
  it('carries on through a row it could not retire', async () => {
    const { service, finalizer, retired } = makeScanner({
      aboveFloor: [true],
      retireFails: new Error('the rollback job could not be queued'),
      sweeps: [[{ id: 'job-1' }, { id: 'job-2' }]],
    })

    await service.scannerWakeup()
    await retired

    expect(finalizer.retire).toHaveBeenCalledTimes(2)
  })
})

describe('RatchetJQScannerService force-advance statements', () => {
  it('forces pending_run into running with the grace period applied', async () => {
    const { service, query, retired } = makeScanner({ aboveFloor: [true] })

    await service.scannerWakeup()
    await retired

    const [sql, parameters] = query.mock.calls[0] as unknown as [string, unknown[]]
    expect(sql).toContain('FOR UPDATE SKIP LOCKED')
    expect(sql).toContain('"attempt" = 2')
    expect(sql).toContain('make_interval(secs => $3)')
    expect(sql).toContain('"leaseExpiresAt" = now(), "visibleAt" = now()')
    expect(parameters).toEqual([
      RatchetJQJobPeriod.PENDING_RUN,
      RatchetJQJobPeriod.RUNNING,
      TIME_TO_FORCE_SECONDS,
      CLAIM_BATCH_SIZE,
    ])
  })

  it('forces a stuck running job on and spends a round for it', async () => {
    const { service, query, retired } = makeScanner({ aboveFloor: [true] })

    await service.scannerWakeup()
    await retired

    const [sql, parameters] = query.mock.calls[1] as unknown as [string, unknown[]]
    expect(sql).toContain('"attempt" = "attempt" + 1')
    expect(sql).toContain('"attempt" <= $3')
    expect(parameters).toEqual([RatchetJQJobPeriod.RUNNING, TIME_TO_FORCE_SECONDS, ATTEMPT_MAX_N, CLAIM_BATCH_SIZE])
  })

  // Both deadlines are cleared together on purpose: the point of forcing is to
  // make the row claimable at once, and the throttle is the grace period, not the
  // backoff.
  it('clears lease and backoff together rather than backing off', async () => {
    const { service, query, retired } = makeScanner({ aboveFloor: [true] })

    await service.scannerWakeup()
    await retired

    const [sql] = query.mock.calls[1] as unknown as [string]
    expect(sql).toContain('"visibleAt" = now()')
    expect(sql).not.toContain('POW(')
  })
})

// --- accept segment ---------------------------------------------------------

/** An acceptor that decides inline, so the Scanner exercises the adaptation too. */
class StubAcceptor implements IJobAcceptor {
  seen: string[] = []
  signals: AbortSignal[] = []

  constructor(
    readonly type: string,
    private readonly verdict: RatchetJQAcceptVerdict,
  ) {}

  async accept(job: RatchetJQJob, signal: AbortSignal): Promise<RatchetJQAcceptVerdict> {
    this.seen.push(job.id)
    this.signals.push(signal)
    return this.verdict
  }
}

/**
 * An acceptor that never settles and ignores its signal, which is the worst case
 * the budget exists for: the wait has to end, and the Scanner has to have aborted
 * the accept even though this one does not act on it.
 */
class SilentAcceptor implements IJobAcceptor {
  readonly type = 'silent'
  signals: AbortSignal[] = []

  accept(_job: RatchetJQJob, signal: AbortSignal): Promise<RatchetJQAcceptVerdict> {
    this.signals.push(signal)
    return new Promise<RatchetJQAcceptVerdict>(() => undefined)
  }
}

/**
 * An acceptor that never settles on its own but honours the signal: what an accept
 * being reclaimed looks like, as opposed to merely stopped being waited for.
 */
class CancellableAcceptor implements IJobAcceptor {
  readonly type = 'cancellable'
  wasAborted = false

  accept(_job: RatchetJQJob, signal: AbortSignal): Promise<RatchetJQAcceptVerdict> {
    return new Promise<RatchetJQAcceptVerdict>((_resolve, reject) => {
      signal.addEventListener('abort', () => {
        this.wasAborted = true
        reject(signal.reason)
      })
    })
  }
}

/** One `accepting` row for the retry statement to hand back. */
function acceptingJob(id: string, type: string): Partial<RatchetJQJob> {
  return { id, type, attlSeconds: 0 }
}

describe('RatchetJQScannerService accept segment', () => {
  it('charges a round and takes an accept lease, with no grace period', async () => {
    const { service, selects, retired } = makeScanner({ aboveFloor: [true] })

    await service.scannerWakeup()
    await retired

    const [sql, parameters] = selects()[2]
    expect(sql).toContain(`GREATEST("attlSeconds", POW("attempt", 4))`)
    expect(sql).toContain('"attempt" = "attempt" + 1')
    // The lease expiring is the whole trigger — no `make_interval` grace, which is
    // what separates this from the two force-advance statements above.
    expect(sql).not.toContain('make_interval')
    // The accept ceiling, not the claim batch: a row taken here is an acceptor
    // about to run, so its width is bounded on its own.
    expect(parameters).toEqual([RatchetJQJobPeriod.ACCEPTING, ATTEMPT_MAX_N, ACCEPT_MAX_N])
  })

  it('offers each retried job to the acceptor registered for its type', async () => {
    const acceptor = new StubAcceptor('demo', RatchetJQAcceptVerdict.ACCEPTED)
    const { service, retired } = makeScanner({
      rows: [[], [], [acceptingJob('job-1', 'demo'), acceptingJob('job-2', 'demo')]],
      acceptors: { demo: acceptor },
      aboveFloor: [true],
    })

    await service.scannerWakeup()
    await retired

    expect(acceptor.seen).toEqual(['job-1', 'job-2'])
  })

  // The Scanner decides nothing about the outcome: it hands the verdict on, and
  // the terminal writes are the finalizer's, which has its own spec.
  it('hands each verdict to the finalizer', async () => {
    const { service, finalizer, retired } = makeScanner({
      rows: [[], [], [acceptingJob('job-1', 'demo')]],
      acceptors: { demo: new StubAcceptor('demo', RatchetJQAcceptVerdict.ROLLBACK) },
      aboveFloor: [true],
    })

    await service.scannerWakeup()
    await retired

    expect(finalizer.finalize).toHaveBeenCalledTimes(1)
    expect(finalizer.finalize).toHaveBeenCalledWith(
      expect.objectContaining({ id: 'job-1' }),
      RatchetJQAcceptVerdict.ROLLBACK,
    )
  })

  it('leaves a job whose type no acceptor claims to its lease', async () => {
    const { service, registry, finalizer, retired } = makeScanner({
      rows: [[], [], [acceptingJob('job-1', 'unregistered')]],
      aboveFloor: [true],
    })

    await service.scannerWakeup()
    await retired

    expect(registry.acceptorFor).toHaveBeenCalledWith('unregistered')
    expect(finalizer.finalize).not.toHaveBeenCalled()
  })

  // An accept that never settles must not cost the loop its force-advance duty,
  // so the job's own accept budget bounds it and the round carries on with no
  // verdict to act on.
  it('gives up on an accept that outlives its budget and keeps scanning', async () => {
    const acceptor = new SilentAcceptor()
    const { service, finalizer, roundCount, retired } = makeScanner({
      rows: [[], [], [acceptingJob('job-1', 'silent')]],
      acceptors: { silent: acceptor },
      aboveFloor: [true],
    })

    await service.scannerWakeup()
    await retired

    expect(finalizer.finalize).not.toHaveBeenCalled()
    // The round still counted its row, so the empty-round counter reset and the
    // loop outlived the limit — it gave up on the accept, not on scanning.
    expect(roundCount()).toBeGreaterThan(EMPTY_ROUND_LIMIT)
    // Ending the wait is not enough: an accept nobody is waiting for has to be
    // told so, or ACCEPT_MAXN caps rows per round while accepts in flight grow by
    // that many every budget. This acceptor ignores the signal, which is why the
    // assertion is that the Scanner aborted it rather than that the work stopped.
    expect(acceptor.signals).toHaveLength(1)
    expect(acceptor.signals[0].aborted).toBe(true)
  })

  // The point of the signal: an acceptor that honours it stops on its own, so the
  // query, request or timer behind an abandoned accept is released rather than
  // running on with nothing left to receive its verdict.
  it('reclaims an accept that honours its signal once the budget lapses', async () => {
    const acceptor = new CancellableAcceptor()
    const { service, finalizer, retired } = makeScanner({
      rows: [[], [], [acceptingJob('job-1', 'cancellable')]],
      acceptors: { cancellable: acceptor },
      aboveFloor: [true],
    })

    await service.scannerWakeup()
    await retired

    expect(acceptor.wasAborted).toBe(true)
    expect(finalizer.finalize).not.toHaveBeenCalled()
  })

  // The abort is unconditional, and this is the path that proves it: the budget's
  // timer is still pending when a fast accept settles, and aborting is what clears
  // it instead of leaving one alive per accept for the whole budget.
  it('ends the accept budget of a job whose acceptor answered in time', async () => {
    const acceptor = new StubAcceptor('demo', RatchetJQAcceptVerdict.ACCEPTED)
    const { service, finalizer, retired } = makeScanner({
      rows: [[], [], [acceptingJob('job-1', 'demo')]],
      acceptors: { demo: acceptor },
      aboveFloor: [true],
    })

    await service.scannerWakeup()
    await retired

    expect(finalizer.finalize).toHaveBeenCalledTimes(1)
    expect(acceptor.signals).toHaveLength(1)
    expect(acceptor.signals[0].aborted).toBe(true)
  })

  // A finalizer that could not write leaves the row `accepting`, and the round has
  // to survive it — this loop is the only global backstop.
  it('survives a finalizer that fails and keeps scanning', async () => {
    const { service, finalizer, roundCount, retired } = makeScanner({
      rows: [[], [], [acceptingJob('job-1', 'demo')]],
      acceptors: { demo: new StubAcceptor('demo', RatchetJQAcceptVerdict.ACCEPTED) },
      aboveFloor: [true],
    })
    finalizer.finalize.mockRejectedValueOnce(new Error('deadlock detected') as never)

    await service.scannerWakeup()
    await retired

    // Still a productive round: the row was moved even though acting on the
    // verdict failed, so the failure cost this round nothing but the write.
    expect(roundCount()).toBeGreaterThan(EMPTY_ROUND_LIMIT)
  })
})
