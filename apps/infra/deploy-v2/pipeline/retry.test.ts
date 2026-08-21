// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (c) 2026 BoxLite AI

import assert from 'node:assert/strict'
import test from 'node:test'

import { DEFAULT_RETRY_POLICY, backoffDelayMs, validateRetryPolicy, withRetry } from './retry.js'

const POLICY = { attempts: 4, delayMs: 100, maxDelayMs: 400 }
const noSleep = async () => {}

test('returns the first success without sleeping', async () => {
  const slept: number[] = []
  let calls = 0

  const result = await withRetry(
    () => {
      calls += 1
      return 'ok'
    },
    POLICY,
    { sleep: async (delayMs) => void slept.push(delayMs) },
  )

  assert.equal(result, 'ok')
  assert.equal(calls, 1)
  assert.deepEqual(slept, [])
})

test('retries a transient failure and reports each wait', async () => {
  const slept: number[] = []
  const observed: number[] = []
  let calls = 0

  const result = await withRetry(
    () => {
      calls += 1
      if (calls < 3) throw new Error(`cold start ${calls}`)
      return calls
    },
    POLICY,
    {
      sleep: async (delayMs) => void slept.push(delayMs),
      onRetry: ({ nextAttempt }) => observed.push(nextAttempt),
    },
  )

  assert.equal(result, 3)
  assert.equal(calls, 3)
  // Doubling: 100 before the second try, 200 before the third.
  assert.deepEqual(slept, [100, 200])
  assert.deepEqual(observed, [2, 3])
})

test('surfaces the final failure once the attempts are spent', async () => {
  let calls = 0

  await assert.rejects(
    withRetry(
      () => {
        calls += 1
        throw new Error(`attempt ${calls}`)
      },
      POLICY,
      { sleep: noSleep },
    ),
    /attempt 4/,
  )
  assert.equal(calls, POLICY.attempts)
})

test('runs a single-attempt policy exactly once', async () => {
  let calls = 0

  await assert.rejects(
    withRetry(
      () => {
        calls += 1
        throw new Error('no retry configured')
      },
      { attempts: 1, delayMs: 0, maxDelayMs: 0 },
      { sleep: noSleep },
    ),
    /no retry configured/,
  )
  assert.equal(calls, 1)
})

test('caps the wait at the policy ceiling instead of doubling forever', () => {
  const policy = { attempts: 10, delayMs: 1_000, maxDelayMs: 5_000 }
  assert.deepEqual(
    [1, 2, 3, 4, 5, 6].map((attempt) => backoffDelayMs(policy, attempt)),
    [1_000, 2_000, 4_000, 5_000, 5_000, 5_000],
  )
  // A policy that would overflow a naive shift still yields a finite, capped wait.
  assert.equal(backoffDelayMs({ attempts: 200, delayMs: 1_000, maxDelayMs: 9_000 }, 180), 9_000)
})

test('stops retrying when the caller aborts mid-flight', async () => {
  const controller = new AbortController()
  let calls = 0

  await assert.rejects(
    withRetry(
      () => {
        calls += 1
        controller.abort(new Error('deploy cancelled'))
        throw new Error('transient')
      },
      POLICY,
      { signal: controller.signal, sleep: noSleep },
    ),
    /deploy cancelled/,
  )
  // The abort is reported instead of the transient error, and the remaining attempts are not spent.
  assert.equal(calls, 1)
})

test('refuses a policy that could never make progress', () => {
  assert.throws(() => validateRetryPolicy({ ...POLICY, attempts: 0 }, 'jobs.x.with'), /attempts must be a positive/)
  assert.throws(() => validateRetryPolicy({ ...POLICY, attempts: 1.5 }, 'jobs.x.with'), /attempts must be a positive/)
  assert.throws(() => validateRetryPolicy({ ...POLICY, delayMs: -1 }, 'jobs.x.with'), /delay must be a non-negative/)
  assert.throws(
    () => validateRetryPolicy({ attempts: 2, delayMs: 5_000, maxDelayMs: 1_000 }, 'jobs.x.with'),
    /max delay must be a number of ms no smaller than the delay \(5000\)/,
  )
  assert.equal(validateRetryPolicy(DEFAULT_RETRY_POLICY, 'default'), DEFAULT_RETRY_POLICY)
})
