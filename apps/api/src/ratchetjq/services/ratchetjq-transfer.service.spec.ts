/*
 * Copyright 2026 BoxLite AI
 * SPDX-License-Identifier: AGPL-3.0
 */

import { RatchetJQJobPeriod } from '../enums/ratchetjq-job-period.enum'
import { RatchetJQTransferService } from './ratchetjq-transfer.service'

const ATTEMPT_MAX_N = 5
const CLAIM_BATCH_SIZE = 100
const MAX_BLOCK_SECONDS = 60
// Smaller than CLAIM_BATCH_SIZE, so a test can tell the caller's budget apart
// from the server's own ceiling.
const BUDGET = 7
const BLOCKING_BUFFER_MS = 3_000

// Keyed rather than a chain of ternaries: a stub that fell through to one
// default would hand the same number to every setting and hide a service that
// read the wrong key.
const CONFIG: Record<string, number> = {
  'ratchetjq.attemptMaxN': ATTEMPT_MAX_N,
  'ratchetjq.claimBatchSize': CLAIM_BATCH_SIZE,
  'ratchetjq.maxBlockSeconds': MAX_BLOCK_SECONDS,
  'ratchetjq.blockingCommandTimeoutBufferMs': BLOCKING_BUFFER_MS,
}

type QueryCall = [string, unknown[] | undefined]

/**
 * Builds the service over stubs, and lets a test say what each query returns.
 *
 * `durSeconds` is what nextClaimableInSeconds should see: a number, or null for
 * "this executor has nothing upcoming". The claim statements are the calls that
 * carry a `WITH claimed AS` prefix, so the stub tells them apart by SQL rather
 * than by call order — the order changes with the mode under test.
 */
function makeService(options: { claimed?: unknown[]; durSeconds?: number | null } = {}) {
  const claimed = options.claimed ?? []
  const durSeconds = options.durSeconds === undefined ? null : options.durSeconds

  // Both parameters are declared so mock.calls carries the bound values too,
  // which is what the assertions below read.
  const query = jest.fn(async (sql: string, parameters?: unknown[]) => {
    void parameters
    if (sql.includes('WITH claimed AS')) {
      return claimed
    }
    return [{ seconds: durSeconds === null ? null : String(durSeconds) }]
  })

  const brpop = jest.fn(async () => null)
  const disconnect = jest.fn()
  const blockingClient = { brpop, disconnect }
  const redis = {
    rpush: jest.fn(async () => 1),
    del: jest.fn(async () => 1),
    duplicate: jest.fn(() => blockingClient),
  }
  const configService = {
    get: jest.fn((key: string) => {
      if (!(key in CONFIG)) {
        throw new Error(`unexpected config key: ${key}`)
      }
      return CONFIG[key]
    }),
  }

  const service = new RatchetJQTransferService({ query } as never, redis as never, configService as never)

  const claimCalls = (): QueryCall[] =>
    query.mock.calls.filter(([sql]) => sql.includes('WITH claimed AS')) as QueryCall[]
  const durCall = (): QueryCall => query.mock.calls.find(([sql]) => !sql.includes('WITH claimed AS')) as QueryCall

  return { service, query, redis, brpop, disconnect, claimCalls, durCall }
}

