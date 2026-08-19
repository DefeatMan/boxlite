/*
 * Copyright 2026 BoxLite AI
 * SPDX-License-Identifier: AGPL-3.0
 */

import { RatchetJQJob } from '../entities/ratchetjq-job.entity'
import { RatchetJQJobPeriod } from '../enums/ratchetjq-job-period.enum'
import { RatchetJQJobStatus } from '../enums/ratchetjq-job-status.enum'
import { RatchetJQReportService } from './ratchetjq-report.service'

const EXECUTOR = 'runner'
const EXECUTOR_ID = 'runner-1'
const JOB_ID = 'job-1'
const OUTCOME = { status: RatchetJQJobStatus.OK, outParams: { echoed: 1 } }

const ACCEPTING_JOB = {
  id: JOB_ID,
  type: 'echo',
  period: RatchetJQJobPeriod.ACCEPTING,
  attlSeconds: 10,
} as RatchetJQJob

/**
 * Builds the report service over stubs.
 *
 * `reported` is what TRANSFER's write hands back — null being "no running row for
 * this executor to report against". `inlineFails` is thrown by the inline round,
 * which is the acceptor failing as far as this service is concerned.
 */
function makeReportService(
  options: {
    reported?: RatchetJQJob | null
    wakeupFails?: Error
    inlineFails?: Error
    holdUnattended?: boolean
  } = {},
) {
  const transfer = { report: jest.fn(async () => (options.reported === undefined ? ACCEPTING_JOB : options.reported)) }
  const scanner = {
    scannerWakeup: jest.fn(async () => {
      if (options.wakeupFails) {
        throw options.wakeupFails
      }
      return true
    }),
  }

  let releaseUnattended: () => void = () => undefined
  const unattendedRunning = new Promise<void>((resolve) => {
    releaseUnattended = resolve
  })
  const acceptRound = {
    runInline: jest.fn(async () => {
      if (options.inlineFails) {
        throw options.inlineFails
      }
    }),
    runUnattended: jest.fn(async () => {
      if (options.holdUnattended) {
        await unattendedRunning
      }
    }),
  }

  const service = new RatchetJQReportService(transfer as never, scanner as never, acceptRound as never)

  return { service, transfer, scanner, acceptRound, releaseUnattended }
}

describe('RatchetJQReportService syncReport', () => {
  // The order is the whole of the method, and each step depends on the last: the
  // row has to be `accepting` before an accept can predicate on it, and the
  // wake-up is only useful once that row exists.
  it('records the outcome, wakes a Scanner, then accepts inline', async () => {
    const { service, transfer, scanner, acceptRound } = makeReportService()

    const job = await service.syncReport(EXECUTOR, EXECUTOR_ID, JOB_ID, OUTCOME)

    expect(transfer.report).toHaveBeenCalledWith(EXECUTOR, EXECUTOR_ID, JOB_ID, OUTCOME)
    expect(scanner.scannerWakeup).toHaveBeenCalledTimes(1)
    expect(acceptRound.runInline).toHaveBeenCalledWith(ACCEPTING_JOB, undefined)
    expect(transfer.report.mock.invocationCallOrder[0]).toBeLessThan(scanner.scannerWakeup.mock.invocationCallOrder[0])
    expect(scanner.scannerWakeup.mock.invocationCallOrder[0]).toBeLessThan(
      acceptRound.runInline.mock.invocationCallOrder[0],
    )
    expect(job).toBe(ACCEPTING_JOB)
  })

  // The signal is what ends a round whose reporter hung up, and it is the only
  // thing that bounds an inline accept — the heartbeat holds the lease otherwise.
  it('passes the reporter’s signal through to the round', async () => {
    const { service, acceptRound } = makeReportService()
    const reporter = new AbortController()

    await service.syncReport(EXECUTOR, EXECUTOR_ID, JOB_ID, OUTCOME, reporter.signal)

    expect(acceptRound.runInline).toHaveBeenCalledWith(ACCEPTING_JOB, reporter.signal)
  })

  // A duplicate report, or one for a job this executor does not hold, matches no
  // row. Nothing further may run: waking a Scanner and accepting would both be
  // acting on an outcome that was not recorded.
  it('does nothing further when no running row matched', async () => {
    const { service, scanner, acceptRound } = makeReportService({ reported: null })

    await expect(service.syncReport(EXECUTOR, EXECUTOR_ID, JOB_ID, OUTCOME)).resolves.toBeNull()
    expect(scanner.scannerWakeup).not.toHaveBeenCalled()
    expect(acceptRound.runInline).not.toHaveBeenCalled()
  })

  // The row is already committed by then, so failing the report over a missing
  // backstop would lose the outcome it had just recorded.
  it('accepts even when no Scanner could be woken', async () => {
    const { service, acceptRound } = makeReportService({ wakeupFails: new Error('redis unreachable') })

    await expect(service.syncReport(EXECUTOR, EXECUTOR_ID, JOB_ID, OUTCOME)).resolves.toBe(ACCEPTING_JOB)
    expect(acceptRound.runInline).toHaveBeenCalledTimes(1)
  })

  // The executor is waiting on the verdict, so it learns that the accept failed
  // rather than being told one happened. The row is left `accepting`.
  it('fails the report when the inline accept fails', async () => {
    const { service } = makeReportService({ inlineFails: new Error('the acceptor could not decide') })

    await expect(service.syncReport(EXECUTOR, EXECUTOR_ID, JOB_ID, OUTCOME)).rejects.toThrow('could not decide')
  })
})

describe('RatchetJQReportService asyncReport', () => {
  it('records the outcome, wakes a Scanner, then starts the accept', async () => {
    const { service, transfer, scanner, acceptRound } = makeReportService()

    const job = await service.asyncReport(EXECUTOR, EXECUTOR_ID, JOB_ID, OUTCOME)

    expect(transfer.report).toHaveBeenCalledWith(EXECUTOR, EXECUTOR_ID, JOB_ID, OUTCOME)
    expect(scanner.scannerWakeup).toHaveBeenCalledTimes(1)
    expect(acceptRound.runUnattended).toHaveBeenCalledWith(ACCEPTING_JOB)
    expect(job).toBe(ACCEPTING_JOB)
  })

  // The point of this form: a runner reporting from its own poll is not waiting
  // on the accept, so its request must not be held open for one.
  it('answers before the accept has settled', async () => {
    const { service, acceptRound, releaseUnattended } = makeReportService({ holdUnattended: true })

    await expect(service.asyncReport(EXECUTOR, EXECUTOR_ID, JOB_ID, OUTCOME)).resolves.toBe(ACCEPTING_JOB)

    const [started] = acceptRound.runUnattended.mock.results
    let settled = false
    void (started.value as Promise<void>).then(() => {
      settled = true
    })
    expect(settled).toBe(false)

    releaseUnattended()
    await started.value
  })

  it('does nothing further when no running row matched', async () => {
    const { service, scanner, acceptRound } = makeReportService({ reported: null })

    await expect(service.asyncReport(EXECUTOR, EXECUTOR_ID, JOB_ID, OUTCOME)).resolves.toBeNull()
    expect(scanner.scannerWakeup).not.toHaveBeenCalled()
    expect(acceptRound.runUnattended).not.toHaveBeenCalled()
  })
})
