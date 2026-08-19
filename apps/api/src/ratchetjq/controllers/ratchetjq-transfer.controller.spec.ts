/*
 * Copyright 2026 BoxLite AI
 * SPDX-License-Identifier: AGPL-3.0
 */

import { ForbiddenException } from '@nestjs/common'
import { BaseAuthContext } from '../../common/interfaces/auth-context.interface'
import { RatchetJQJob } from '../entities/ratchetjq-job.entity'
import { RatchetJQJobStatus } from '../enums/ratchetjq-job-status.enum'
import { RatchetJQTransferController } from './ratchetjq-transfer.controller'

/** A runner-shaped auth context, which is what `resolveExecutorIdentity` reads. */
const RUNNER_AUTH = { runnerId: 'runner-1', role: 'runner' } as unknown as BaseAuthContext

const REPORTED = { status: RatchetJQJobStatus.OK, outParams: { echoed: 1 } }

function makeController(options: { reported?: RatchetJQJob | null } = {}) {
  const reportedJob = () => (options.reported === undefined ? ({ id: 'job-1' } as RatchetJQJob) : options.reported)
  const transferService = { claimJobs: jest.fn(async () => []) }
  const reportService = {
    asyncReport: jest.fn(async () => reportedJob()),
    syncReport: jest.fn(async () => reportedJob()),
  }
  const controller = new RatchetJQTransferController(transferService as never, reportService as never)

  return { controller, transferService, reportService }
}

describe('RatchetJQTransferController report', () => {
  // The executor pair is derived, never taken from the request: a runner may only
  // report against its own jobs, so there is nothing here for a caller to name.
  it('reports under the identity of the authenticated executor', async () => {
    const { controller, reportService } = makeController()

    await expect(controller.reportJob(RUNNER_AUTH, 'job-1', REPORTED)).resolves.toEqual({ accepted: true })
    expect(reportService.asyncReport).toHaveBeenCalledWith('runner', 'runner-1', 'job-1', {
      status: RatchetJQJobStatus.OK,
      outParams: { echoed: 1 },
    })
  })

  // The route offers one form and it is the one that does not make the caller
  // wait. A runner reporting from its poll loop cannot act on the verdict, so
  // holding its request for one would tie that loop to a decision it has no use
  // for — and `syncReport` belongs to the proposer, which reports in-process for
  // the one case that is actually waiting.
  it('never holds the request for the accept', async () => {
    const { controller, reportService } = makeController()

    await controller.reportJob(RUNNER_AUTH, 'job-1', REPORTED)

    expect(reportService.syncReport).not.toHaveBeenCalled()
  })

  // A repeat report, or one for a job whose lease this runner has already lost.
  // Normal under at-least-once delivery, so it answers rather than failing the
  // runner's poll — and the two cannot be told apart from here.
  it('answers that nothing was recorded when the executor holds no such job', async () => {
    const { controller } = makeController({ reported: null })

    await expect(controller.reportJob(RUNNER_AUTH, 'job-1', REPORTED)).resolves.toEqual({ accepted: false })
  })

  it('refuses a caller that is not an executor', async () => {
    const { controller, reportService } = makeController()

    await expect(controller.reportJob({} as BaseAuthContext, 'job-1', REPORTED)).rejects.toThrow(ForbiddenException)
    expect(reportService.asyncReport).not.toHaveBeenCalled()
    expect(reportService.syncReport).not.toHaveBeenCalled()
  })
})
