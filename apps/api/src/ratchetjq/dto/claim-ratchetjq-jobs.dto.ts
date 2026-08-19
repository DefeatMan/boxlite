/*
 * Copyright 2026 BoxLite AI
 * SPDX-License-Identifier: AGPL-3.0
 */

import { ApiProperty, ApiPropertyOptional, ApiSchema } from '@nestjs/swagger'
import { IsBoolean, IsDate, IsInt, IsObject, IsOptional, IsString, Min } from 'class-validator'
import { RatchetJQJob } from '../entities/ratchetjq-job.entity'

/**
 * What an executor asks for when it claims.
 *
 * Everything else about a claim is already known from the authenticated runner,
 * so this carries only what the caller decides: how many jobs it can take, and
 * which of the two claim modes it wants.
 */
@ApiSchema({ name: 'ClaimRatchetJQJobsRequest' })
export class ClaimRatchetJQJobsRequestDto {
  @ApiPropertyOptional({
    description:
      'How many jobs to hand over at most — the executor’s remaining concurrency budget. Capped by the server’s own batch size. Omitting it asks for a full batch.',
    minimum: 1,
    example: 16,
  })
  @IsInt()
  @Min(1)
  @IsOptional()
  limit?: number

  @ApiPropertyOptional({
    description:
      'Set on the first claim after the runner starts. Takes back its interrupted jobs without waiting out leases granted to the process that died, and without spending a retry round on the restart.',
    default: false,
  })
  @IsBoolean()
  @IsOptional()
  ignoreLeaseExpire?: boolean
}

/**
 * One claimed job, as the executor sees it (spec §2.1).
 *
 * Only what is needed to run the job crosses the wire. The scheduling columns —
 * period, visibleAt, attempt, the budgets — stay behind: they belong to the
 * control plane, and an executor that read its own backoff or attempt count
 * would be second-guessing the scheduler that granted them.
 *
 * `leaseExpiresAt` is the exception, and it is not second-guessing but the
 * opposite: it is the deadline this claim grants, and an executor that cannot
 * see it has no way to stop at it. Without it a job wedged on an unresponsive
 * dependency holds its concurrency slot for the runner's whole life, and enough
 * of those wedge that runner's pull path for good.
 */
@ApiSchema({ name: 'ClaimedRatchetJQJob' })
export class ClaimedRatchetJQJobDto {
  @ApiProperty({
    description: 'The ID of the job, which its outcome is reported against',
    example: '3f1c7b9e-9a1e-4c3a-9d2b-0f7a5e6c1d20',
  })
  @IsString()
  id: string

  @ApiProperty({
    description: 'The job type to run this job, matching the name the executor registers it under',
    example: 'echo',
  })
  @IsString()
  type: string

  @ApiProperty({
    description: 'The resource the job acts on',
    example: 'box123',
  })
  @IsString()
  resourceId: string

  @ApiPropertyOptional({
    description: 'The job input, shaped by the job type',
    type: 'object',
    additionalProperties: true,
  })
  @IsObject()
  @IsOptional()
  inParams?: Record<string, unknown> | null

  @ApiProperty({
    description:
      'When this claim on the job lapses. The executor must stop running it by then: past this moment the job is claimable again, so anything still working on it is racing whoever picked it up next.',
    type: String,
    format: 'date-time',
    example: '2026-08-20T12:34:56.000Z',
  })
  @IsDate()
  leaseExpiresAt: Date

  constructor(job: RatchetJQJob) {
    this.id = job.id
    this.type = job.type
    this.resourceId = job.resourceId
    this.inParams = job.inParams ?? null
    // The row the claim statement returned, so this is the lease that statement
    // just wrote, not a stale one read beforehand.
    this.leaseExpiresAt = job.leaseExpiresAt
  }
}

/**
 * The claim response. A claim that found nothing returns an empty list rather
 * than an error: coming back empty-handed is the normal outcome of a poll.
 */
@ApiSchema({ name: 'ClaimRatchetJQJobsResponse' })
export class ClaimRatchetJQJobsResponseDto {
  @ApiProperty({
    description: 'The jobs this executor may run now',
    type: [ClaimedRatchetJQJobDto],
  })
  jobs: ClaimedRatchetJQJobDto[]
}
