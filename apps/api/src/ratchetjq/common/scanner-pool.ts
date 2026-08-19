/*
 * Copyright 2026 BoxLite AI
 * SPDX-License-Identifier: AGPL-3.0
 */

import { InjectRedis } from '@nestjs-modules/ioredis'
import { Injectable, Logger } from '@nestjs/common'
import { Redis } from 'ioredis'
import { TypedConfigService } from '../../config/typed-config.service'

/**
 * The Scanner pool's Redis hash (spec §7): one field per proposer process that
 * currently holds a Scanner, so the live field count is the pool size.
 *
 * Lower-case by convention, like every Redis key in this project.
 */
const POOL_KEY = 'ratchetjq:scanner:proposer'

/**
 * Each field holds the epoch second its slot lapses, and a slot is live only
 * while that moment is still ahead. The spec expresses the same thing with a
 * per-field TTL (`HEXPIRE hash 30 FIELDS 1 field`), which needs Redis 7.4 —
 * newer than the engine an ElastiCache deployment may be running, and a claim
 * against an older server fails with an unknown-command error rather than
 * degrading. Holding the deadline in the value keeps the semantics on any
 * server that can run a script.
 *
 * The cost is that expiry is not automatic, so every operation that depends on
 * an accurate count drops lapsed fields before counting. Both do it inside one
 * script, because a purge that is not atomic with the count it feeds would let
 * two processes each read a pool with room for one more.
 */
const PURGE_LAPSED_FIELDS = `
  local now = tonumber(redis.call('TIME')[1])
  local entries = redis.call('HGETALL', KEYS[1])
  for index = 1, #entries, 2 do
    if tonumber(entries[index + 1]) <= now then
      redis.call('HDEL', KEYS[1], entries[index])
    end
  end
`

/**
 * Takes a slot for this process, or reports that it may not have one.
 *
 * Refuses on two grounds, and deliberately does not distinguish them to the
 * caller: this process already holds a Scanner, or the pool is at its ceiling.
 * Either way the answer is "do not start one".
 */
const ACQUIRE_SLOT = `
  ${PURGE_LAPSED_FIELDS}
  if redis.call('HEXISTS', KEYS[1], ARGV[1]) == 1 then
    return 0
  end
  if redis.call('HLEN', KEYS[1]) >= tonumber(ARGV[3]) then
    return 0
  end
  redis.call('HSET', KEYS[1], ARGV[1], now + tonumber(ARGV[2]))
  return 1
`

/**
 * Pushes this process's slot deadline out, and reports whether the slot was
 * still there to push.
 *
 * A zero means the slot lapsed and was purged — this process stalled longer than
 * the TTL — and the Scanner it belongs to has to stop, because the pool has
 * already stopped counting it and another process may have started one in its
 * place.
 */
const RENEW_SLOT = `
  local now = tonumber(redis.call('TIME')[1])
  if redis.call('HEXISTS', KEYS[1], ARGV[1]) == 0 then
    return 0
  end
  redis.call('HSET', KEYS[1], ARGV[1], now + tonumber(ARGV[2]))
  return 1
`

/** Live slots, lapsed ones dropped first so the count can be trusted. */
const COUNT_LIVE_SLOTS = `
  ${PURGE_LAPSED_FIELDS}
  return redis.call('HLEN', KEYS[1])
`

/**
 * The Scanner pool (spec §7): who may run a Scanner, and how many are up.
 *
 * Two constants bracket the pool. The ceiling stops a burst of reports spawning
 * a Scanner apiece; the floor stops idle Scanners retiring until none is left,
 * because this loop is the only global scanner and its liveness is what lets the
 * system recover from a runner that has gone silent.
 *
 * Nothing here tops the pool up: a slot freed by a crash is refilled by the next
 * report that calls the wake-up, which is also the only thing that ever grows
 * the pool.
 */
@Injectable()
export class RatchetJQScannerPool {
  private readonly logger = new Logger(RatchetJQScannerPool.name)

  constructor(
    @InjectRedis() private readonly redis: Redis,
    private readonly configService: TypedConfigService,
  ) {}

  /**
   * Tries to take this process's slot. False means it must not start a Scanner —
   * either it already has one, or the pool is full.
   */
  async acquire(proposerId: string): Promise<boolean> {
    const taken = await this.redis.eval(
      ACQUIRE_SLOT,
      1,
      POOL_KEY,
      proposerId,
      this.slotTtlSeconds(),
      this.configService.get('ratchetjq.scannerMaxN'),
    )

    return taken === 1
  }

  /**
   * Renews this process's slot. False means the slot is gone and the Scanner
   * holding it must stop rather than keep scanning uncounted.
   */
  async renew(proposerId: string): Promise<boolean> {
    const renewed = await this.redis.eval(RENEW_SLOT, 1, POOL_KEY, proposerId, this.slotTtlSeconds())

    return renewed === 1
  }

  /** How many Scanners are up, which is what the exit floor is compared to. */
  async liveCount(): Promise<number> {
    return (await this.redis.eval(COUNT_LIVE_SLOTS, 1, POOL_KEY)) as number
  }

  /**
   * Gives this process's slot back. Best effort: a slot that outlives its holder
   * is reclaimed when it lapses, so failing to release costs at most one TTL of
   * a pool that looks fuller than it is.
   */
  async release(proposerId: string): Promise<void> {
    try {
      await this.redis.hdel(POOL_KEY, proposerId)
    } catch (error) {
      this.logger.warn(`Failed to release the RatchetJQ Scanner slot for ${proposerId}: ${error.message}`)
    }
  }

  /** Whether the pool is above its floor, so an idle Scanner may retire. */
  async isAboveFloor(): Promise<boolean> {
    return (await this.liveCount()) > this.configService.get('ratchetjq.scannerMinN')
  }

  private slotTtlSeconds(): number {
    return this.configService.get('ratchetjq.scannerSlotTtlSeconds')
  }
}
