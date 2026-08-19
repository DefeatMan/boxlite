/*
 * Copyright 2026 BoxLite AI
 * SPDX-License-Identifier: AGPL-3.0
 */

import { Inject, Injectable } from '@nestjs/common'
import { ISyncJobExecutor } from './job-executor'

/**
 * The provider token carrying every executor kind this process can push to.
 *
 * A token rather than a `register` call, for the reason the acceptor list gives
 * (`job-acceptor-registry.ts:22`): it makes the list a declaration in the module
 * instead of a side effect timed against startup, and an executor that needs a
 * repository or an HTTP client is built by the injector like anything else.
 */
export const RATCHETJQ_JOB_EXECUTORS = 'RATCHETJQ_JOB_EXECUTORS'

/**
 * Maps an executor kind to the implementation that pushes a job to it — the
 * spec's `Executor(x.executor)`.
 *
 * It exists so that `Exec(sync)` names a kind and gets a transport, instead of
 * naming a class. That is the whole of what the indirection buys: the submitter
 * already carries `executor` as data on its way into the job table, so the push
 * that follows should be chosen by that same value rather than by a dependency
 * the proposer happens to hold.
 *
 * Unlike the acceptor registry it hands back a typed ISyncJobExecutor rather than
 * something a driver has to narrow, because there is only one form of push. A
 * second form would move that choice back out to drivers, and this signature is
 * the thing that would change.
 */
@Injectable()
export class RatchetJQJobExecutorRegistry {
  private readonly executors = new Map<string, ISyncJobExecutor>()

  constructor(@Inject(RATCHETJQ_JOB_EXECUTORS) executors: ISyncJobExecutor[]) {
    for (const executor of executors) {
      this.register(executor)
    }
  }

  /**
   * The executor for a kind, or undefined when this process cannot push to that
   * kind at all.
   *
   * Undefined rather than a throw, because the callers differ in what they can do
   * about it: a synchronous submission has to refuse, while anything that only
   * queues work is unaffected — the pulled path needs no push implementation.
   */
  executorFor(kind: string): ISyncJobExecutor | undefined {
    return this.executors.get(kind)
  }

  /**
   * Adds one executor, keyed by the kind its own `executor` reports.
   *
   * The two things checkable once are checked here at process start rather than
   * on the first submission naming the kind: an empty name, and a second claim on
   * a name already taken. That a registered executor actually implements
   * `syncRun` is the injected list's own type — the compiler refuses the module
   * factory otherwise, so it needs no check of its own.
   */
  private register(executor: ISyncJobExecutor): void {
    if (!executor.executor) {
      throw new Error('A RatchetJQ job executor reported an empty executor kind')
    }
    if (this.executors.has(executor.executor)) {
      throw new Error(`Two RatchetJQ job executors claim the kind "${executor.executor}"`)
    }

    this.executors.set(executor.executor, executor)
  }
}