describe('RatchetJQTransferService claim statements', () => {
  it('advances pending_run into running and charges the first round to attempt 2', async () => {
    const { service, claimCalls } = makeService({ claimed: [{ id: 'job-1' }] })

    await service.claimJobs('runner', 'r1', BUDGET)

    const [sql, parameters] = claimCalls()[0]
    expect(sql).toContain('FOR UPDATE SKIP LOCKED')
    expect(sql).toContain('"attempt" = 2')
    expect(sql).toContain('ORDER BY "pr" ASC, "leaseExpiresAt" ASC')
    expect(parameters).toEqual(['runner', 'r1', RatchetJQJobPeriod.PENDING_RUN, RatchetJQJobPeriod.RUNNING, BUDGET])
  })

  // Round one needs no MAX: the backoff term is one second, so the lease is
  // simply ttlSeconds. Writing it plainly keeps the statement readable, and the
  // leaseExpiresAt >= visibleAt invariant still holds for any budget above a
  // second.
  it('writes round one deadlines plainly', async () => {
    const { service, claimCalls } = makeService({ claimed: [{ id: 'job-1' }] })

    await service.claimJobs('runner', 'r1', BUDGET)

    const [sql] = claimCalls()[0]
    expect(sql).toContain('"leaseExpiresAt" = now() + "ttlSeconds" * interval \'1 second\'')
    expect(sql).toContain('"visibleAt" = now() + interval \'1 second\'')
    expect(sql).not.toContain('POW(')
  })

  // A retry does need the MAX, and both columns have to be written off the same
  // round number or the invariant stops holding by construction.
  it('writes a retry off the round that is starting', async () => {
    const { service, claimCalls } = makeService({ claimed: [{ id: 'job-1' }] })

    await service.claimJobs('runner', 'r1', BUDGET, false)

    const [sql] = claimCalls()[1]
    expect(sql).toContain(
      '"leaseExpiresAt" = now() + GREATEST("ttlSeconds", POW("attempt", 4)) * interval \'1 second\'',
    )
    expect(sql).toContain('"visibleAt" = now() + POW("attempt", 4) * interval \'1 second\'')
  })

  it('retries an expired lease in steady state and spends a round', async () => {
    const { service, claimCalls } = makeService({ claimed: [{ id: 'job-1' }] })

    await service.claimJobs('runner', 'r1', BUDGET, false)

    const [sql, parameters] = claimCalls()[1]
    expect(sql).toContain('"attempt" = "attempt" + 1')
    expect(sql).toContain('"leaseExpiresAt" <= now()')
    expect(sql).not.toContain('"visibleAt" <= now()')
    expect(parameters).toEqual(['runner', 'r1', RatchetJQJobPeriod.RUNNING, ATTEMPT_MAX_N, BUDGET - 1])
  })

  // A restart is not a failed attempt. Charging it a round would let a runner
  // that restarts ATTEMPT_MAXN times time its own jobs out with nothing wrong.
  it('reclaims after a restart without spending a round or waiting out the lease', async () => {
    const { service, claimCalls } = makeService({ claimed: [{ id: 'job-1' }] })

    await service.claimJobs('runner', 'r1', BUDGET, true)

    // Reclaim goes first on a restart, so it is call 0 in this mode.
    const [sql] = claimCalls()[0]
    expect(sql).not.toContain('"attempt" = ')
    expect(sql).toContain('"visibleAt" <= now()')
    expect(sql).not.toContain('"leaseExpiresAt" <= now()')
    // Replays the interrupted round rather than advancing to the next one.
    expect(sql).toContain('POW("attempt" - 1, 4)')
    // visibleIdx serves this predicate, so the sort has to match it.
    expect(sql).toContain('ORDER BY "pr" ASC, "visibleAt" ASC')
  })

  // Only the order and the retry half differ between the modes; the advance
  // statement itself is the same SQL either way.
  it('runs the same advance statement in both modes', async () => {
    const steady = makeService({ claimed: [{ id: 'job-1' }] })
    const restart = makeService({ claimed: [{ id: 'job-1' }] })

    await steady.service.claimJobs('runner', 'r1', BUDGET, false)
    await restart.service.claimJobs('runner', 'r1', BUDGET, true)

    // Steady state advances first; a restart advances second, after reclaiming.
    expect(steady.claimCalls()[0][0]).toEqual(restart.claimCalls()[1][0])
  })

  // A restart reclaim costs no round, so spending the budget on new work first
  // would waste that free round and leave interrupted jobs on their leases.
  it('spends the budget on reclaim before new work when restarting', async () => {
    const { service, claimCalls } = makeService({ claimed: [{ id: 'job-1' }] })

    await service.claimJobs('runner', 'r1', BUDGET, true)

    expect(claimCalls()[0][0]).toContain('"visibleAt" <= now()')
    expect(claimCalls()[1][0]).toContain('"attempt" = 2')
  })

  // A pending_run row has not had its first round yet, so steady state starts it
  // before spending the budget on rows that have already run once.
  it('spends the budget on new work before retries in steady state', async () => {
    const { service, claimCalls } = makeService({ claimed: [{ id: 'job-1' }] })

    await service.claimJobs('runner', 'r1', BUDGET, false)

    expect(claimCalls()[0][0]).toContain('"attempt" = 2')
    expect(claimCalls()[1][0]).toContain('"attempt" = "attempt" + 1')
  })
})

