/*
 * Copyright 2026 BoxLite AI
 * SPDX-License-Identifier: AGPL-3.0
 */

import { Injectable, Logger } from '@nestjs/common'
import { ISyncJobAcceptor, RatchetJQAcceptVerdict } from '../common/job-acceptor'
import { RatchetJQJob } from '../entities/ratchetjq-job.entity'

/**
 * The job type this acceptor serves. It has to match the name the executor's own
 * implementation reports — `jobs.EchoType`
 * (`apps/runner/pkg/ratchetjq/jobs/echo.go:15`) — because that string is the
 * whole of dispatch, and the two halves are registered independently with
 * nothing to check that they agree.
 */
export const ECHO_JOB_TYPE = 'echo'

/**
 * Accepts the echo job by writing down what it saw.
 *
 * It is the acceptor-side counterpart of `jobs.Echo`
 * (`apps/runner/pkg/ratchetjq/jobs/echo.go:22`), and it exists for the same
 * reason: performing no side effect of its own, it is what to run when the thing
 * being exercised is the pipeline — dispatch, transport, accept — rather than any
 * real work. Implementing only ISyncJobAcceptor, it is also what puts
 * AsyncAcceptor's inline-to-deferred adaptation on a live path, since it decides
 * without awaiting anything and so would run on its caller's stack if that
 * adaptation ever stopped yielding first.
 *
 * It accepts unconditionally. An acceptor that could return ROLLBACK would be
 * asking for a rollback job the PROPOSER cannot create yet; this one never does,
 * so it is the only acceptor that can currently reach a terminal stage.
 */
@Injectable()
export class LogAndCompleteAcceptor implements ISyncJobAcceptor {
  readonly type = ECHO_JOB_TYPE

  private readonly logger = new Logger(LogAndCompleteAcceptor.name)

  // The contract's AbortSignal is left off deliberately, which TypeScript allows
  // an implementation to do: this acceptor waits on nothing, deciding on the turn
  // it is called, so there is no window in which abandoning it could reclaim
  // anything. An acceptor that does wait has to take it and honour it.
  async syncAccept(job: RatchetJQJob): Promise<RatchetJQAcceptVerdict> {
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
