/*
 * Copyright 2026 BoxLite AI
 * SPDX-License-Identifier: AGPL-3.0
 */

import { RatchetJQJob } from '../entities/ratchetjq-job.entity'
import { RatchetJQJobPeriod } from '../enums/ratchetjq-job-period.enum'
import { RatchetJQJobStatus } from '../enums/ratchetjq-job-status.enum'
import { RatchetJQAcceptFinalizer } from './accept-finalizer'
import { RatchetJQAcceptVerdict } from './job-acceptor'

const JOB = { id: 'job-1', type: 'demo' } as RatchetJQJob

/** The same job, but with something registered to undo it. */
const ROLLBACKABLE_JOB = { ...JOB, rollbackType: 'undo-demo' } as RatchetJQJob

function makeFinalizer(options: { createFails?: Error } = {}) {
  const query = jest.fn(async () => [])
  const writer = {
    queueRollbackFor: jest.fn(async () => {
      if (options.createFails) {
        throw options.createFails
      }
      return { id: 'rollback-1' } as RatchetJQJob
    }),
  }
  const finalizer = new RatchetJQAcceptFinalizer({ query } as never, writer as never)

  return { finalizer, query, writer }
}

describe('RatchetJQAcceptFinalizer', () => {
  it('completes an accepted job, guarded by the stage it is leaving', async () => {
    const { finalizer, query } = makeFinalizer()

    await finalizer.finalize(JOB, RatchetJQAcceptVerdict.ACCEPTED)

    expect(query).toHaveBeenCalledTimes(1)
    const [sql, parameters] = query.mock.calls[0] as unknown as [string, unknown[]]
    expect(sql).toContain('"period" = $2')
    expect(sql).toContain('"id" = $1 AND "period" = $3')
    expect(parameters).toEqual(['job-1', RatchetJQJobPeriod.COMPLETED, RatchetJQJobPeriod.ACCEPTING])
  })

  // Closing the original and recording its compensation in one statement is what
  // stops the two diverging: a job can never read as completed while pointing at
  // no rollback, or point at one without having completed.
  it('queues the compensation and completes a rejected job pointing at it', async () => {
    const { finalizer, query, writer } = makeFinalizer()

    await finalizer.finalize(ROLLBACKABLE_JOB, RatchetJQAcceptVerdict.ROLLBACK)

    // The status travels with the job, because the compensation is told why it
    // exists and this write is the only place that knows: the row still carries
    // whatever the executor reported until the UPDATE below lands.
    expect(writer.queueRollbackFor).toHaveBeenCalledWith(ROLLBACKABLE_JOB, RatchetJQJobStatus.REJECTED)
    const [sql, parameters] = query.mock.calls[0] as unknown as [string, unknown[]]
    expect(sql).toContain('"period" = $2, "status" = $3, "rollbackJobId" = $4')
    expect(sql).toContain('"id" = $1 AND "period" = $5')
    expect(parameters).toEqual([
      'job-1',
      RatchetJQJobPeriod.COMPLETED,
      RatchetJQJobStatus.REJECTED,
      'rollback-1',
      RatchetJQJobPeriod.ACCEPTING,
    ])
  })

  // The verdict still stands with nothing registered to undo — and this is what
  // terminates the chain, since a rollback job is created without a rollbackType
  // of its own.
  it('completes a rejected job that has no rollbackType, without queueing anything', async () => {
    const { finalizer, query, writer } = makeFinalizer()

    await finalizer.finalize(JOB, RatchetJQAcceptVerdict.ROLLBACK)

    expect(writer.queueRollbackFor).not.toHaveBeenCalled()
    const [, parameters] = query.mock.calls[0] as unknown as [string, unknown[]]
    expect(parameters).toEqual([
      'job-1',
      RatchetJQJobPeriod.COMPLETED,
      RatchetJQJobStatus.REJECTED,
      null,
      RatchetJQJobPeriod.ACCEPTING,
    ])
  })

  // Create first, record second. A compensation that could not be queued must
  // leave the row `accepting` rather than complete it: a job that read as
  // finished with its side effect never undone is the one outcome with no way back.
  it('leaves the row accepting when the compensation could not be queued', async () => {
    const { finalizer, query } = makeFinalizer({ createFails: new Error('duplicate job') })

    await expect(finalizer.finalize(ROLLBACKABLE_JOB, RatchetJQAcceptVerdict.ROLLBACK)).rejects.toThrow('duplicate job')
    expect(query).not.toHaveBeenCalled()
  })

  // The caller has to learn that the row did not reach a terminal stage, since
  // what it does about it — leave the row to its lease — depends on knowing.
  it('propagates a failed write to its caller', async () => {
    const { finalizer, query } = makeFinalizer()
    query.mockRejectedValueOnce(new Error('deadlock detected') as never)

    await expect(finalizer.finalize(JOB, RatchetJQAcceptVerdict.ACCEPTED)).rejects.toThrow('deadlock detected')
  })
})