describe('RatchetJQTransferService claim budget', () => {
  // n is spent across the two statements, not repeated for each: the second may
  // only take what the first left, or one claim could hand back 2n jobs.
  it('gives the second statement only what the first left of the budget', async () => {
    const { service, claimCalls } = makeService({ claimed: [{ id: 'job-1' }, { id: 'job-2' }] })

    await service.claimJobs('runner', 'r1', BUDGET, false)

    const [, firstParameters] = claimCalls()[0]
    const [, secondParameters] = claimCalls()[1]
    expect(firstParameters?.at(-1)).toBe(BUDGET)
    expect(secondParameters?.at(-1)).toBe(BUDGET - 2)
  })

  // With the budget already full there is nothing the second statement could be
  // allowed to return, so it must not be issued at all.
  it('skips the second statement when the first filled the budget', async () => {
    const full = Array.from({ length: BUDGET }, (_, index) => ({ id: `job-${index}` }))
    const { service, claimCalls } = makeService({ claimed: full })

    const jobs = await service.claimJobs('runner', 'r1', BUDGET, false)

    expect(claimCalls()).toHaveLength(1)
    expect(jobs).toHaveLength(BUDGET)
  })

  // The executor names its own budget, but one statement is still bounded by
  // this side's batch size.
  it('clamps a caller asking for more than one batch', async () => {
    const { service, claimCalls } = makeService({ claimed: [] })

    await service.claimJobs('runner', 'r1', CLAIM_BATCH_SIZE * 10, false)

    const [, parameters] = claimCalls()[0]
    expect(parameters?.at(-1)).toBe(CLAIM_BATCH_SIZE)
  })

  it('claims nothing at all when the executor has no budget left', async () => {
    const { service, claimCalls, redis } = makeService({ claimed: [] })

    const jobs = await service.claimJobs('runner', 'r1', 0, false)

    expect(jobs).toEqual([])
    expect(claimCalls()).toHaveLength(0)
    expect(redis.del).not.toHaveBeenCalled()
  })
})

