/*
 * Copyright 2026 BoxLite AI
 * SPDX-License-Identifier: AGPL-3.0
 */

import { RatchetJQSyncRunOutcome } from '../common/job-executor'
import { RatchetJQJob } from '../entities/ratchetjq-job.entity'
import { RatchetJQJobStatus } from '../enums/ratchetjq-job-status.enum'
import { RatchetJQSyncTimeoutError } from '../errors/ratchetjq-sync-timeout.error'
import { RatchetJQJobSubmission } from './ratchetjq-job-writer.service'
import { RatchetJQProposerService } from './ratchetjq-proposer.service'

const SUBMISSION: RatchetJQJobSubmission = {
  executor: 'runner',
  executorId: 'runner-1',
  resourceId: 'box-1',
  type: 'echo',
  ttlSeconds: 30,
  attlSeconds: 10,
  inParams: { message: 'hello' },
}

const JOB = { id: 'job-1', type: 'echo', executor: 'runner', executorId: 'runner-1' } as RatchetJQJob

/**
 * Builds the proposer over stubs for the three things it orchestrates: the writer
 * that creates rows, the registry that resolves a push, and the report service
 * that owns the accept segment.
 *
 * The writes themselves are the writer's spec and the accept round is the report
 * service's, so what is asserted here is only the order and the hand-offs — which
 * is all this service does.
 */
/**
 * Rejects once `signal` fires, which is how a stub stands in for a hop that
 * honours the deadline it was handed — the whole point of passing one.
 *
 * It rejects rather than resolving because that is what an aborted call does:
 * axios reports a cancellation as an error, and an abandoned accept round rejects
 * (`accept-round.ts:reporterHungUp`). The message is deliberately not a timeout —
 * the service must name the deadline from the signal, not from wording it happens
 * to recognise.
 */
function untilAborted(signal?: AbortSignal): Promise<never> {
  return new Promise((_resolve, reject) => {
    if (!signal) {
      reject(new Error('the stub was handed no deadline to wait on'))
      return
    }
    signal.addEventListener('abort', () => reject(new Error('canceled')), { once: true })
  })
}

function makeProposer(
  options: {
    outcome?: RatchetJQSyncRunOutcome
    writeFails?: Error
    pushFails?: Error
    reportFails?: Error
    reported?: RatchetJQJob | null
    unknownKind?: boolean
    /** Hang the push until its deadline fires, as an unresponsive executor would. */
    pushHangs?: boolean
    /** Hang the accept until its deadline fires, as an acceptor that never settles would. */
    acceptHangs?: boolean
  } = {},
) {
  const writer = {
    queue: jest.fn(async () => JOB),
    start: jest.fn(async () => {
      if (options.writeFails) {
        throw options.writeFails
      }
      return JOB
    }),
  }
  const runnerExecutor = {
    executor: 'runner',
    syncRun: jest.fn(async (_executorId: string, _job: RatchetJQJob, signal?: AbortSignal) => {
      if (options.pushFails) {
        throw options.pushFails
      }
      if (options.pushHangs) {
        return untilAborted(signal)
      }
      return options.outcome ?? { status: RatchetJQJobStatus.OK, outParams: { echoed: 1 } }
    }),
  }
  const executors = {
    executorFor: jest.fn((kind: string) =>
      options.unknownKind ? undefined : kind === 'runner' ? runnerExecutor : undefined,
    ),
  }
  const report = {
    syncReport: jest.fn(
      async (
        _executor: string,
        _executorId: string,
        _jobId: string,
        _outcome: { status: RatchetJQJobStatus },
        signal?: AbortSignal,
      ) => {
        if (options.reportFails) {
          throw options.reportFails
        }
        if (options.acceptHangs) {
          return untilAborted(signal)
        }
        return options.reported === undefined ? JOB : options.reported
      },
    ),
  }

  const service = new RatchetJQProposerService(writer as never, executors as never, report as never)

  return { service, writer, runnerExecutor, executors, report }
}

describe('RatchetJQProposerService async submission', () => {
  it('queues the submission and hands back the row', async () => {
    const { service, writer } = makeProposer()

    await expect(service.execAsync(SUBMISSION)).resolves.toBe(JOB)
    expect(writer.queue).toHaveBeenCalledWith(SUBMISSION)
  })

  // The queued form needs no push implementation at all, so an unpushable kind
  // must not stop it: that is why the registry answers undefined rather than
  // throwing.
  it('queues for a kind nothing can push to', async () => {
    const { service, writer } = makeProposer({ unknownKind: true })

    await expect(service.execAsync(SUBMISSION)).resolves.toBe(JOB)
    expect(writer.queue).toHaveBeenCalledTimes(1)
  })
})

