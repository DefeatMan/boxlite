/*
 * Copyright 2026 BoxLite AI
 * SPDX-License-Identifier: AGPL-3.0
 */

import { Body, Controller, Logger, Post, Req, UseGuards } from '@nestjs/common'
import { ApiBearerAuth, ApiOAuth2, ApiOperation, ApiResponse, ApiTags } from '@nestjs/swagger'
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
import { RatchetJQTransferService } from '../services/ratchetjq-transfer.service'

/**
 * TRANSFER's pulled path (spec §6): the endpoint an executor polls for the jobs
 * it may run now.
 *
 * Which executor is claiming comes from the authenticated caller and never from
 * the request — an executor may only ever claim its own jobs, so there is
 * nothing for a caller to name. Only authentication is guarded here; deciding
 * that a caller is an executor at all belongs to `resolveExecutorIdentity`, so
 * that supporting a second kind of executor stays a single change rather than a
 * change plus a guard nobody remembers to widen.
 */
@ApiTags('ratchetjq')
@Controller('ratchetjq/jobs')
@UseGuards(CombinedAuthGuard)
@ApiOAuth2(['openid', 'profile', 'email'])
@ApiBearerAuth()
export class RatchetJQTransferController {
  private readonly logger = new Logger(RatchetJQTransferController.name)

  constructor(private readonly transferService: RatchetJQTransferService) {}

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
}