describe('RatchetJQTransferService blocking', () => {
  it('returns the first pass without blocking when it found jobs', async () => {
    const { service, redis, brpop } = makeService({ claimed: [{ id: 'job-1' }] })

    const jobs = await service.claimJobs('runner', 'r1', BUDGET)

    expect(jobs).toHaveLength(2)
    expect(redis.del).not.toHaveBeenCalled()
    expect(brpop).not.toHaveBeenCalled()
  })

  it('blocks for the full cap when the executor has nothing upcoming', async () => {
    const { service, brpop, redis } = makeService({ claimed: [], durSeconds: null })

    await service.claimJobs('runner', 'r1', BUDGET)

    // Edge-triggered: the stale hint goes before the wait starts.
    expect(redis.del).toHaveBeenCalledWith('ratchetjq:runner:r1')
    expect(brpop).toHaveBeenCalledWith('ratchetjq:runner:r1', MAX_BLOCK_SECONDS)
  })

  it('blocks only until the next job falls due', async () => {
    const { service, brpop } = makeService({ claimed: [], durSeconds: 5 })

    await service.claimJobs('runner', 'r1', BUDGET)

    expect(brpop).toHaveBeenCalledWith('ratchetjq:runner:r1', 5)
  })

  // BRPOP with a timeout of 0 blocks forever, so a due row must skip it
  // entirely rather than have the zero passed through.
  it('never calls BRPOP with a zero timeout when a row is already due', async () => {
    const { service, brpop, claimCalls } = makeService({ claimed: [], durSeconds: 0 })

    await service.claimJobs('runner', 'r1', BUDGET)

    expect(brpop).not.toHaveBeenCalled()
    // Still re-runs the whole block, so a row freed in the meantime is taken.
    expect(claimCalls()).toHaveLength(4)
  })

  // The claim block runs again in full, so a retry that came due during the
  // wait is picked up in this call rather than on the next poll.
  it('re-runs the whole claim block after blocking, not just the advance', async () => {
    const { service, claimCalls } = makeService({ claimed: [], durSeconds: null })

    await service.claimJobs('runner', 'r1', BUDGET)

    expect(claimCalls()).toHaveLength(4)
  })

  // Without headroom over the server's own timeout, ioredis would abandon BRPOP
  // at the moment the server decides to return, turning every idle wait into a
  // logged error.
  it('gives the blocking client more time than the wait it is making', async () => {
    const { service, redis } = makeService({ claimed: [], durSeconds: null })

    await service.claimJobs('runner', 'r1', BUDGET)

    expect(redis.duplicate).toHaveBeenCalledWith(
      expect.objectContaining({ commandTimeout: MAX_BLOCK_SECONDS * 1000 + BLOCKING_BUFFER_MS }),
    )
  })

  it('closes the blocking connection on every path', async () => {
    const { service, disconnect } = makeService({ claimed: [], durSeconds: null })

    await service.claimJobs('runner', 'r1', BUDGET)

    expect(disconnect).toHaveBeenCalled()
  })

  it('gives up the claim when the executor hangs up', async () => {
    const { service, brpop } = makeService({ claimed: [], durSeconds: null })
    const aborted = AbortSignal.abort()

    const jobs = await service.claimJobs('runner', 'r1', BUDGET, false, aborted)

    expect(jobs).toEqual([])
    expect(brpop).not.toHaveBeenCalled()
  })
})

describe('RatchetJQTransferService dur', () => {
  // Postgres GREATEST/LEAST ignore nulls instead of propagating them, so the
  // clamp alone would turn "nothing upcoming" into "a row is due now" and spin
  // an idle executor through the claim. The CASE is what keeps null a null.
  it('asks the database to distinguish no-upcoming-work from due-now', async () => {
    const { service, durCall } = makeService({ claimed: [], durSeconds: null })

    await service.claimJobs('runner', 'r1', BUDGET)

    const [sql, parameters] = durCall()
    expect(sql).toContain('WHEN t.nxt IS NULL THEN NULL')
    expect(sql).toContain('EXTRACT(EPOCH FROM')
    expect(sql).toContain('make_interval(secs => $5)')
    expect(parameters).toEqual([
      'runner',
      'r1',
      RatchetJQJobPeriod.PENDING_RUN,
      RatchetJQJobPeriod.RUNNING,
      MAX_BLOCK_SECONDS,
    ])
  })

  it('reads the same column the claim predicates compare', async () => {
    const { service, durCall } = makeService({ claimed: [], durSeconds: null })

    await service.claimJobs('runner', 'r1', BUDGET)

    const [sql] = durCall()
    expect(sql).toContain('min("leaseExpiresAt")')
    expect(sql).not.toContain('min("visibleAt")')
  })
})

describe('RatchetJQTransferService wakeup', () => {
  it('pushes a valueless hint onto the executor list', async () => {
    const { service, redis } = makeService()

    await service.wakeup('runner', 'r1')

    expect(redis.rpush).toHaveBeenCalledWith('ratchetjq:runner:r1', 1)
  })

  // The job is already committed, so a Redis failure costs at most one poll
  // interval of latency and must not fail the submission.
  it('swallows a Redis failure', async () => {
    const { service, redis } = makeService()
    redis.rpush.mockRejectedValueOnce(new Error('redis down'))

    await expect(service.wakeup('runner', 'r1')).resolves.toBeUndefined()
  })
})
