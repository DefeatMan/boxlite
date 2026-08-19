/*
 * Copyright 2026 BoxLite AI
 * SPDX-License-Identifier: AGPL-3.0
 */

import { Body, Controller, Logger, Param, Post, Req, UseGuards } from '@nestjs/common'
import { ApiBearerAuth, ApiOAuth2, ApiOperation, ApiParam, ApiResponse, ApiTags } from '@nestjs/swagger'
import { Request } from 'express'
import { CombinedAuthGuard } from '../../auth/combined-auth.guard'
import { AuthContext } from '../../common/decorators/auth-context.decorator'
import { BaseAuthContext } from '../../common/interfaces/auth-context.interface'
import { resolveExecutorIdentity } from '../common/executor-identity'
import {
  ClaimedRatchetJQJobDto,
  ClaimRatchetJQJobsRequestDto,
  ClaimRatchetJQJobsResponseDto,
} from '../dto/claim-ratchetjq-jobs.dto'
import { ReportRatchetJQJobRequestDto, ReportRatchetJQJobResponseDto } from '../dto/report-ratchetjq-job.dto'
import { RatchetJQReportService } from '../services/ratchetjq-report.service'
import { RatchetJQTransferService } from '../services/ratchetjq-transfer.service'

/**
 * The executor-facing REST surface: where an executor pulls the jobs it may run
 * now (spec §6), and where it hands their outcomes back (spec §9.1).
 *
 * Both routes live here because both are the same conversation with the same
 * peer — one runner's poll loop calls claim and then report for what it claimed —
 * and both resolve who is calling the same way. Splitting them would mean two
 * controllers deriving one identity.
 *
 * Which executor is calling comes from the authenticated caller and never from
 * the request — an executor may only ever claim, and report against, its own jobs,
 * so there is nothing for a caller to name. Only authentication is guarded here;
 * deciding that a caller is an executor at all belongs to
 * `resolveExecutorIdentity`, so that supporting a second kind of executor stays a
 * single change rather than a change plus a guard nobody remembers to widen.
 */
@ApiTags('ratchetjq')
@Controller('ratchetjq/jobs')
@UseGuards(CombinedAuthGuard)
@ApiOAuth2(['openid', 'profile', 'email'])
@ApiBearerAuth()
export class RatchetJQTransferController {
  private readonly logger = new Logger(RatchetJQTransferController.name)

  constructor(
    private readonly transferService: RatchetJQTransferService,
    private readonly reportService: RatchetJQReportService,
  ) {}

  // POST rather than GET: a claim rewrites the rows it hands back — it advances
  // their period, moves their deadlines and, in steady state, spends a retry
  // round — so it takes ownership rather than reading.
  @Post('claim')
  @ApiOperation({
    summary: 'Claim RatchetJQ jobs',
    operationId: 'claimRatchetJQJobs',
    description:
      'Long poll for the jobs this runner may run now. Returns as soon as any are available, otherwise blocks until the next job falls due, for at most 60 seconds. Claiming takes ownership: it advances the jobs it returns and moves their leases.',
  })
  @ApiResponse({
    status: 201,
    description: 'The jobs this runner may run now',
    type: ClaimRatchetJQJobsResponseDto,
  })
  async claimJobs(
    @Req() request: Request,
    @AuthContext() auth: BaseAuthContext,
    // Optional, because a steady-state claim asks for nothing: an executor may
    // post no body at all rather than spell out the default.
    @Body() body?: ClaimRatchetJQJobsRequestDto,
  ): Promise<ClaimRatchetJQJobsResponseDto> {
    const { executor, executorId } = resolveExecutorIdentity(auth)

    // A claim can sit blocked for up to a minute, so an executor that hangs up
    // must release it rather than leave a request and a Redis connection waiting
    // out the full timeout for a client that is gone.
    const abortController = new AbortController()
    const onClose = () => abortController.abort()
    request.on('close', onClose)

    try {
      const jobs = await this.transferService.claimJobs(
        executor,
        executorId,
        // Absent means "a full batch": the service clamps whatever it is given to
        // its own batch size, so Infinity resolves to that ceiling rather than
        // duplicating the number here.
        body?.limit ?? Number.POSITIVE_INFINITY,
        body?.ignoreLeaseExpire ?? false,
        abortController.signal,
      )

      return { jobs: jobs.map((job) => new ClaimedRatchetJQJobDto(job)) }
    } catch (error) {
      // An executor that disconnected is not an error worth raising: the claim it
      // abandoned either took nothing or will come round again when its lease
      // expires, which is what at-least-once delivery is for.
      if (abortController.signal.aborted) {
        this.logger.debug(`Executor ${executor}/${executorId} disconnected while claiming RatchetJQ jobs`)
        return { jobs: [] }
      }
      throw error
    } finally {
      request.off('close', onClose)
    }
  }

  // POST for the same reason as the claim: it advances the row's period, writes
  // the outcome and takes an accept lease. It is also the reason it is not
  // idempotent-by-URL — a second report finds the row already `accepting` and
  // answers `accepted: false`.
  @Post(':jobId/report')
  @ApiOperation({
    summary: 'Report a RatchetJQ job outcome',
    operationId: 'reportRatchetJQJob',
    description:
      'Hand back what this runner produced for a job it claimed, or the error that stopped it. The outcome is recorded, an accept round is started for it, and the response comes as that round starts rather than when it decides — the verdict is the control plane’s to act on. A run nobody finished is still not reported: its lease is what redelivers it.',
  })
  @ApiParam({
    name: 'jobId',
    description: 'ID of the claimed job the outcome belongs to',
    type: 'string',
  })
  @ApiResponse({
    status: 201,
    description: 'Whether the outcome was recorded',
    type: ReportRatchetJQJobResponseDto,
  })
  async reportJob(
    @AuthContext() auth: BaseAuthContext,
    @Param('jobId') jobId: string,
    @Body() body: ReportRatchetJQJobRequestDto,
  ): Promise<ReportRatchetJQJobResponseDto> {
    const { executor, executorId } = resolveExecutorIdentity(auth)

    // The asynchronous form, and the only one this route offers. The caller is a
    // runner reporting from its own poll loop: it is not waiting on the accept,
    // and holding its request open for a verdict it cannot act on would tie that
    // loop to a decision that may take as long as it likes.
    //
    // The other direction — hold the request until the accept has decided — is
    // deliberately absent rather than behind a flag. Its one use in the spec is a
    // runner reporting from inside a pushed `SyncRun` (§4), and this
    // implementation does not report from there: the runner answers `SyncRun`
    // with the outcome and the proposer, which is the side actually waiting,
    // reports in-process (`ratchetjq-proposer.service.ts:accept`). That leaves no
    // caller for a waiting form over REST, and an unused route that holds a
    // request open through an unbounded accept is a surface, not a spare part. If
    // the nested chain is ever wanted, it belongs at its own endpoint — the two
    // differ in what the caller must do while waiting, not in a parameter —
    // and `syncReport` is already there to serve it.
    const job = await this.reportService.asyncReport(executor, executorId, jobId, {
      status: body.status,
      outParams: body.outParams,
      errMsg: body.errMsg,
    })
    if (!job) {
      this.logger.warn(`Executor ${executor}/${executorId} reported RatchetJQ job ${jobId}, which it does not hold`)
      return new ReportRatchetJQJobResponseDto(false)
    }

    return new ReportRatchetJQJobResponseDto(true)
  }
}
