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
      maxBlockSeconds: 60,
      blockingCommandTimeoutBufferMs: 3_000,
    })
  })

  it('takes each setting from its own variable', () => {
    const config = ratchetjqConfig({
      RATCHETJQ_ATTEMPT_MAX_N: '7',
      RATCHETJQ_CLAIM_BATCH_SIZE: '25',
      RATCHETJQ_MAX_BLOCK_SECONDS: '30',
      RATCHETJQ_BLOCKING_COMMAND_TIMEOUT_BUFFER_MS: '1500',
    })

    expect(config).toEqual({
      attemptMaxN: 7,
      claimBatchSize: 25,
      maxBlockSeconds: 30,
      blockingCommandTimeoutBufferMs: 1_500,
    })
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