describe('RatchetJQProposerService sync submission', () => {
  // The order is the method: the row exists before anything can run it, and the
  // outcome is accepted before the caller hears about it.
  it('writes the row, pushes it, then reports the outcome', async () => {
    const { service, writer, runnerExecutor, report } = makeProposer()

    await service.execSync(SUBMISSION)

    expect(writer.start).toHaveBeenCalledWith(SUBMISSION)
    expect(runnerExecutor.syncRun).toHaveBeenCalledWith('runner-1', JOB, undefined)
    expect(writer.start.mock.invocationCallOrder[0]).toBeLessThan(runnerExecutor.syncRun.mock.invocationCallOrder[0])
    expect(runnerExecutor.syncRun.mock.invocationCallOrder[0]).toBeLessThan(
      report.syncReport.mock.invocationCallOrder[0],
    )
  })

  // The synchronous form of the report, because a caller is waiting on the whole
  // chain: it accepts inline, so an accept that fails reaches that caller instead
  // of being logged behind an answer that already said the job was done.
  it('reports the outcome under the identity that pushed it', async () => {
    const { service, report } = makeProposer({ outcome: { status: RatchetJQJobStatus.OK, outParams: { echoed: 2 } } })

    await service.execSync(SUBMISSION)

    expect(report.syncReport).toHaveBeenCalledWith(
      'runner',
      'runner-1',
      'job-1',
      {
        status: RatchetJQJobStatus.OK,
        outParams: { echoed: 2 },
      },
      undefined,
    )
  })

  it('answers with the row and what the executor reported', async () => {
    const { service } = makeProposer({ outcome: { status: RatchetJQJobStatus.OK, outParams: { echoed: 2 } } })

    await expect(service.execSync(SUBMISSION)).resolves.toEqual({
      job: JOB,
      outcome: { status: RatchetJQJobStatus.OK, outParams: { echoed: 2 } },
    })
  })

  // The push is chosen by the kind the submission names, not by a class this
  // service holds, which is what lets a second kind of executor be a class and a
  // module entry and nothing else.
  it('resolves the push from the executor kind the submission names', async () => {
    const { service, executors } = makeProposer()

    await service.execSync(SUBMISSION)

    expect(executors.executorFor).toHaveBeenCalledWith('runner')
  })

  // Refused before the row is written, and this is the assertion that says so: a
  // kind nothing can push to will not become pushable on a later round, and the
  // caller asked for an outcome rather than for the job to be queued.
  it('writes no row for a kind nothing can push to', async () => {
    const { service, writer } = makeProposer({ unknownKind: true })

    await expect(service.execSync(SUBMISSION)).rejects.toThrow('No RatchetJQ executor can push to the kind')
    expect(writer.start).not.toHaveBeenCalled()
  })

  // The job is not lost by a failed push — its lease lapses and the pulled path
  // takes it — but only the caller knows whether it can wait for that, so the
  // failure travels instead of being swallowed.
  it('propagates a failed push, and reports nothing for it', async () => {
    const refused = new Error('connection refused')
    const { service, report } = makeProposer({ pushFails: refused })

    await expect(service.execSync(SUBMISSION)).rejects.toBe(refused)
    // Nothing ran, so there is no outcome to record: the row stays `running` and
    // the pulled path retries it once the lease lapses.
    expect(report.syncReport).not.toHaveBeenCalled()
  })

  it('does not push a submission the writer refused', async () => {
    const duplicate = new Error('a RatchetJQ job already holds this dedup key')
    const { service, runnerExecutor } = makeProposer({ writeFails: duplicate })

    await expect(service.execSync(SUBMISSION)).rejects.toBe(duplicate)
    expect(runnerExecutor.syncRun).not.toHaveBeenCalled()
  })

  // Spec §4: a SyncAccept that throws writes no terminal state, and the error goes
  // back up the chain. The caller is the top of that chain here.
  it('propagates an accept that failed', async () => {
    const undecided = new Error('the acceptor could not reach the object store')
    const { service } = makeProposer({ reportFails: undecided })

    await expect(service.execSync(SUBMISSION)).rejects.toBe(undecided)
  })

  // The Scanner force-advanced or retried the row while the push was in flight, so
  // there is nothing left to accept here. The caller asked for the outcome, which
  // it has, and that row's next round will offer one again.
  it('still answers when the row was no longer running to report against', async () => {
    const { service } = makeProposer({ reported: null })

    await expect(service.execSync(SUBMISSION)).resolves.toMatchObject({ job: JOB })
  })

  // The executor is a separate service, so its word about the outcome is checked
  // where it enters the job table: `status` is a Postgres enum, and an unknown
  // value would otherwise fail the report's UPDATE naming neither the job nor the
  // executor that sent it.
  it('refuses a status the scheduler does not know', async () => {
    const { service, report } = makeProposer({ outcome: { status: 'half-done', outParams: null } })

    await expect(service.execSync(SUBMISSION)).rejects.toThrow('unknown status "half-done"')
    expect(report.syncReport).not.toHaveBeenCalled()
  })
})

