/*
 * Copyright 2026 BoxLite AI
 * SPDX-License-Identifier: AGPL-3.0
 */

import { Injectable, Logger } from '@nestjs/common'
import { IJobAcceptor, RatchetJQAcceptVerdict } from '../common/job-acceptor'
import { RatchetJQJob } from '../entities/ratchetjq-job.entity'

/**
 * The job type this acceptor serves. It has to match the name the executor's own
 * implementation reports — `jobs.EchoType`
 * (`apps/runner/pkg/ratchetjq/jobs/echo.go:EchoType`) — because that string is the
 * whole of dispatch, and the two halves are registered independently with
 * nothing to check that they agree.
 */
export const ECHO_JOB_TYPE = 'echo'

/**
 * Accepts the echo job by writing down what it saw.
 *
 * It is the acceptor-side counterpart of `jobs.Echo`
 * (`apps/runner/pkg/ratchetjq/jobs/echo.go:Echo`), and it exists for the same
 * reason: performing no side effect of its own, it is what to run when the thing
 * being exercised is the pipeline — dispatch, transport, accept — rather than any
 * real work. It decides without awaiting anything, which is allowed only because
 * it does nothing: the contract asks an acceptor to yield before doing work
 * (`job-acceptor.ts`), and one that logs a line and returns has none to do.
 *
 * It accepts unconditionally, and that is a statement about the job type rather
 * than a limitation of the segment: an echo performs no side effect, so there is
 * nothing about it that could fail to stand. A ROLLBACK verdict is acted on where
 * an acceptor does return one — the rollback job is queued and the original
 * completes as rejected (`accept-finalizer.ts:rollback`).
 */
@Injectable()
export class LogAndCompleteAcceptor implements IJobAcceptor {
  readonly type = ECHO_JOB_TYPE

  private readonly logger = new Logger(LogAndCompleteAcceptor.name)

  // The contract's AbortSignal is left off deliberately, which TypeScript allows
  // an implementation to do: this acceptor waits on nothing, deciding on the turn
  // it is called, so there is no window in which abandoning it could reclaim
  // anything. An acceptor that does wait has to take it and honour it.
  async accept(job: RatchetJQJob): Promise<RatchetJQAcceptVerdict> {
    // Both params are serialised whole, which is what makes this useful for
    // tracing a job through the pipeline and also its one cost: they are
    // caller-supplied jsonb, so a large or sensitive payload is logged as it
    // stands.
    this.logger.log(
      `Accepting RatchetJQ job ${job.id}: ` +
        `inParams=${JSON.stringify(job.inParams ?? null)}, outParams=${JSON.stringify(job.outParams ?? null)}`,
    )

    return RatchetJQAcceptVerdict.ACCEPTED
  }
}
