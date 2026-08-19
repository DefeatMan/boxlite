/*
 * Copyright 2026 BoxLite AI
 * SPDX-License-Identifier: AGPL-3.0
 */

import { ForbiddenException } from '@nestjs/common'
import { AuthContext, BaseAuthContext } from '../../common/interfaces/auth-context.interface'
import { RunnerContext } from '../../common/interfaces/runner-context.interface'
import { SystemRole } from '../../user/enums/system-role.enum'
import { RatchetJQExecutor } from '../enums/ratchetjq-executor.enum'
import { resolveExecutorIdentity } from './executor-identity'

function runnerContext(runnerId: string): RunnerContext {
  return { role: 'runner', runnerId, runner: { id: runnerId } as never }
}

describe('resolveExecutorIdentity', () => {
  it('reads a runner as the runner executor kind', () => {
    expect(resolveExecutorIdentity(runnerContext('r1'))).toEqual({
      executor: RatchetJQExecutor.RUNNER,
      executorId: 'r1',
    })
  })

  // The kind has to come from the role, not from the presence of an id. A user
  // context carries an OPTIONAL runnerId of its own, so reading the id without
  // checking the role would let an ordinary caller claim an executor's queue.
  it('refuses a user context even when it carries a runnerId', () => {
    const user: AuthContext = {
      role: SystemRole.USER,
      userId: 'u1',
      email: 'u1@example.com',
      runnerId: 'r1',
    }

    expect(() => resolveExecutorIdentity(user)).toThrow(ForbiddenException)
  })

  it('refuses a caller that is authenticated but is not an executor', () => {
    const proxy: BaseAuthContext = { role: 'proxy' }

    expect(() => resolveExecutorIdentity(proxy)).toThrow(ForbiddenException)
  })

  // Nothing should fall back to a default executor: an executorId only means
  // anything beside the kind it came from.
  it('refuses an absent context rather than defaulting', () => {
    expect(() => resolveExecutorIdentity(undefined)).toThrow(ForbiddenException)
  })
})
