/*
 * Copyright 2026 BoxLite AI
 * SPDX-License-Identifier: AGPL-3.0
 */

import { ratchetjqConfig } from './configuration'

describe('ratchetjqConfig', () => {
  // The service reads these at runtime, so the defaults are the behaviour of a
  // deployment that sets nothing — worth pinning rather than rediscovering.
  it('falls back to the spec defaults when nothing is set', () => {
    expect(ratchetjqConfig({})).toEqual({
      attemptMaxN: 5,
      claimBatchSize: 100,
      acceptMaxN: 16,
      maxBlockSeconds: 60,
      blockingCommandTimeoutBufferMs: 3_000,
      scannerMaxN: 4,
      scannerMinN: 2,
      scannerSlotTtlSeconds: 30,
      scannerSlotRenewSeconds: 25,
      emptyRoundLimit: 5,
      emptyRoundSleepMs: 5_000,
      timeToForceSeconds: 60,
      maxUnfinishedPerExecutor: 1_000,
    })
  })

  it('takes each setting from its own variable', () => {
    const config = ratchetjqConfig({
      RATCHETJQ_ATTEMPT_MAX_N: '7',
      RATCHETJQ_CLAIM_BATCH_SIZE: '25',
      RATCHETJQ_ACCEPT_MAX_N: '4',
      RATCHETJQ_MAX_BLOCK_SECONDS: '30',
      RATCHETJQ_BLOCKING_COMMAND_TIMEOUT_BUFFER_MS: '1500',
      RATCHETJQ_SCANNER_MAX_N: '8',
      RATCHETJQ_SCANNER_MIN_N: '3',
      RATCHETJQ_SCANNER_SLOT_TTL_SECONDS: '20',
      RATCHETJQ_SCANNER_SLOT_RENEW_SECONDS: '15',
      RATCHETJQ_EMPTY_ROUND_LIMIT: '9',
      RATCHETJQ_EMPTY_ROUND_SLEEP_MS: '2500',
      RATCHETJQ_TIME_TO_FORCE_SECONDS: '45',
      RATCHETJQ_MAX_UNFINISHED_PER_EXECUTOR: '500',
    })

    expect(config).toEqual({
      attemptMaxN: 7,
      claimBatchSize: 25,
      acceptMaxN: 4,
      maxBlockSeconds: 30,
      blockingCommandTimeoutBufferMs: 1_500,
      scannerMaxN: 8,
      scannerMinN: 3,
      scannerSlotTtlSeconds: 20,
      scannerSlotRenewSeconds: 15,
      emptyRoundLimit: 9,
      emptyRoundSleepMs: 2_500,
      timeToForceSeconds: 45,
      maxUnfinishedPerExecutor: 500,
    })
  })

  // A queue no deeper than one claim refuses work the executor was about to take
  // anyway: the first claim after a submission can pull a whole batch, so a limit
  // at or below that caps throughput rather than backlog.
  it('refuses a queue limit that does not exceed one claim batch', () => {
    expect(() =>
      ratchetjqConfig({ RATCHETJQ_CLAIM_BATCH_SIZE: '100', RATCHETJQ_MAX_UNFINISHED_PER_EXECUTOR: '100' }),
    ).toThrow('must exceed RATCHETJQ_CLAIM_BATCH_SIZE')
  })

  // The pool's ceiling below its floor makes the ceiling unreachable, so no
  // Scanner could ever start; a floor of one leaves the run segment's global
  // backstop resting on a single process.
  it('refuses a Scanner pool whose bracket is impossible', () => {
    expect(() => ratchetjqConfig({ RATCHETJQ_SCANNER_MAX_N: '1' })).toThrow('RATCHETJQ_SCANNER_MAX_N')
    expect(() => ratchetjqConfig({ RATCHETJQ_SCANNER_MIN_N: '1' })).toThrow('at least 2')
  })

  // The accept ceiling is a fan-out width, so above the claim batch it would have
  // one accept round taking more rows than a whole claim does — and each of those
  // rows costs an acceptor call, not part of a statement.
  it('refuses an accept ceiling above the claim batch', () => {
    expect(() => ratchetjqConfig({ RATCHETJQ_CLAIM_BATCH_SIZE: '8', RATCHETJQ_ACCEPT_MAX_N: '9' })).toThrow(
      'RATCHETJQ_ACCEPT_MAX_N',
    )
    expect(() => ratchetjqConfig({ RATCHETJQ_CLAIM_BATCH_SIZE: '8', RATCHETJQ_ACCEPT_MAX_N: '8' })).not.toThrow()
  })

  // Renewing no sooner than the slot expires lets it lapse between renewals, so
  // another process takes the slot while this Scanner is still scanning.
  it('refuses a renewal period that does not beat the slot TTL', () => {
    expect(() =>
      ratchetjqConfig({ RATCHETJQ_SCANNER_SLOT_TTL_SECONDS: '20', RATCHETJQ_SCANNER_SLOT_RENEW_SECONDS: '20' }),
    ).toThrow('RATCHETJQ_SCANNER_SLOT_RENEW_SECONDS')
    expect(() =>
      ratchetjqConfig({ RATCHETJQ_SCANNER_SLOT_TTL_SECONDS: '20', RATCHETJQ_SCANNER_SLOT_RENEW_SECONDS: '25' }),
    ).toThrow('must be below')
  })

  // A malformed count must not boot. A batch size of NaN takes no rows and a
  // wait of NaN would be passed to BRPOP, and both look deliberate in an env
  // file — refusing at boot is the last point either is still visible.
  it('refuses a malformed count instead of coercing it', () => {
    expect(() => ratchetjqConfig({ RATCHETJQ_MAX_BLOCK_SECONDS: '1e9' })).toThrow('RATCHETJQ_MAX_BLOCK_SECONDS')
    expect(() => ratchetjqConfig({ RATCHETJQ_CLAIM_BATCH_SIZE: 'lots' })).toThrow('RATCHETJQ_CLAIM_BATCH_SIZE')
  })

  // Zero headroom would make ioredis and the Redis server race on every idle
  // wait, and a zero-second cap would hand BRPOP a timeout that blocks forever.
  it('refuses zero for the wait cap and the timeout headroom', () => {
    expect(() => ratchetjqConfig({ RATCHETJQ_MAX_BLOCK_SECONDS: '0' })).toThrow('at least 1')
    expect(() => ratchetjqConfig({ RATCHETJQ_BLOCKING_COMMAND_TIMEOUT_BUFFER_MS: '0' })).toThrow('at least 1')
  })
})
