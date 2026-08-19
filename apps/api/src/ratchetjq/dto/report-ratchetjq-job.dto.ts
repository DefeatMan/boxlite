/*
 * Copyright 2026 BoxLite AI
 * SPDX-License-Identifier: AGPL-3.0
 */

import { ApiProperty, ApiPropertyOptional, ApiSchema } from '@nestjs/swagger'
import { IsEnum, IsObject, IsOptional, IsString } from 'class-validator'
import { RatchetJQJobStatus } from '../enums/ratchetjq-job-status.enum'

/**
 * What an executor says when it hands a job's outcome back (spec §9.1).
 *
 * The outcome, plus the one thing only the caller can decide: whether it is
 * waiting for the accept. Which job it belongs to is the path parameter and which
 * executor is reporting comes from the authenticated caller, so there is nothing
 * else here a caller could name that would address someone else's row.
 *
 * A run that raised does come here, as `status = failed` with `errMsg` saying
 * what it said. What still does not come here is a run nobody finished — an
 * executor that crashed, or one whose lease lapsed under it — because there is
 * no one left to send it and no status for "it did not happen". Those stay with
 * the lease and are redelivered (spec §0, at-least-once).
 */
@ApiSchema({ name: 'ReportRatchetJQJobRequest' })
export class ReportRatchetJQJobRequestDto {
  @ApiProperty({
    description: 'The business result the executor reached',
    enum: RatchetJQJobStatus,
    example: RatchetJQJobStatus.OK,
  })
  @IsEnum(RatchetJQJobStatus)
  status: RatchetJQJobStatus

  @ApiPropertyOptional({
    description: 'The job output, shaped by the job type. Omitted when the job produces nothing.',
    type: 'object',
    additionalProperties: true,
  })
  @IsObject()
  @IsOptional()
  outParams?: Record<string, unknown> | null

  // No length rule, deliberately, even though the column is bounded. A rejected
  // report is a lost outcome, and losing one because the executor was verbose
  // about why it failed is the worst of both: the run is not retried and nothing
  // records what happened. The write truncates instead
  // (`ratchetjq-transfer.service.ts:boundedErrMsg`), so a long message costs its
  // tail rather than the whole report.
  @ApiPropertyOptional({
    description:
      'Why the run failed, in the executor’s own words. Sent with status "failed"; omitted for a run that produced an outcome. Stored truncated.',
    example: 'ratchetjq: job panicked: runtime error: index out of range [3] with length 2',
  })
  @IsString()
  @IsOptional()
  errMsg?: string | null
}

/**
 * What a report answers with.
 *
 * `accepted` is about the record, not about the verdict: it says the outcome was
 * written and an accept round was started for it. Whether that round let the
 * outcome stand or rolled it back is not here, because a reporting executor has
 * nothing to do about it either way — the compensation is the control plane's own
 * job. The answer therefore comes as the round starts rather than when it ends;
 * an executor is never held for a decision it cannot act on.
 *
 * False is not an error, which is why this is a field and not a 404. A report
 * matching no `running` row is the normal shape of at-least-once delivery: the
 * executor sent the outcome twice, or the job was taken back by the Scanner
 * while the run was in flight. Neither is worth failing a runner's poll over,
 * and the two cannot be told apart from here.
 */
@ApiSchema({ name: 'ReportRatchetJQJobResponse' })
export class ReportRatchetJQJobResponseDto {
  @ApiProperty({
    description:
      'Whether the outcome was recorded. False means this executor held no running job of that id — a repeat report, or a job whose lease it had already lost.',
    example: true,
  })
  accepted: boolean

  constructor(accepted: boolean) {
    this.accepted = accepted
  }
}
