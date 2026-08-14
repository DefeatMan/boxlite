/*
 * Copyright 2026 BoxLite AI
 * SPDX-License-Identifier: AGPL-3.0
 */

import { randomUUID } from 'node:crypto'
import { Redis } from 'ioredis'
import { DataSource, Repository } from 'typeorm'

import { CustomNamingStrategy } from '../../common/utils/naming-strategy.util'
import { configuration } from '../../config/configuration'
import { TypedConfigService } from '../../config/typed-config.service'
import { RedisLockProvider } from '../common/redis-lock.provider'
import { Box } from '../entities/box.entity'
import { BoxLastActivity } from '../entities/box-last-activity.entity'
import { BoxMigration } from '../entities/box-migration.entity'
import { Job } from '../entities/job.entity'
import { Runner } from '../entities/runner.entity'
import { BoxDesiredState } from '../enums/box-desired-state.enum'
import { BoxMigrationState } from '../enums/box-migration-state.enum'
import { BoxState } from '../enums/box-state.enum'
import { JobStatus } from '../enums/job-status.enum'
import { JobType } from '../enums/job-type.enum'
import { RunnerState } from '../enums/runner-state.enum'
import { BoxMigrationManager } from '../managers/box-migration.manager'
import { BoxRepository } from '../repositories/box.repository'
import { getMigrateJobLockKey } from '../utils/lock-key.util'
import { BoxMigrationJobReceiver } from './box-migration-job-receiver.service'
import { BoxMigrationService } from './box-migration.service'
import { JobService } from './job.service'
import { JobStateHandlerService } from './job-state-handler.service'
import { RunnerService } from './runner.service'

/*
 * What a drain does to a box, from the operator marking the runner to the
 * runner holding nothing.
 *
 * Each step of a migration is covered on its own elsewhere, and the marker's
 * claim has a real database under it. What no such spec can show is the drain
 * itself: five components hand the box along by writing rows the next one
 * reads back, and the handover is the one thing none of them spans —
 * the state the submitter selects on is the one the receiver wrote, the
 * archive key the runner is given survives the job table, the ownership move
 * lands in Postgres, and the job lock spans the runner's work rather than the
 * tick that started it. So the components here are the real ones on a real
 * Postgres and a real Redis, and only what is outside the control plane is
 * played by the test: the runner, which reports its jobs done.
 *
 * Runs only when a Postgres and a Redis are reachable; skipped otherwise.
 */
const describeIfDatabase = process.env.DB_HOST && process.env.REDIS_HOST ? describe : describe.skip

const schemaName = `box_migration_drain_${process.pid}_${randomUUID().replaceAll('-', '')}`
const REGION = 'us'
const ORGANIZATION_ID = '00000000-0000-4000-8000-0000000000ff'
// Read from the config the export leg derives its key from, not spelled out
// again here: an environment that sets BOX_MIGRATION_ARCHIVE_PREFIX would
// otherwise fail the key assertions for a reason that is not a bug.
const ARCHIVE_PREFIX = configuration.boxMigration.archivePrefix

/** The jobs a migration hands out — the locks a finished test has to leave clean. */
const MIGRATION_JOB_TYPES = [
  JobType.EXPORT_BOX,
  JobType.IMPORT_BOX,
  JobType.ROLLBACK_EXPORT_BOX,
  JobType.ROLLBACK_IMPORT_BOX,
  JobType.DISCARD_EXPORTED_BOX,
]

/** One worker per loop, so the keys are fixed rather than per-box. */
const LOOP_LOCK_KEYS = [
  'migration-marker',
  'box-migration-submit-worker-selected',
  'box-migration-rollback-worker-selected',
]