describe('RatchetJQAcceptFinalizer retirement', () => {
  /** A row the sweep found, which carries the stage it was found in. */
  const exhausted = (period: RatchetJQJobPeriod, rollbackType?: string) =>
    ({ ...JOB, period, rollbackType }) as RatchetJQJob

  // The same order as a rejection — compensation first, then close pointing at it
  // — and the only status that says the scheduler gave up rather than a handler.
  it('queues the compensation and closes the job as timeout', async () => {
    const { finalizer, query, writer } = makeFinalizer()
    const job = exhausted(RatchetJQJobPeriod.RUNNING, 'undo-demo')

    await finalizer.retire(job, { query } as never)

    expect(writer.queueRollbackFor).toHaveBeenCalledWith(job, RatchetJQJobStatus.TIMEOUT)
    const [sql, parameters] = query.mock.calls[0] as unknown as [string, unknown[]]
    expect(sql).toContain('"period" = $2, "status" = $3, "rollbackJobId" = $4')
    expect(parameters).toEqual([
      'job-1',
      RatchetJQJobPeriod.COMPLETED,
      RatchetJQJobStatus.TIMEOUT,
      'rollback-1',
      RatchetJQJobPeriod.RUNNING,
    ])
  })

  // The stage the row was found in is the guard, so a sweep of one stage can never
  // close a row that has since moved to the other.
  it('guards the write with the stage the row was swept from', async () => {
    const { finalizer, query } = makeFinalizer()

    await finalizer.retire(exhausted(RatchetJQJobPeriod.ACCEPTING, 'undo-demo'), { query } as never)

    const [, parameters] = query.mock.calls[0] as unknown as [string, unknown[]]
    expect(parameters[4]).toBe(RatchetJQJobPeriod.ACCEPTING)
  })

  // Nothing registered to undo is not a reason to keep the row: leaving it for a
  // rollback that can never be created would only hold a spent job open forever.
  it('closes a job with no rollbackType, without queueing anything', async () => {
    const { finalizer, query, writer } = makeFinalizer()

    await finalizer.retire(exhausted(RatchetJQJobPeriod.RUNNING), { query } as never)

    expect(writer.queueRollbackFor).not.toHaveBeenCalled()
    const [, parameters] = query.mock.calls[0] as unknown as [string, unknown[]]
    expect(parameters).toEqual([
      'job-1',
      RatchetJQJobPeriod.COMPLETED,
      RatchetJQJobStatus.TIMEOUT,
      null,
      RatchetJQJobPeriod.RUNNING,
    ])
  })

  // The write goes to the runner it was handed, not to this service's own
  // repository: the sweep holds the row locked in its own transaction, and a write
  // on another connection would wait on that lock while the sweep waits on it.
  it('writes through the runner it was handed rather than its own repository', async () => {
    const { finalizer, query } = makeFinalizer()
    const transaction = { query: jest.fn(async () => []) }

    await finalizer.retire(exhausted(RatchetJQJobPeriod.RUNNING, 'undo-demo'), transaction as never)

    expect(transaction.query).toHaveBeenCalledTimes(1)
    expect(query).not.toHaveBeenCalled()
  })

  // Create first, close second, exactly as a rejection does: a row left open is
  // swept again, a row closed with its side effect never undone is not recoverable.
  it('leaves the row where it was when the compensation could not be queued', async () => {
    const { finalizer, query } = makeFinalizer({ createFails: new Error('duplicate job') })

    await expect(
      finalizer.retire(exhausted(RatchetJQJobPeriod.RUNNING, 'undo-demo'), { query } as never),
    ).rejects.toThrow('duplicate job')
    expect(query).not.toHaveBeenCalled()
  })
})