describe('RatchetJQProposerService sync deadline', () => {
  // Zero is the default and it means "no deadline", the reading axios gives
  // `timeout: 0` and Redis gives `BRPOP key 0`. Nothing downstream then receives a
  // signal at all, which is what keeps an unbounded wait genuinely unbounded
  // rather than bounded by something invisible.
  it('hands no deadline down when none was asked for', async () => {
    const { service, runnerExecutor, report } = makeProposer()

    await service.execSync(SUBMISSION, 0)

    expect(runnerExecutor.syncRun.mock.calls[0][2]).toBeUndefined()
    expect(report.syncReport.mock.calls[0][4]).toBeUndefined()
  })

  // One deadline over the whole chain, not one per hop: the same signal object has
  // to reach both, or a push that used most of the budget would hand the accept a
  // fresh one.
  it('carries one deadline through both the push and the accept', async () => {
    const { service, runnerExecutor, report } = makeProposer()

    await service.execSync(SUBMISSION, 30)

    const pushed = runnerExecutor.syncRun.mock.calls[0][2]
    expect(pushed).toBeInstanceOf(AbortSignal)
    expect(pushed?.aborted).toBe(false)
    expect(report.syncReport.mock.calls[0][4]).toBe(pushed)
  })

  // A second of real waiting, because the signal has to actually fire: the
  // parameter is whole seconds, so one is the shortest deadline there is.
  it('stops waiting on an executor that never answers', async () => {
    const { service, report } = makeProposer({ pushHangs: true })

    await expect(service.execSync(SUBMISSION, 1)).rejects.toBeInstanceOf(RatchetJQSyncTimeoutError)
    // Nothing was reported, and that is the point of naming the stage: the
    // executor never answered, so whether the side effect landed is unknown.
    expect(report.syncReport).not.toHaveBeenCalled()
  })

  it('names the run segment when the executor was the one still working', async () => {
    const { service } = makeProposer({ pushHangs: true })

    await expect(service.execSync(SUBMISSION, 1)).rejects.toMatchObject({
      jobId: 'job-1',
      stage: 'run',
      timeoutSeconds: 1,
    })
  })

  // The case the deadline exists for: the inline round's heartbeat renews the
  // accept lease for as long as the acceptor runs, so without this the caller and
  // the row would both be held forever.
  it('stops waiting on an acceptor that never settles', async () => {
    const { service } = makeProposer({ acceptHangs: true })

    await expect(service.execSync(SUBMISSION, 1)).rejects.toMatchObject({
      jobId: 'job-1',
      stage: 'accept',
      timeoutSeconds: 1,
    })
  })

  // A failure that arrives while the deadline is still live is that failure, not a
  // timeout. Reading the signal rather than the error is what keeps the two apart —
  // axios reports a cancellation as `CanceledError: canceled`, which no wording
  // check could tell from a genuine one.
  it('does not report an ordinary failure as a timeout', async () => {
    const refused = new Error('connection refused')
    const { service } = makeProposer({ pushFails: refused })

    await expect(service.execSync(SUBMISSION, 30)).rejects.toBe(refused)
  })

  it('does not report an accept that failed on its own as a timeout', async () => {
    const undecided = new Error('the acceptor could not reach the object store')
    const { service } = makeProposer({ reportFails: undecided })

    await expect(service.execSync(SUBMISSION, 30)).rejects.toBe(undecided)
  })

  // Refused before the row is written, because every wrong value fails quietly in
  // its own direction: a fraction is a millisecond count nobody meant, and a
  // negative one aborts the submission before it starts.
  it.each([-1, 1.5, Number.NaN])('refuses a timeout of %p without writing a row', async (timeoutSeconds) => {
    const { service, writer } = makeProposer()

    await expect(service.execSync(SUBMISSION, timeoutSeconds)).rejects.toThrow('whole, non-negative timeoutSeconds')
    expect(writer.start).not.toHaveBeenCalled()
  })
})
