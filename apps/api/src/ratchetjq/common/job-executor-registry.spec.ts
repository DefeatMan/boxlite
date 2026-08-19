/*
 * Copyright 2026 BoxLite AI
 * SPDX-License-Identifier: AGPL-3.0
 */

import { RatchetJQExecutor } from '../enums/ratchetjq-executor.enum'
import { ISyncJobExecutor, RatchetJQSyncRunOutcome } from './job-executor'
import { RatchetJQJobExecutorRegistry } from './job-executor-registry'

/**
 * An executor of one kind and nothing else. The arguments are left off, which
 * TypeScript allows an implementation to do: what the registry is asked about is
 * the kind, and a stub that took a job would only be pretending to run one.
 */
class StubExecutor implements ISyncJobExecutor {
  constructor(readonly executor: string) {}

  async syncRun(): Promise<RatchetJQSyncRunOutcome> {
    return { status: 'ok', outParams: null }
  }
}

describe('RatchetJQJobExecutorRegistry', () => {
  it('hands back the executor registered for a kind', () => {
    const runner = new StubExecutor(RatchetJQExecutor.RUNNER)
    const registry = new RatchetJQJobExecutorRegistry([runner])

    expect(registry.executorFor(RatchetJQExecutor.RUNNER)).toBe(runner)
  })

  // Undefined and not a throw: only the caller knows whether it needs a push at
  // all, and the pulled path needs none.
  it('answers undefined for a kind it cannot push to', () => {
    const registry = new RatchetJQJobExecutorRegistry([new StubExecutor(RatchetJQExecutor.RUNNER)])

    expect(registry.executorFor('sandbox-farm')).toBeUndefined()
  })

  // Both refusals happen at process start rather than on the first submission
  // naming the kind, since a submission is a side effect waiting to happen.
  it('refuses an executor that reports no kind', () => {
    expect(() => new RatchetJQJobExecutorRegistry([new StubExecutor('')])).toThrow('empty executor kind')
  })

  it('refuses two executors claiming one kind', () => {
    const executors = [new StubExecutor(RatchetJQExecutor.RUNNER), new StubExecutor(RatchetJQExecutor.RUNNER)]

    expect(() => new RatchetJQJobExecutorRegistry(executors)).toThrow('claim the kind "runner"')
  })
})
