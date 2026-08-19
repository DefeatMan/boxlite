/*
 * Copyright 2026 BoxLite AI
 * SPDX-License-Identifier: AGPL-3.0
 */

import { ForbiddenException } from '@nestjs/common'
import { BaseAuthContext } from '../../common/interfaces/auth-context.interface'
import { isRunnerContext } from '../../common/interfaces/runner-context.interface'
import { RatchetJQExecutor } from '../enums/ratchetjq-executor.enum'

/**
 * Which executor instance a request speaks for: the two columns that together
 * say whose jobs may be claimed.
 *
 * They travel as a pair because they have to agree — both claim indexes and the
 * dedup key lead with `executor` then `executorId`, so a kind paired with
 * another kind's id would silently address rows nobody owns.
 */
export interface ExecutorIdentity {
  executor: RatchetJQExecutor
  executorId: string
}

/**
 * Reads the executor identity off the authenticated caller.
 *
 * This is the one place that decides which callers are executors, and it is the
 * authorization point for claiming: authentication has already happened by the
 * time it runs, so what it refuses is a valid caller that is not an executor at
 * all. A second kind of executor is a branch here plus a member of
 * `RatchetJQExecutor` — deliberately not a guard on each controller, which is
 * what made `'runner'` a literal at the call site in the first place.
 *
 * It refuses rather than defaulting, because defaulting would hand one
 * executor's queue to whoever asked: `executorId` is only meaningful next to the
 * kind it came from.
 */
export function resolveExecutorIdentity(auth: BaseAuthContext | undefined): ExecutorIdentity {
  if (auth) {
    if (isRunnerContext(auth)) {
      return { executor: RatchetJQExecutor.RUNNER, executorId: auth.runnerId }
    }
  }

  throw new ForbiddenException('Only an executor may claim RatchetJQ jobs')
}
