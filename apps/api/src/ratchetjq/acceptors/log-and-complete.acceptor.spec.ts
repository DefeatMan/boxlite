/*
 * Copyright 2026 BoxLite AI
 * SPDX-License-Identifier: AGPL-3.0
 */

import { Logger } from '@nestjs/common'
import { RatchetJQAcceptVerdict } from '../common/job-acceptor'
import { RatchetJQJob } from '../entities/ratchetjq-job.entity'
import { ECHO_JOB_TYPE, LogAndCompleteAcceptor } from './log-and-complete.acceptor'

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

    await new LogAndCompleteAcceptor().accept(JOB)

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

    await new LogAndCompleteAcceptor().accept({ id: 'job-2' } as unknown as RatchetJQJob)

    const [message] = written.mock.calls[0] as [string]
    expect(message).toContain('inParams=null')
    expect(message).toContain('outParams=null')

    written.mockRestore()
  })

  it('accepts unconditionally', async () => {
    await expect(new LogAndCompleteAcceptor().accept(JOB)).resolves.toBe(RatchetJQAcceptVerdict.ACCEPTED)
  })
})
