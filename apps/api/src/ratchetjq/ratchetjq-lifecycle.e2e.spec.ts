/*
 * Copyright 2026 BoxLite AI
 * SPDX-License-Identifier: AGPL-3.0
 */

import { RedisModule } from '@nestjs-modules/ioredis'
import { Test, TestingModule } from '@nestjs/testing'
import { getRepositoryToken, TypeOrmModule } from '@nestjs/typeorm'
import { randomUUID } from 'node:crypto'
import { Repository } from 'typeorm'
import { Runner } from '../box/entities/runner.entity'
import { RunnerState } from '../box/enums/runner-state.enum'
import { CustomNamingStrategy } from '../common/utils/naming-strategy.util'
import { TypedConfigModule } from '../config/typed-config.module'
import { TypedConfigService } from '../config/typed-config.service'
import { ECHO_JOB_TYPE } from './acceptors/log-and-complete.acceptor'
import { RatchetJQJob } from './entities/ratchetjq-job.entity'
import { RatchetJQExecutor } from './enums/ratchetjq-executor.enum'
import { RatchetJQJobPeriod } from './enums/ratchetjq-job-period.enum'
import { RatchetJQJobStatus } from './enums/ratchetjq-job-status.enum'
import { RatchetJQModule } from './ratchetjq.module'
import { RatchetJQProposerService } from './services/ratchetjq-proposer.service'

/**
 * The one test that crosses the API↔runner boundary.
 *
 * Everything else in this module is tested against a stub on one side or the
 * other, which leaves the two halves of a job type registered independently in
 * two languages with nothing exercising the string that joins them. This runs
 * the whole thing: a real row in the real table, a real runner claiming it over
 * HTTP, and a real acceptor completing it.
 *
 * **It needs a live local stack** (`apps/infra-local`: `make up`) and skips
 * otherwise, the same way the repo's other real-Postgres tests guard themselves
 * (`box/services/job.service.claim.integration.spec.ts`). It is opt-in on
 * RATCHETJQ_E2E rather than on DB_HOST alone, because unlike those it needs more
 * than a database — an API process serving `/ratchetjq/jobs/claim` and a runner
 * whose poller is on — and a test that silently passed against half a stack
 * would be worse than one that skipped.
 *
 * Submission is in-process because that is the only way in: PROPOSER has no HTTP
 * surface, so nothing outside this repo can submit a RatchetJQ job. This process
 * therefore boots RatchetJQModule against the *live* database — a second replica
 * of the control plane, which is a shape production already has — and writes its
 * row where the running API and runner will find it. What claims, reports and
 * accepts is the stack, not this process.
 *
 * It deliberately does not `init()` the module, only `compile()` it. Lifecycle
 * hooks stay unfired, so this replica takes no Scanner slot and the backstop
 * stays the running API's job; the writes and reads are all this process needs.
 */
const describeIfStack = process.env.RATCHETJQ_E2E ? describe : describe.skip

/** How long to wait for the stack to carry a job to `completed`. */
const COMPLETION_TIMEOUT_MS = 90_000

/** How often to look, while waiting. */
const POLL_INTERVAL_MS = 500

/**
 * How long to wait for the stack's runner to report itself ready. Generous, so a
 * test run straight after `make up` waits for the first healthcheck rather than
 * failing on it.
 */
const RUNNER_READY_TIMEOUT_MS = 60_000

/**
 * Long enough for the runner to notice. Its poll wait is 5s by default
 * (`RATCHETJQ_POLL_WAIT`), and a job has to be claimed, run, reported and
 * accepted inside this, so the budget is the poll wait plus room for a slow
 * first round rather than a tight bound.
 */
jest.setTimeout(COMPLETION_TIMEOUT_MS + 30_000)

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