describeIfDatabase('Box migration off a draining runner (integration, real Postgres + Redis)', () => {
  let dataSource: DataSource
  let redis: Redis
  let boxes: Repository<Box>
  let migrations: Repository<BoxMigration>
  let jobs: Repository<Job>
  let runners: Repository<Runner>

  let boxRepository: BoxRepository
  let runnerService: RunnerService
  let jobService: JobService
  let marker: BoxMigrationService
  let manager: BoxMigrationManager
  let ownsSchema = false

  // A job status is handed to the state handler without being waited on, so the
  // call that reports a job done returns before the migration has moved. The
  // test needs the answer the API does not.
  let applying: Promise<void>[] = []

  let drainingRunnerId: string
  let alsoDrainingRunnerId: string
  let healthyRunnerId: string
  let createdBoxIds: string[] = []

  beforeAll(async () => {
    dataSource = await new DataSource({
      type: 'postgres',
      host: process.env.DB_HOST,
      port: Number(process.env.DB_PORT || 5432),
      username: process.env.DB_USERNAME,
      password: process.env.DB_PASSWORD,
      database: process.env.DB_DATABASE,
      schema: schemaName,
      entities: [Box, BoxLastActivity, BoxMigration, Job, Runner],
      namingStrategy: new CustomNamingStrategy(),
      entitySkipConstructor: true,
      synchronize: false,
      // TypeORM creates the enum types inside `schema` but copies partial-index
      // predicates into CREATE INDEX verbatim, so box_active_only_idx's
      // `::box_state_enum` cast arrives unqualified and would resolve against
      // the default search_path instead of this run's schema. Putting the schema
      // on the search_path is what lets synchronize() build that index here.
      extra: { options: `-c search_path=${schemaName},public` },
    }).initialize()

    await dataSource.query(`CREATE SCHEMA "${schemaName}"`)
    ownsSchema = true
    await dataSource.synchronize()

    boxes = dataSource.getRepository(Box)
    migrations = dataSource.getRepository(BoxMigration)
    jobs = dataSource.getRepository(Job)
    runners = dataSource.getRepository(Runner)

    redis = new Redis({
      host: process.env.REDIS_HOST,
      port: Number(process.env.REDIS_PORT || 6379),
      maxRetriesPerRequest: 2,
    })

    // The defaults the API boots with, read through the service that reads them:
    // the archive prefix the export is given and the score threshold a runner
    // has to clear to be a target both come from here.
    const configService = new TypedConfigService({
      get: (key: string) => key.split('.').reduce<any>((value, segment) => value?.[segment], configuration),
    } as any)

    const lookupCacheInvalidation = { invalidate: jest.fn(), invalidateOrgId: jest.fn() } as any
    const lockProvider = new RedisLockProvider(redis)
    boxRepository = new BoxRepository(dataSource, { emit: jest.fn() } as any, lookupCacheInvalidation)
    runnerService = new RunnerService(
      runners,
      {} as any,
      boxRepository,
      lockProvider,
      configService,
      {} as any,
      { emit: jest.fn() } as any,
      dataSource,
      redis,
    )
    const receiver = new BoxMigrationJobReceiver(dataSource, lockProvider, lookupCacheInvalidation)
    const stateHandler = new JobStateHandlerService(boxRepository, lockProvider, receiver)
    jobService = new JobService(jobs, redis, {
      handleJobCompletion: (job: Job) => {
        const applied = stateHandler.handleJobCompletion(job)
        applying.push(applied)
        return applied
      },
    } as unknown as JobStateHandlerService)
    marker = new BoxMigrationService(runners, boxRepository, lockProvider)
    manager = new BoxMigrationManager(dataSource, runnerService, jobService, lockProvider, configService)
  })

  afterAll(async () => {
    if (redis) {
      await redis.quit()
    }
    if (!dataSource?.isInitialized) {
      return
    }

    try {
      if (ownsSchema) {
        await dataSource.query(`DROP SCHEMA IF EXISTS "${schemaName}" CASCADE`)
      }
    } finally {
      await dataSource.destroy()
    }
  })

  beforeEach(async () => {
    applying = []
    createdBoxIds = []
    await dataSource.query(`DELETE FROM "${schemaName}"."box_migration"`)
    await dataSource.query(`DELETE FROM "${schemaName}"."job"`)
    await dataSource.query(`DELETE FROM "${schemaName}"."box_last_activity"`)
    await dataSource.query(`DELETE FROM "${schemaName}"."box"`)
    await dataSource.query(`DELETE FROM "${schemaName}"."runner"`)

    drainingRunnerId = await insertRunner('being-drained')
    alsoDrainingRunnerId = await insertRunner('also-being-drained')
    healthyRunnerId = await insertRunner('healthy')
    await markDraining(drainingRunnerId)
    await markDraining(alsoDrainingRunnerId)
  })

  afterEach(async () => {
    // A job lock outlives the tick that took it on purpose, so a test that
    // leaves one held would hand it to the next one.
    await redis.del(
      ...LOOP_LOCK_KEYS,
      ...createdBoxIds.flatMap((boxId) => MIGRATION_JOB_TYPES.map((type) => getMigrateJobLockKey(boxId, type))),
      ...[drainingRunnerId, alsoDrainingRunnerId, healthyRunnerId].map((runnerId) => `runner:jobs:${runnerId}`),
    )
  })

  async function insertRunner(name: string): Promise<string> {
    const runner = new Runner({ region: REGION, name, apiKey: `key-${name}`, apiVersion: '2' })
    runner.state = RunnerState.READY
    runner.lastChecked = new Date()
    // Above the availability threshold, so nothing but `draining` keeps a
    // runner from being picked as the target.
    runner.availabilityScore = 100
    return (await runners.save(runner)).id
  }

  /** What the operator does — the only input a drain-driven migration has. */
  function markDraining(runnerId: string): Promise<Runner> {
    return runnerService.updateDrainingStatus(runnerId, true)
  }

  async function insertParkedBox(runnerId: string, name: string): Promise<Box> {
    const box = new Box(REGION, name)
    box.organizationId = ORGANIZATION_ID
    box.osUser = 'boxlite'
    box.runnerId = runnerId
    box.state = BoxState.STOPPED
    box.desiredState = BoxDesiredState.STOPPED
    box.pending = false
    await boxes.insert(box)
    createdBoxIds.push(box.id)
    return box
  }

  function runMarkerTick(): Promise<void> {
    return (marker as any).markBoxesOnDrainingRunners()
  }

  /**
   * What a runner does with the job it was handed: takes it, then reports it
   * done. Both steps go through the API the runner calls, so the migration is
   * advanced by the same path a real report takes.
   */
  async function runnerReports(boxId: string, type: JobType, resultMetadata?: Record<string, unknown>): Promise<Job> {
    const job = await jobs.findOneByOrFail({ resourceId: boxId, type, status: JobStatus.PENDING })
    await jobService.updateJobStatus(job.id, JobStatus.IN_PROGRESS)
    await jobService.updateJobStatus(
      job.id,
      JobStatus.COMPLETED,
      undefined,
      resultMetadata && JSON.stringify(resultMetadata),
    )
    await Promise.all(applying.splice(0))
    return job
  }

  function arcPathOf(job: Job): string | undefined {
    return job.getPayload<{ arcPath?: string }>()?.arcPath
  }

  it('moves a parked box off the runner being drained and leaves nothing of it behind', async () => {
    const parked = await insertParkedBox(drainingRunnerId, 'parked')
    // Neither of these is parked, and each fails only one half of it: a box
    // whose stop the runner has not confirmed, and one the user has just asked
    // back. Both are ordinary sights on a runner being drained.
    const stopping = await insertParkedBox(drainingRunnerId, 'stop-not-confirmed')
    await boxes.update(stopping.id, { state: BoxState.STARTED })
    const starting = await insertParkedBox(drainingRunnerId, 'start-requested')
    await boxes.update(starting.id, { desiredState: BoxDesiredState.STARTED })
    // Parked, but on a runner nobody is draining: being idle is not a reason to
    // move a box, being on a runner that is going away is.
    const elsewhere = await insertParkedBox(healthyRunnerId, 'parked-on-a-healthy-runner')

    await runMarkerTick()

    // Only the parked box is the migration's to move: the others are in use,
    // and a drain waits for them rather than taking them.
    expect((await migrations.find()).map((migration) => [migration.boxId, migration.state])).toEqual([
      [parked.id, BoxMigrationState.PENDING_EXPORT],
    ])

    await manager.submitMigrationJobs()

    const exportJob = await jobs.findOneByOrFail({ resourceId: parked.id, type: JobType.EXPORT_BOX })
    // The archive can only be made where the box is, so the export goes to the
    // runner being drained.
    expect(exportJob.runnerId).toBe(drainingRunnerId)
    expect(arcPathOf(exportJob)).toBe(`${ARCHIVE_PREFIX}${parked.id}.boxlite`)
    // And the box has not moved: while the migration is in flight the draining
    // runner still owns it, which is what stops the decommission check from
    // retiring the runner out from under the job it is running.
    expect((await boxes.findOneByOrFail({ id: parked.id })).runnerId).toBe(drainingRunnerId)

    await runnerReports(parked.id, JobType.EXPORT_BOX, { arcPath: arcPathOf(exportJob) })

    const exported = await migrations.findOneByOrFail({ boxId: parked.id })
    expect([exported.state, exported.arcPath]).toEqual([
      BoxMigrationState.PENDING_IMPORT,
      `${ARCHIVE_PREFIX}${parked.id}.boxlite`,
    ])

    await manager.submitMigrationJobs()

    const importJob = await jobs.findOneByOrFail({ resourceId: parked.id, type: JobType.IMPORT_BOX })
    // Not the runner being drained, and not the other runner on its way out
    // either — moving the box there would only have to be migrated again.
    expect(importJob.runnerId).toBe(healthyRunnerId)
    expect(arcPathOf(importJob)).toBe(arcPathOf(exportJob))
    expect((await boxes.findOneByOrFail({ id: parked.id })).runnerId).toBe(drainingRunnerId)

    await runnerReports(parked.id, JobType.IMPORT_BOX)

    // The commit point: ownership moves only once the copy exists elsewhere.
    expect((await boxes.findOneByOrFail({ id: parked.id })).runnerId).toBe(healthyRunnerId)
    const imported = await migrations.findOneByOrFail({ boxId: parked.id })
    expect([imported.state, imported.runnerId]).toEqual([
      BoxMigrationState.PENDING_DISCARD_EXPORTED,
      // The copy still on the drained runner, which is what gets discarded.
      drainingRunnerId,
    ])

    await manager.submitRollbackJobs()

    const discardJob = await jobs.findOneByOrFail({ resourceId: parked.id, type: JobType.DISCARD_EXPORTED_BOX })
    expect(discardJob.runnerId).toBe(drainingRunnerId)

    await runnerReports(parked.id, JobType.DISCARD_EXPORTED_BOX)

    const completed = await migrations.findOneByOrFail({ boxId: parked.id })
    expect([completed.state, completed.arcPath, completed.runnerId]).toEqual([BoxMigrationState.COMPLETED, '', null])
    // What the decommission check counts: the two boxes still in use are all
    // the drained runner has left to wait for.
    expect((await boxes.findBy({ runnerId: drainingRunnerId })).map((box) => box.id).sort()).toEqual(
      [stopping.id, starting.id].sort(),
    )
    expect((await boxes.findOneByOrFail({ id: elsewhere.id })).runnerId).toBe(healthyRunnerId)
  })

  it('waits for a runner worth moving to rather than importing onto another draining one', async () => {
    const parked = await insertParkedBox(drainingRunnerId, 'parked')
    await markDraining(healthyRunnerId)

    await runMarkerTick()
    await manager.submitMigrationJobs()
    const exportJob = await jobs.findOneByOrFail({ resourceId: parked.id, type: JobType.EXPORT_BOX })
    await runnerReports(parked.id, JobType.EXPORT_BOX, { arcPath: arcPathOf(exportJob) })

    await manager.submitMigrationJobs()

    // Every runner that could take it is on its way out too, so the box stays
    // where it is and the migration keeps the state it retries from.
    expect(await jobs.findBy({ resourceId: parked.id, type: JobType.IMPORT_BOX })).toHaveLength(0)
    expect((await migrations.findOneByOrFail({ boxId: parked.id })).state).toBe(BoxMigrationState.PENDING_IMPORT)
    expect((await boxes.findOneByOrFail({ id: parked.id })).runnerId).toBe(drainingRunnerId)
    // A held lock here would be read as "the import is already running" and
    // park the migration until the lock's TTL ran out.
    expect(await redis.exists(getMigrateJobLockKey(parked.id, JobType.IMPORT_BOX))).toBe(0)

    await runnerService.updateDrainingStatus(healthyRunnerId, false)
    await manager.submitMigrationJobs()

    // The wait was a wait: the first runner that stops draining takes the box.
    const importJob = await jobs.findOneByOrFail({ resourceId: parked.id, type: JobType.IMPORT_BOX })
    expect(importJob.runnerId).toBe(healthyRunnerId)
  })

  it('gives the box back when it is started while the drain is exporting it', async () => {
    const parked = await insertParkedBox(drainingRunnerId, 'started-mid-export')

    await runMarkerTick()
    await manager.submitMigrationJobs()
    const exportJob = await jobs.findOneByOrFail({ resourceId: parked.id, type: JobType.EXPORT_BOX })

    // The user starts the box while the runner is packing it, which moves
    // box.updatedAt past the copy the migration was opened on.
    await boxRepository.update(parked.id, { updateData: { desiredState: BoxDesiredState.STARTED } }, true)
    await runnerReports(parked.id, JobType.EXPORT_BOX, { arcPath: arcPathOf(exportJob) })

    const turnedAround = await migrations.findOneByOrFail({ boxId: parked.id })
    expect(turnedAround.state).toBe(BoxMigrationState.PENDING_ROLLBACK)
    // The archive exists whether or not the migration stayed valid, so the key
    // has to be recorded or the object is stranded on the object store.
    expect(turnedAround.arcPath).toBe(arcPathOf(exportJob))

    await manager.submitRollbackJobs()

    const reclaimJob = await jobs.findOneByOrFail({ resourceId: parked.id, type: JobType.ROLLBACK_EXPORT_BOX })
    expect(reclaimJob.runnerId).toBe(drainingRunnerId)
    expect(await jobs.findBy({ resourceId: parked.id, type: JobType.IMPORT_BOX })).toHaveLength(0)

    await runnerReports(parked.id, JobType.ROLLBACK_EXPORT_BOX)
    expect((await migrations.findOneByOrFail({ boxId: parked.id })).arcPath).toBe('')

    await manager.submitRollbackJobs()

    // Nothing of the migration is left, and the box is exactly where the user
    // started it — a drain never takes a box out from under its owner.
    expect(await migrations.findBy({ boxId: parked.id })).toHaveLength(0)
    const returned = await boxes.findOneByOrFail({ id: parked.id })
    expect([returned.runnerId, returned.desiredState]).toEqual([drainingRunnerId, BoxDesiredState.STARTED])
  })

  it('keeps the box where the user is using it when it is started while the copy is restored', async () => {
    const parked = await insertParkedBox(drainingRunnerId, 'started-mid-import')

    await runMarkerTick()
    await manager.submitMigrationJobs()
    const exportJob = await jobs.findOneByOrFail({ resourceId: parked.id, type: JobType.EXPORT_BOX })
    await runnerReports(parked.id, JobType.EXPORT_BOX, { arcPath: arcPathOf(exportJob) })
    await manager.submitMigrationJobs()

    // The last moment a start can still reach the box: the copy is being
    // restored on the target, and the box the user is starting is the original.
    await boxRepository.update(parked.id, { updateData: { desiredState: BoxDesiredState.STARTED } }, true)
    await runnerReports(parked.id, JobType.IMPORT_BOX)

    // Ownership does not move. Handing the box over here would point every
    // later request at a copy that was made before the user started it.
    expect((await boxes.findOneByOrFail({ id: parked.id })).runnerId).toBe(drainingRunnerId)
    const turnedAround = await migrations.findOneByOrFail({ boxId: parked.id })
    expect([turnedAround.state, turnedAround.runnerId, turnedAround.arcPath]).toEqual([
      BoxMigrationState.PENDING_ROLLBACK,
      // The copy on the target runner, which is now the thing to reclaim.
      healthyRunnerId,
      arcPathOf(exportJob),
    ])

    await manager.submitRollbackJobs()

    // Both artifacts are outstanding at once, and each is reclaimed on the
    // runner that holds it.
    const reclaims = await jobs.findBy({ resourceId: parked.id, status: JobStatus.PENDING })
    expect(reclaims.map((job) => [job.type, job.runnerId]).sort()).toEqual(
      [
        [JobType.ROLLBACK_EXPORT_BOX, drainingRunnerId],
        [JobType.ROLLBACK_IMPORT_BOX, healthyRunnerId],
      ].sort(),
    )

    await runnerReports(parked.id, JobType.ROLLBACK_EXPORT_BOX)
    await runnerReports(parked.id, JobType.ROLLBACK_IMPORT_BOX)
    await manager.submitRollbackJobs()

    expect(await migrations.findBy({ boxId: parked.id })).toHaveLength(0)
    expect((await boxes.findOneByOrFail({ id: parked.id })).runnerId).toBe(drainingRunnerId)
  })

  it('opens one migration and submits one export however often the loops run', async () => {
    const parked = await insertParkedBox(drainingRunnerId, 'parked')

    await runMarkerTick()
    await runMarkerTick()

    expect(await migrations.findBy({ boxId: parked.id })).toHaveLength(1)

    await manager.submitMigrationJobs()
    await manager.submitMigrationJobs()

    // A second export would have the draining runner pack the same box twice,
    // and the second archive would overwrite the one the import is waiting for.
    expect(await jobs.findBy({ resourceId: parked.id, type: JobType.EXPORT_BOX })).toHaveLength(1)
    // What holds the second tick off: the lock spans the runner's work, so it
    // is still held while the export is in flight.
    expect(await redis.exists(getMigrateJobLockKey(parked.id, JobType.EXPORT_BOX))).toBe(1)
  })
})
