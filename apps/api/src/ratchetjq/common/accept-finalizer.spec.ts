/*
 * Copyright 2026 BoxLite AI
 * SPDX-License-Identifier: AGPL-3.0
 */

import { RatchetJQJob } from '../entities/ratchetjq-job.entity'
import { RatchetJQJobPeriod } from '../enums/ratchetjq-job-period.enum'
import { RatchetJQAcceptFinalizer } from './accept-finalizer'
import { RatchetJQAcceptVerdict } from './job-acceptor'

const JOB = { id: 'job-1', type: 'demo' } as RatchetJQJob

function makeFinalizer() {
  const query = jest.fn(async () => [])
  const finalizer = new RatchetJQAcceptFinalizer({ query } as never)

  return { finalizer, query }
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

  // Acting on a rollback means creating a rollback job, which the PROPOSER cannot
  // do yet. Completing the row anyway would read as a finished job whose side
  // effect was never undone, so the row is left for a later round.
  it('writes nothing for a rollback verdict', async () => {
    const { finalizer, query } = makeFinalizer()

    await finalizer.finalize(JOB, RatchetJQAcceptVerdict.ROLLBACK)

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