describeIfStack('RatchetJQ job lifecycle (e2e, live API + runner)', () => {
  let moduleRef: TestingModule
  let proposer: RatchetJQProposerService
  let jobs: Repository<RatchetJQJob>
  let runnerId: string

  beforeAll(async () => {
    moduleRef = await Test.createTestingModule({
      imports: [
        TypedConfigModule.forRoot({ isGlobal: true }),
        TypeOrmModule.forRootAsync({
          inject: [TypedConfigService],
          useFactory: (config: TypedConfigService) => ({
            type: 'postgres' as const,
            host: config.getOrThrow('database.host'),
            port: config.getOrThrow('database.port'),
            username: config.getOrThrow('database.username'),
            password: config.getOrThrow('database.password'),
            database: config.getOrThrow('database.database'),
            autoLoadEntities: true,
            // The running API owns the schema. A second process running
            // migrations against it is how two replicas deadlock on a lock table,
            // and there is nothing here to migrate anyway.
            migrationsRun: false,
            namingStrategy: new CustomNamingStrategy(),
            entitySkipConstructor: true,
          }),
        }),
        RedisModule.forRootAsync({
          inject: [TypedConfigService],
          useFactory: (config: TypedConfigService) => ({
            type: 'single' as const,
            options: config.getRedisConfig(),
          }),
        }),
        RatchetJQModule,
      ],
    }).compile()

    proposer = moduleRef.get(RatchetJQProposerService)
    jobs = moduleRef.get(getRepositoryToken(RatchetJQJob))

    runnerId = await readyRunnerId(moduleRef)
  })

  afterAll(async () => {
    await moduleRef?.close()
  })

  /**
   * The runner the jobs are addressed to.
   *
   * `executorId` is not a name this test may invent: a claim is scoped to one
   * instance, so a job written for an id no runner holds is a job nobody will
   * ever poll for. Failing loudly beats submitting into a queue with no reader
   * and then timing out with nothing to say about why.
   *
   * It waits for one rather than demanding one on the first look, because a
   * runner that has only just started is `initializing` until its first
   * healthcheck lands — so a test run straight after `make up` would otherwise
   * fail on timing rather than on anything real. It still refuses to guess: more
   * than one ready runner means the job could be addressed to the wrong host, and
   * that is not something to pick a winner for.
   */
  async function readyRunnerId(module: TestingModule): Promise<string> {
    const runners: Repository<Runner> = module.get(getRepositoryToken(Runner))
    const deadline = Date.now() + RUNNER_READY_TIMEOUT_MS
    let seen = 0

    while (Date.now() < deadline) {
      const ready = await runners.find({ where: { state: RunnerState.READY } })
      seen = ready.length

      if (seen === 1) {
        return ready[0].id
      }
      if (seen > 1) {
        break
      }
      await sleep(POLL_INTERVAL_MS)
    }

    throw new Error(
      `This test needs exactly one ready runner to address jobs to, found ${seen}. ` +
        `Bring the local stack up with "make up" in apps/infra-local.`,
    )
  }

  /** The row, once it reaches `completed`, or a failure saying where it stalled. */
  async function awaitCompletion(jobId: string): Promise<RatchetJQJob> {
    const deadline = Date.now() + COMPLETION_TIMEOUT_MS
    let last: RatchetJQJob | null = null

    while (Date.now() < deadline) {
      last = await proposer.findById(jobId)
      if (last?.period === RatchetJQJobPeriod.COMPLETED) {
        return last
      }
      await sleep(POLL_INTERVAL_MS)
    }

    // The stage and the attempt are the whole diagnosis: still `pending_run`
    // means nothing claimed it, `running` means the runner has it and has not
    // reported, `accepting` means it ran and the accept has not settled.
    throw new Error(
      `RatchetJQ job ${jobId} did not complete within ${COMPLETION_TIMEOUT_MS}ms; ` +
        `it is period=${last?.period ?? 'gone'} status=${last?.status ?? 'none'} ` +
        `attempt=${last?.attempt ?? '?'} errMsg=${last?.errMsg ?? 'none'}`,
    )
  }

  /**
   * The pulled path, end to end: submitted here, claimed by the runner over
   * HTTP, run, reported, accepted, completed.
   *
   * `outParams` is the assertion that matters, and it is deliberately not just
   * "the job completed". Echo hands its input back as its output
   * (`jobs/echo.go:SyncExec`), so a payload that survives the round trip proves
   * the whole chain carried it: this process's insert, the claim's JSON, the
   * runner's `json.RawMessage`, the report body, and the write into `outParams`.
   * A job that completed with an empty output would satisfy the stage check and
   * tell us nothing about the wire.
   */
  it('carries a submitted echo job through the runner to completed', async () => {
    const marker = randomUUID()

    const submitted = await proposer.execAsync({
      executor: RatchetJQExecutor.RUNNER,
      executorId: runnerId,
      resourceId: `ratchetjq-e2e-${marker}`,
      type: ECHO_JOB_TYPE,
      ttlSeconds: 30,
      attlSeconds: 15,
      inParams: { marker },
    })

    expect(submitted.period).toBe(RatchetJQJobPeriod.PENDING_RUN)

    const completed = await awaitCompletion(submitted.id)

    expect(completed.status).toBe(RatchetJQJobStatus.OK)
    expect(completed.outParams).toEqual({ marker })
    expect(completed.errMsg).toBeNull()
    // No compensation: the outcome stood, so nothing was rolled back.
    expect(completed.rollbackJobId).toBeNull()
  })

  /**
   * The guard, against the real table: a type with no acceptor is refused before
   * a row exists.
   *
   * Asserting the absence of the row is the substance. The throw alone would be
   * satisfied by a check placed after the insert, and that check would be
   * worthless here — the row would already be scheduled, and the cheapest end it
   * could reach is being retired as `timeout` behind a rollback job.
   */
  it('refuses a job type the control plane cannot accept, leaving no row', async () => {
    const resourceId = `ratchetjq-e2e-unknown-${randomUUID()}`

    await expect(
      proposer.execAsync({
        executor: RatchetJQExecutor.RUNNER,
        executorId: runnerId,
        resourceId,
        type: 'ratchetjq-e2e-no-such-job-type',
        ttlSeconds: 30,
        attlSeconds: 15,
      }),
    ).rejects.toThrow('No RatchetJQ acceptor for the type "ratchetjq-e2e-no-such-job-type"')

    await expect(jobs.findOne({ where: { resourceId } })).resolves.toBeNull()
  })
})
