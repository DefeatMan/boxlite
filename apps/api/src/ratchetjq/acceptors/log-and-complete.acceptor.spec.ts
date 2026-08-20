/*
 * Copyright 2026 BoxLite AI
 * SPDX-License-Identifier: AGPL-3.0
 */

import { Logger } from '@nestjs/common'
import {
  AsyncAcceptor,
  isAsyncJobAcceptor,
  isSyncJobAcceptor,
  RatchetJQAcceptVerdict,
  SyncAcceptor,
} from '../common/job-acceptor'
import { RatchetJQJob } from '../entities/ratchetjq-job.entity'
import { ECHO_JOB_TYPE, LogAndCompleteAcceptor } from './log-and-complete.acceptor'

/** A signal that never aborts: this acceptor waits on nothing to abandon. */
function liveSignal(): AbortSignal {
  return new AbortController().signal
}

const JOB = {
  id: 'job-1',
  type: ECHO_JOB_TYPE,
  inParams: { message: 'hello' },
  outParams: { message: 'hello' },
} as unknown as RatchetJQJob

describe('LogAndCompleteAcceptor', () => {
  it('serves the job type the runner registers its echo job under', () => {
    expect(new LogAndCompleteAcceptor().type).toBe('echo')
  })

  it('writes down the job id and both param sets', async () => {
    const written = jest.spyOn(Logger.prototype, 'log').mockImplementation(() => undefined)

    await new LogAndCompleteAcceptor().syncAccept(JOB)

    expect(written).toHaveBeenCalledTimes(1)
    const [message] = written.mock.calls[0] as [string]
    expect(message).toContain('job-1')
    expect(message).toContain(`inParams={"message":"hello"}`)
    expect(message).toContain(`outParams={"message":"hello"}`)

    written.mockRestore()
  })

  // A job may reach accept before it has params of its own, and a log line
  // reading `undefined` would look like the acceptor lost them.
  it('writes null for params the job does not carry', async () => {
    const written = jest.spyOn(Logger.prototype, 'log').mockImplementation(() => undefined)

    await new LogAndCompleteAcceptor().syncAccept({ id: 'job-2' } as unknown as RatchetJQJob)

    const [message] = written.mock.calls[0] as [string]
    expect(message).toContain('inParams=null')
    expect(message).toContain('outParams=null')

    written.mockRestore()
  })

  it('accepts unconditionally', async () => {
    await expect(new LogAndCompleteAcceptor().syncAccept(JOB)).resolves.toBe(RatchetJQAcceptVerdict.ACCEPTED)
  })

  it('implements the inline form only', () => {
    const acceptor = new LogAndCompleteAcceptor()

    expect(isSyncJobAcceptor(acceptor)).toBe(true)
    expect(isAsyncJobAcceptor(acceptor)).toBe(false)
  })

  // Both wrappers have to be able to reach it: SyncAcceptor is Report's inline
  // path, and AsyncAcceptor's adaptation is what the Scanner's accept segment
  // uses. Deciding without awaiting anything is exactly the shape that adaptation
  // exists for.
  it('is reachable through both acceptors', async () => {
    const acceptor = new LogAndCompleteAcceptor()
    jest.spyOn(Logger.prototype, 'log').mockImplementation(() => undefined)

    await expect(SyncAcceptor.accept(acceptor, JOB, liveSignal())).resolves.toBe(RatchetJQAcceptVerdict.ACCEPTED)

    await expect(AsyncAcceptor.accept(acceptor, JOB, liveSignal())).resolves.toBe(RatchetJQAcceptVerdict.ACCEPTED)

    jest.restoreAllMocks()
  })
})
