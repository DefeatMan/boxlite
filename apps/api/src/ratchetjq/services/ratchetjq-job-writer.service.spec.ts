/*
 * Copyright 2026 BoxLite AI
 * SPDX-License-Identifier: AGPL-3.0
 */

import { RatchetJQJob } from '../entities/ratchetjq-job.entity'
import { RatchetJQJobChannel } from '../enums/ratchetjq-job-channel.enum'
import { RatchetJQJobPeriod } from '../enums/ratchetjq-job-period.enum'
import { RatchetJQJobStatus } from '../enums/ratchetjq-job-status.enum'
import { RatchetJQDuplicateJobError } from '../errors/ratchetjq-duplicate-job.error'
import { RatchetJQJobSubmission, RatchetJQJobWriter } from './ratchetjq-job-writer.service'

const SUBMISSION: RatchetJQJobSubmission = {
  executor: 'runner',
  executorId: 'runner-1',
  resourceId: 'box-1',
  type: 'echo',
  ttlSeconds: 30,
  attlSeconds: 10,
  inParams: { message: 'hello' },
}

/**
 * Builds the writer over stubs.
 *
 * `insertFails` is thrown by the insert instead of a row, which is how the dedup
 * translation is reached; the driver shape it carries is what a Postgres unique
 * violation actually looks like through TypeORM.
 */
function makeWriter(options: { insertFails?: unknown; rows?: Array<Partial<RatchetJQJob>> } = {}) {
  const query = jest.fn(async () => {
    if (options.insertFails) {
      throw options.insertFails
    }
    return options.rows ?? [{ id: 'job-1', type: 'echo', period: RatchetJQJobPeriod.PENDING_RUN }]
  })
  const transfer = { wakeup: jest.fn(async () => undefined) }

  const writer = new RatchetJQJobWriter({ query } as never, transfer as never)

  const statement = (): [string, unknown[]] => query.mock.calls[0] as unknown as [string, unknown[]]

  return { writer, query, transfer, statement }
}

/**
 * Splits the INSERT into its column list and its VALUES list.
 *
 * The two are the halves that have to agree, and neither can be checked against
 * the other without pulling them apart. `lastIndexOf` finds the closer of VALUES
 * because `RETURNING *` carries no parentheses while the scheduling SQL does, so
 * the naive first-closer would land inside that instead.
 */
