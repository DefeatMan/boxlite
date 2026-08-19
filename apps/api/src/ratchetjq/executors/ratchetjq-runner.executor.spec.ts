/*
 * Copyright 2026 BoxLite AI
 * SPDX-License-Identifier: AGPL-3.0
 */

import axios from 'axios'
import { Runner } from '../../box/entities/runner.entity'
import { RatchetJQJob } from '../entities/ratchetjq-job.entity'
import { RatchetJQExecutor } from '../enums/ratchetjq-executor.enum'
import { RatchetJQExecutorUnreachableError } from '../errors/ratchetjq-executor-unreachable.error'
import { RatchetJQRunnerExecutor } from './ratchetjq-runner.executor'

const JOB = {
  id: 'job-1',
  type: 'echo',
  resourceId: 'box-1',
  ttlSeconds: 30,
  inParams: { message: 'hello' },
} as unknown as RatchetJQJob

const RUNNER = { id: 'runner-1', apiUrl: 'https://runner-1.internal', apiKey: 'secret' } as Runner

/**
 * Builds the executor over a stub axios instance.
 *
 * The generated client calls `request` on whatever instance it is handed and
 * reads `defaults.baseURL` to decide whether to prefix the path, so those two are
 * the whole of the surface a stub has to offer.
 */
function makeExecutor(options: { runner?: Runner | null; response?: unknown; requestFails?: Error } = {}) {
  const request = jest.fn(async () => {
    if (options.requestFails) {
      throw options.requestFails
    }
    return { data: options.response ?? { id: 'job-1', status: 'ok', outParams: { message: 'hello' } } }
  })
  const instance = { request, defaults: { baseURL: RUNNER.apiUrl } }
  const create = jest.spyOn(axios, 'create').mockReturnValue(instance as never)

  const runners = { findOne: jest.fn(async () => (options.runner === undefined ? RUNNER : options.runner)) }
  const executor = new RatchetJQRunnerExecutor(runners as never)

  const sent = (): { url: string; method: string; body: Record<string, unknown> } => {
    const [config] = request.mock.calls[0] as unknown as [{ url: string; method: string; data: string }]
    return { url: config.url, method: config.method, body: JSON.parse(config.data) }
  }

  return { executor, runners, create, request, sent }
}

afterEach(() => {
  jest.restoreAllMocks()
})

describe('RatchetJQRunnerExecutor', () => {
  // The kind is how the registry finds it, and it has to match the value a
  // submission writes into `ratchetjq_job.executor` or the push resolves to
  // nothing.
  it('answers for the runner kind', () => {
    const { executor } = makeExecutor()

    expect(executor.executor).toBe(RatchetJQExecutor.RUNNER)
  })

  it('posts the job to the executor that owns it', async () => {
    const { executor, runners, sent } = makeExecutor()

    await executor.syncRun('runner-1', JOB)

    expect(runners.findOne).toHaveBeenCalledWith({ where: { id: 'runner-1' } })
    expect(sent()).toMatchObject({
      url: '/ratchetjq/jobs/sync',
      method: 'POST',
      body: { id: 'job-1', type: 'echo', resourceId: 'box-1', inParams: { message: 'hello' } },
    })
  })

  it("addresses that runner's own API with its own key", async () => {
    const { executor, create } = makeExecutor()

    await executor.syncRun('runner-1', JOB)

    expect(create).toHaveBeenCalledWith(
      expect.objectContaining({
        baseURL: 'https://runner-1.internal',
        headers: { Authorization: 'Bearer secret' },
      }),
    )
  })

  // The bound is the lease the row holds, not a flat ceiling: past it the job is
  // claimable again, so a caller still waiting would be waiting on a round that
  // has stopped being its own.
  it('waits no longer than the lease the job holds', async () => {
    const { executor, create } = makeExecutor()

    await executor.syncRun('runner-1', { ...JOB, ttlSeconds: 45 })

    expect(create).toHaveBeenCalledWith(expect.objectContaining({ timeout: 45_000 }))
  })

  // The caller's deadline has to reach axios rather than be checked before the
  // call, or it stops being a cancellation: the runner runs the job on its request
  // context, so aborting the request is also what stops the far side.
  it("carries the caller's deadline into the request", async () => {
    const { executor, request } = makeExecutor()
    const deadline = AbortSignal.timeout(30_000)

    await executor.syncRun('runner-1', JOB, deadline)

    const [config] = request.mock.calls[0] as unknown as [{ signal?: AbortSignal }]
    expect(config.signal).toBe(deadline)
  })

  // Both bounds stay: the job's own budget and the caller's patience are different
  // limits, and whichever comes first should end the call.
  it('keeps the lease bound when a deadline is given too', async () => {
    const { executor, create } = makeExecutor()

    await executor.syncRun('runner-1', { ...JOB, ttlSeconds: 45 }, AbortSignal.timeout(30_000))

    expect(create).toHaveBeenCalledWith(expect.objectContaining({ timeout: 45_000 }))
  })

  it('hands back the status and outParams the executor reported', async () => {
    const { executor } = makeExecutor({ response: { id: 'job-1', status: 'ok', outParams: { echoed: 1 } } })

    await expect(executor.syncRun('runner-1', JOB)).resolves.toEqual({
      status: 'ok',
      outParams: { echoed: 1 },
      errMsg: null,
    })
  })

  it('reports no outParams as null rather than undefined', async () => {
    const { executor } = makeExecutor({ response: { id: 'job-1', status: 'ok' } })

    await expect(executor.syncRun('runner-1', JOB)).resolves.toEqual({ status: 'ok', outParams: null, errMsg: null })
  })

  // Absent, not null: the far side binds this into a Go struct, where an omitted
  // field leaves the job's own zero value and a null has to be decoded as one.
  it('leaves inParams out entirely when the job carries none', async () => {
    const { executor, sent } = makeExecutor()

    await executor.syncRun('runner-1', { ...JOB, inParams: null })

    expect('inParams' in sent().body).toBe(false)
  })

  it('refuses to push to a runner that does not exist', async () => {
    const { executor, request } = makeExecutor({ runner: null })

    await expect(executor.syncRun('runner-9', JOB)).rejects.toBeInstanceOf(RatchetJQExecutorUnreachableError)
    expect(request).not.toHaveBeenCalled()
  })

  it('refuses to push to a runner with no API URL', async () => {
    const { executor, request } = makeExecutor({ runner: { ...RUNNER, apiUrl: null } as Runner })

    await expect(executor.syncRun('runner-1', JOB)).rejects.toThrow('no API URL')
    expect(request).not.toHaveBeenCalled()
  })

  it('names the job and the executor when it cannot reach one', async () => {
    const { executor } = makeExecutor({ runner: null })

    await expect(executor.syncRun('runner-9', JOB)).rejects.toMatchObject({
      jobId: 'job-1',
      executorId: 'runner-9',
    })
  })

  // A push that timed out or was refused travels: the row is still leased, and
  // only the caller knows whether it can wait for the pulled path to take it.
  it('propagates a failed call to its caller', async () => {
    const timedOut = Object.assign(new Error('timeout of 30000ms exceeded'), { code: 'ECONNABORTED' })
    const { executor } = makeExecutor({ requestFails: timedOut })

    await expect(executor.syncRun('runner-1', JOB)).rejects.toBe(timedOut)
  })
})
