/*
 * Copyright 2026 BoxLite AI
 * SPDX-License-Identifier: AGPL-3.0
 */

import { Configuration, RatchetjqApi } from '@boxlite-ai/runner-api-client'
import { Injectable, Logger } from '@nestjs/common'
import { InjectRepository } from '@nestjs/typeorm'
import axios from 'axios'
import { Repository } from 'typeorm'
import { Runner } from '../../box/entities/runner.entity'
import { ISyncJobExecutor, RatchetJQSyncRunOutcome } from '../common/job-executor'
import { RatchetJQJob } from '../entities/ratchetjq-job.entity'
import { RatchetJQExecutor } from '../enums/ratchetjq-executor.enum'
import { RatchetJQExecutorUnreachableError } from '../errors/ratchetjq-executor-unreachable.error'

/**
 * The pushed half of spec §9.4, seen from the control plane: hand one job to the
 * runner instance that owns it and wait for its outcome.
 *
 * One of possibly several ISyncJobExecutor implementations, keyed by the kind it
 * reports. Runners are the only kind today; a second one is a class here and an
 * entry in the module's executor list, and nothing else — the proposer resolves
 * whatever kind a submission names.
 *
 * It talks through the generated runner client rather than a hand-written call,
 * so the request and response shapes come from the runner's own OpenAPI document
 * and a route that changes there stops compiling here.
 *
 * The runner row is read straight from its table rather than through the box
 * module's RunnerService. Registering that entity outside its own module is what
 * `usage` and `region` already do (`usage.module.ts`, `region.module.ts`),
 * and it keeps the dependency pointing one way: box will submit RatchetJQ jobs
 * before long, and a module import in this direction would close that circle.
 */
@Injectable()
export class RatchetJQRunnerExecutor implements ISyncJobExecutor {
  readonly executor = RatchetJQExecutor.RUNNER

  private readonly logger = new Logger(RatchetJQRunnerExecutor.name)

  constructor(@InjectRepository(Runner) private readonly runners: Repository<Runner>) {}

  /**
   * Runs one job on its executor and hands back what that executor reported.
   *
   * The wait is bounded by the job's own `ttlSeconds`, which is the lease the row
   * holds: past it the job is claimable again, so a caller still waiting would be
   * waiting on a round that no longer belongs to it. Aborting also reaches the
   * far side — the runner runs the job on its request context, so a client that
   * gives up cancels the run rather than leaving it going with nobody to answer.
   *
   * No retry. Delivery is at-least-once and job types are idempotent, so a retry
   * would be safe, but it would spend another whole lease on a round the pulled
   * path is already going to take once this one lapses.
   */
  async syncRun(executorId: string, job: RatchetJQJob, signal?: AbortSignal): Promise<RatchetJQSyncRunOutcome> {
    const runner = await this.runners.findOne({ where: { id: executorId } })
    if (!runner) {
      throw new RatchetJQExecutorUnreachableError(job.id, executorId, 'no such runner')
    }
    if (!runner.apiUrl) {
      throw new RatchetJQExecutorUnreachableError(job.id, executorId, 'the runner has no API URL')
    }

    const timeoutMs = job.ttlSeconds * 1_000
    const client = new RatchetjqApi(
      new Configuration(),
      '',
      axios.create({
        baseURL: runner.apiUrl,
        headers: { Authorization: `Bearer ${runner.apiKey}` },
        timeout: timeoutMs,
      }),
    )

    this.logger.log(`Running RatchetJQ job ${job.id} on ${executorId} inline, for at most ${job.ttlSeconds}s`)

    const { data } = await client.syncRatchetJob(
      {
        id: job.id,
        type: job.type,
        resourceId: job.resourceId,
        // The generated shape is optional, and `null` is not the same as absent to
        // a Go handler binding it: an omitted field leaves the job's own zero
        // value, where a null would have to be decoded as one.
        inParams: job.inParams ?? undefined,
      },
      // Two independent bounds, and both are wanted: `timeout` is the job's own
      // budget, `signal` is the caller's patience, and whichever comes first ends
      // the call. Handing the signal to axios rather than checking it beforehand
      // is what makes it a cancellation — the runner runs the job on its request
      // context, so aborting here also stops the far side instead of leaving it
      // working with nobody to answer.
      { signal },
    )

    return {
      status: data.status,
      outParams: (data.outParams as Record<string, unknown> | undefined) ?? null,
      errMsg: data.errMsg ?? null,
    }
  }
}