function parseInsert(sql: string): { columns: string[]; values: string[] } {
  const columnsStart = sql.indexOf('(') + 1
  const columnsBlock = sql.slice(columnsStart, sql.indexOf(')', columnsStart))
  const valuesStart = sql.indexOf('VALUES (') + 'VALUES ('.length
  const valuesBlock = sql.slice(valuesStart, sql.lastIndexOf(')'))

  return {
    columns: columnsBlock.split(',').map((column) => column.trim().replace(/"/g, '')),
    values: valuesBlock.split(',').map((value) => value.trim()),
  }
}

describe('RatchetJQJobWriter queue', () => {
  // The first round is unspent and both deadlines are now(), which together are
  // what make the row claimable on the executor's next poll.
  it('queues the job at pending_run with its first round unspent', async () => {
    const { writer, statement } = makeWriter()

    await writer.queue(SUBMISSION)

    const [sql, parameters] = statement()
    expect(sql).toContain('INSERT INTO "ratchetjq_job"')
    expect(sql).toContain('now(), now(), 1')
    expect(parameters).toContain(RatchetJQJobPeriod.PENDING_RUN)
  })

  it('hands back the row the statement returned', async () => {
    const { writer } = makeWriter({ rows: [{ id: 'job-7' } as Partial<RatchetJQJob>] })

    await expect(writer.queue(SUBMISSION)).resolves.toMatchObject({ id: 'job-7' })
  })

  it('writes what the submitter asked for', async () => {
    const { writer, statement } = makeWriter()

    await writer.queue({ ...SUBMISSION, channel: 7, pr: 3, rollbackType: 'undo-echo' })

    const [, parameters] = statement()
    expect(parameters.slice(0, 10)).toEqual([
      7,
      'runner',
      'runner-1',
      'box-1',
      3,
      'echo',
      { message: 'hello' },
      30,
      10,
      'undo-echo',
    ])
  })

  // Opting out is the default: the unique index is predicated on the channel not
  // being NONE, so a submitter who has not thought about deduplication must not
  // acquire it by accident.
  it('defaults the channel to NONE, the priority to 0 and the rollback to null', async () => {
    const { writer, statement } = makeWriter()

    await writer.queue(SUBMISSION)

    const [, parameters] = statement()
    expect(parameters[0]).toBe(RatchetJQJobChannel.NONE)
    expect(parameters[4]).toBe(0)
    expect(parameters[9]).toBeNull()
  })

  // The column list and the parameter array are only right together: a column
  // moved without its value is a statement a stub happily records and Postgres
  // rejects on type, so both halves are pinned — the names in order here, the
  // values in order above.
  it('declares its columns in the order its parameters are passed', async () => {
    const { writer, statement } = makeWriter()

    await writer.queue(SUBMISSION)

    const { columns, values } = parseInsert(statement()[0])
    expect(columns.slice(0, 10)).toEqual([
      'channel',
      'executor',
      'executorId',
      'resourceId',
      'pr',
      'type',
      'inParams',
      'ttlSeconds',
      'attlSeconds',
      'rollbackType',
    ])
    expect(values.slice(0, 11)).toEqual(['$1', '$2', '$3', '$4', '$5', '$6', '$7', '$8', '$9', '$10', '$11'])
  })

  // The four columns the two forms disagree about come last, which is what lets
  // one statement serve both with the schedule's SQL appended rather than spliced
  // into the middle.
  it('puts the scheduling columns last', async () => {
    const { writer, statement } = makeWriter()

    await writer.queue(SUBMISSION)

    const { columns } = parseInsert(statement()[0])
    expect(columns.slice(10)).toEqual(['period', 'leaseExpiresAt', 'visibleAt', 'attempt'])
  })

  it('hints the executor instance that owns the job, after the write', async () => {
    const { writer, transfer, query } = makeWriter()

    await writer.queue(SUBMISSION)

    expect(transfer.wakeup).toHaveBeenCalledWith('runner', 'runner-1')
    expect(query.mock.invocationCallOrder[0]).toBeLessThan(transfer.wakeup.mock.invocationCallOrder[0])
  })
})

describe('RatchetJQJobWriter start', () => {
  // Written as already begun: the caller is about to hand the job to the executor
  // and that hand-off is the first round, so nothing else may claim it meanwhile.
  it('starts the job at running on its second round, holding one ttl of lease', async () => {
    const { writer, statement } = makeWriter()

    await writer.start(SUBMISSION)

    const [sql, parameters] = statement()
    // $8 is ttlSeconds, so the lease covers exactly the round being spent.
    expect(sql).toContain(`now() + $8 * interval '1 second', now() + interval '1 second', 2`)
    expect(parameters).toContain(RatchetJQJobPeriod.RUNNING)
    expect(parameters[7]).toBe(30)
  })

  it('hints the executor for the pushed form too', async () => {
    const { writer, transfer } = makeWriter()

    await writer.start(SUBMISSION)

    expect(transfer.wakeup).toHaveBeenCalledWith('runner', 'runner-1')
  })
})

describe('RatchetJQJobWriter deduplication', () => {
  const uniqueViolation = Object.assign(new Error('duplicate key value violates unique constraint'), {
    code: '23505',
    constraint: 'ratchetjq_job_dedup_unique',
  })

  it('refuses a submission whose dedup key is already held', async () => {
    const { writer } = makeWriter({ insertFails: uniqueViolation })

    await expect(writer.queue({ ...SUBMISSION, channel: 7 })).rejects.toBeInstanceOf(RatchetJQDuplicateJobError)
  })

  it('names the whole key it collided on', async () => {
    const { writer } = makeWriter({ insertFails: uniqueViolation })

    await expect(writer.queue({ ...SUBMISSION, channel: 7 })).rejects.toMatchObject({
      key: { channel: 7, executor: 'runner', executorId: 'runner-1', resourceId: 'box-1' },
    })
  })

  // Another table's constraint is not this module's business, and reporting it as
  // a duplicate submission would send a caller looking for a job that never was.
  it('leaves a unique violation from another constraint alone', async () => {
    const other = Object.assign(new Error('duplicate key value violates unique constraint'), {
      code: '23505',
      constraint: 'some_other_unique',
    })
    const { writer } = makeWriter({ insertFails: other })

    await expect(writer.queue(SUBMISSION)).rejects.toBe(other)
  })

  // Both halves of the match are required, and this is the half the constraint
  // name cannot cover on its own: a failure naming the dedup index without being
  // a unique violation is some integrity error nobody here has reasoned about,
  // and dressing it up as a duplicate submission would send the caller looking
  // for a job that never existed.
  it('leaves a failure that names the dedup index but is not a unique violation', async () => {
    const misnamed = Object.assign(new Error('some other integrity failure'), {
      code: '23514',
      constraint: 'ratchetjq_job_dedup_unique',
    })
    const { writer } = makeWriter({ insertFails: misnamed })

    await expect(writer.queue({ ...SUBMISSION, channel: 7 })).rejects.toBe(misnamed)
  })

  it('leaves an unrelated database failure alone', async () => {
    const outage = Object.assign(new Error('connection terminated'), { code: '08006' })
    const { writer } = makeWriter({ insertFails: outage })

    await expect(writer.queue(SUBMISSION)).rejects.toBe(outage)
  })

  it('does not hint the executor for a submission that was refused', async () => {
    const { writer, transfer } = makeWriter({ insertFails: uniqueViolation })

    await expect(writer.queue({ ...SUBMISSION, channel: 7 })).rejects.toBeInstanceOf(RatchetJQDuplicateJobError)
    expect(transfer.wakeup).not.toHaveBeenCalled()
  })
})

describe('RatchetJQJobWriter submission checks', () => {
  // A budget of zero writes a lease that has already expired, so the job would be
  // claimed, timed out and retried until its rounds were gone — accepted-looking
  // and quietly doomed, which is why it is refused at the boundary instead.
  it.each([
    ['ttlSeconds', { ttlSeconds: 0 }],
    ['ttlSeconds', { ttlSeconds: -1 }],
    ['attlSeconds', { attlSeconds: 0 }],
    ['ttlSeconds', { ttlSeconds: 1.5 }],
  ])('refuses a submission whose %s is not a positive whole number', async (field, override) => {
    const { writer, query } = makeWriter()

    await expect(writer.queue({ ...SUBMISSION, ...override })).rejects.toThrow(field)
    expect(query).not.toHaveBeenCalled()
  })

  it.each(['executor', 'executorId', 'resourceId', 'type'] as const)(
    'refuses a submission with no %s',
    async (field) => {
      const { writer, query } = makeWriter()

      await expect(writer.queue({ ...SUBMISSION, [field]: '' })).rejects.toThrow(field)
      expect(query).not.toHaveBeenCalled()
    },
  )

  it('refuses a negative priority', async () => {
    const { writer } = makeWriter()

    await expect(writer.queue({ ...SUBMISSION, pr: -1 })).rejects.toThrow('pr')
  })

  it('accepts a priority of zero', async () => {
    const { writer, statement } = makeWriter()

    await writer.queue({ ...SUBMISSION, pr: 0 })

    expect(statement()[1][4]).toBe(0)
  })

  // The insert returning nothing would mean the row is not there, so handing back
  // an undefined job for the caller to report an outcome against is worse than
  // saying so.
  it('fails when the insert returned no row', async () => {
    const { writer } = makeWriter({ rows: [] })

    await expect(writer.queue(SUBMISSION)).rejects.toThrow('returned no row')
  })
})

/**
 * A job that has just been rejected, as the finalizer hands it over: mid-accept,
 * on the round the report opened, carrying the status its executor reported.
 */
const REJECTED_JOB = {
  id: 'job-1',
  period: RatchetJQJobPeriod.ACCEPTING,
  status: RatchetJQJobStatus.OK,
  leaseExpiresAt: new Date(),
  visibleAt: new Date(),
  attempt: 2,
  createdAt: new Date(),
  channel: 7,
  executor: 'runner',
  executorId: 'runner-1',
  resourceId: 'box-1',
  pr: 3,
  type: 'export-box',
  inParams: { boxId: 'box-1' },
  outParams: { arcPath: 'archives/box-1.tar' },
  ttlSeconds: 30,
  attlSeconds: 10,
  rollbackType: 'rollback-export-box',
} as RatchetJQJob

describe('RatchetJQJobWriter rollback submission', () => {
  // Queued, never pushed: whoever asks for a rollback is finishing the original
  // job rather than waiting on the undo.
  it('queues the compensation rather than starting it', async () => {
    const { writer, statement, transfer } = makeWriter()

    await writer.queueRollbackFor(REJECTED_JOB, RatchetJQJobStatus.REJECTED)

    const [sql, parameters] = statement()
    expect(sql).toContain('now(), now(), 1')
    expect(parameters).toContain(RatchetJQJobPeriod.PENDING_RUN)
    expect(transfer.wakeup).toHaveBeenCalledWith('runner', 'runner-1')
  })

  // The executor pair, the resource and both budgets carry over because the undo
  // touches the same resource on the same executor instance. The channel and the
  // rollback type deliberately do not: NONE is what lets the rollback queue while
  // the original still holds its channel (spec §8.5), and a null rollbackType is
  // what stops a failing rollback queueing another one (spec §12-6).
  it('inherits the original\u2019s addressing and budgets, but neither its channel nor its rollback', async () => {
    const { writer, statement } = makeWriter()

    await writer.queueRollbackFor(REJECTED_JOB, RatchetJQJobStatus.REJECTED)

    const [, parameters] = statement()
    expect(parameters.slice(0, 6)).toEqual([
      RatchetJQJobChannel.NONE,
      'runner',
      'runner-1',
      'box-1',
      3,
      'rollback-export-box',
    ])
    expect(parameters.slice(7, 10)).toEqual([30, 10, null])
  })

  // The executor that runs the compensation cannot read the job table, so
  // everything it needs travels in `inParams`: which job it is undoing, what was
  // asked for, what came back, and what the executor called it.
  it('tells the compensation which job it undoes and what happened to it', async () => {
    const { writer, statement } = makeWriter()

    await writer.queueRollbackFor(REJECTED_JOB, RatchetJQJobStatus.REJECTED)

    expect(statement()[1][6]).toEqual({
      id: 'job-1',
      type: 'export-box',
      in: { boxId: 'box-1' },
      out: { arcPath: 'archives/box-1.tar' },
      status: RatchetJQJobStatus.REJECTED,
    })
  })

  // The undone job's own type, not the rollback's. The two are different by
  // construction — the rollback runs as `rollbackType` — and confusing them would
  // tell the compensation it is undoing itself.
  it('names the undone job by its own type rather than the rollback type', async () => {
    const { writer, statement } = makeWriter()

    await writer.queueRollbackFor(REJECTED_JOB, RatchetJQJobStatus.REJECTED)

    const [, parameters] = statement()
    const inParams = parameters[6] as Record<string, unknown>
    // `$6` is the new row's own type, which is the rollback's; the undone job's is
    // what travels in the params.
    expect(parameters[5]).toBe('rollback-export-box')
    expect(inParams.type).toBe('export-box')
  })

  // The status the caller is about to write, not the one the row still carries. A
  // rollback exists because the job was refused or ran out of rounds, and that is
  // what the compensation needs to know — the executor's own `ok` says nothing
  // about why it is being undone.
  it('carries the outcome the job is being closed with, not the one on the row', async () => {
    const { writer, statement } = makeWriter()

    await writer.queueRollbackFor(REJECTED_JOB, RatchetJQJobStatus.TIMEOUT)

    const inParams = statement()[1][6] as Record<string, unknown>
    expect(REJECTED_JOB.status).toBe(RatchetJQJobStatus.OK)
    expect(inParams.status).toBe(RatchetJQJobStatus.TIMEOUT)
  })

  // A job swept from `running` never reported, so there is no output to pass on.
  // It arrives as null rather than absent, which is what tells the compensation
  // "nothing came back" instead of leaving it to guess from a missing key.
  it('passes on a null output for a job that never reported', async () => {
    const { writer, statement } = makeWriter()

    await writer.queueRollbackFor(
      { ...REJECTED_JOB, period: RatchetJQJobPeriod.RUNNING, status: null, outParams: null } as RatchetJQJob,
      RatchetJQJobStatus.TIMEOUT,
    )

    expect(statement()[1][6]).toEqual({
      id: 'job-1',
      type: 'export-box',
      in: { boxId: 'box-1' },
      out: null,
      status: RatchetJQJobStatus.TIMEOUT,
    })
  })

  // By the time a caller asks for a compensation, a job type with none is a bug
  // in its own branch — and queueing nothing silently is how a side effect is
  // never undone.
  it('refuses a job with nothing registered to undo it', async () => {
    const { writer, query } = makeWriter()

    await expect(
      writer.queueRollbackFor({ ...REJECTED_JOB, rollbackType: null } as RatchetJQJob, RatchetJQJobStatus.REJECTED),
    ).rejects.toThrow('no rollbackType')
    expect(query).not.toHaveBeenCalled()
  })
})
