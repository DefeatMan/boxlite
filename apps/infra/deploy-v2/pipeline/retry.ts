// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (c) 2026 BoxLite AI

/*
 * Retry for the one thing in a Pulumi program that can be retried.
 *
 * A module's resource declarations are registrations, not calls: re-running them after a failure
 * re-registers the same URNs and the engine rejects the duplicate. What CAN fail transiently and
 * be repeated safely is the async work a module does BEFORE it declares anything — an AWS lookup,
 * a builder import. pipeline/run.ts retries only that phase, with the policy each job carries in
 * pipeline.yml; apply-time failures stay Pulumi's to retry.
 *
 * Shaped after deployment/verify.ts's verifyWithRetry (attempts / delay / onRetry / injectable
 * sleep), with exponential backoff added because a cold IAM propagation wants a longer second
 * wait than its first.
 */

export interface RetryPolicy {
  /** Total tries, not retries: 1 means run once and surface the first failure. */
  attempts: number
  /** Wait before the second try. Each later wait doubles, capped at maxDelayMs. */
  delayMs: number
  maxDelayMs: number
}

export interface RetryAttemptEvent {
  error: unknown
  attempt: number
  nextAttempt: number
  attempts: number
  delayMs: number
}

export interface RetryOptions {
  signal?: AbortSignal
  onRetry?: (event: RetryAttemptEvent) => void
  sleep?: (delayMs: number, signal?: AbortSignal) => Promise<void>
}

export const DEFAULT_RETRY_POLICY: RetryPolicy = {
  attempts: 3,
  delayMs: 2_000,
  maxDelayMs: 30_000,
}

export function validateRetryPolicy(policy: RetryPolicy, source: string): RetryPolicy {
  if (!Number.isInteger(policy.attempts) || policy.attempts < 1) {
    throw new Error(`${source}: retry attempts must be a positive integer, received ${policy.attempts}`)
  }
  if (!Number.isFinite(policy.delayMs) || policy.delayMs < 0) {
    throw new Error(`${source}: retry delay must be a non-negative number of ms, received ${policy.delayMs}`)
  }
  if (!Number.isFinite(policy.maxDelayMs) || policy.maxDelayMs < policy.delayMs) {
    throw new Error(
      `${source}: retry max delay must be a number of ms no smaller than the delay ` +
        `(${policy.delayMs}), received ${policy.maxDelayMs}`,
    )
  }
  return policy
}

/** Wait before `attempt` (1-based). Doubles per elapsed retry, capped at the policy ceiling. */
export function backoffDelayMs(policy: RetryPolicy, attempt: number): number {
  const doublings = Math.max(0, attempt - 1)
  // Clamped before the shift: a large delay with many attempts would otherwise overflow to
  // Infinity and make the cap the only thing keeping the wait finite.
  const scaled = policy.delayMs * 2 ** Math.min(doublings, 30)
  return Math.min(scaled, policy.maxDelayMs)
}

export function abortReason(signal: AbortSignal): Error {
  const reason: unknown = signal.reason
  if (reason instanceof Error) return reason
  return new Error(typeof reason === 'string' && reason ? reason : 'operation aborted')
}

function wait(delayMs: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    if (!signal) {
      setTimeout(resolve, delayMs)
      return
    }
    const timer = setTimeout(() => {
      signal.removeEventListener('abort', onAbort)
      resolve()
    }, delayMs)
    const onAbort = () => {
      clearTimeout(timer)
      reject(abortReason(signal))
    }
    signal.addEventListener('abort', onAbort, { once: true })
  })
}

export async function withRetry<T>(
  operation: () => Promise<T> | T,
  policy: RetryPolicy,
  options: RetryOptions = {},
): Promise<T> {
  const { signal, onRetry = () => {}, sleep = wait } = options
  validateRetryPolicy(policy, 'withRetry')

  for (let attempt = 1; attempt <= policy.attempts; attempt++) {
    if (signal?.aborted) throw abortReason(signal)
    try {
      return await operation()
    } catch (error) {
      // An abort mid-flight is the caller withdrawing the request, not a transient fault: report
      // the abort rather than spending the remaining attempts on a cancelled operation.
      if (signal?.aborted) throw abortReason(signal)
      if (attempt === policy.attempts) throw error
      const delayMs = backoffDelayMs(policy, attempt)
      onRetry({ error, attempt, nextAttempt: attempt + 1, attempts: policy.attempts, delayMs })
      await sleep(delayMs, signal)
    }
  }

  throw new Error('withRetry exhausted its loop without a result')
}
