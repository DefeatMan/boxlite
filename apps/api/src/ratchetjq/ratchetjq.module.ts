/*
 * Copyright 2026 BoxLite AI
 * SPDX-License-Identifier: AGPL-3.0
 */

import { Module } from '@nestjs/common'
import { TypeOrmModule } from '@nestjs/typeorm'
import { LogAndCompleteAcceptor } from './acceptors/log-and-complete.acceptor'
import { RatchetJQAcceptFinalizer } from './common/accept-finalizer'
import { RatchetJQAcceptRound } from './common/accept-round'
import { IJobAcceptor } from './common/job-acceptor'
import { RATCHETJQ_JOB_ACCEPTORS, RatchetJQJobAcceptorRegistry } from './common/job-acceptor-registry'
import { ISyncJobExecutor } from './common/job-executor'
import { RATCHETJQ_JOB_EXECUTORS, RatchetJQJobExecutorRegistry } from './common/job-executor-registry'
import { RatchetJQScannerPool } from './common/scanner-pool'
import { Runner } from '../box/entities/runner.entity'
import { RatchetJQTransferController } from './controllers/ratchetjq-transfer.controller'
import { RatchetJQJob } from './entities/ratchetjq-job.entity'
import { RatchetJQRunnerExecutor } from './executors/ratchetjq-runner.executor'
import { RatchetJQJobWriter } from './services/ratchetjq-job-writer.service'
import { RatchetJQProposerService } from './services/ratchetjq-proposer.service'
import { RatchetJQReportService } from './services/ratchetjq-report.service'
import { RatchetJQScannerService } from './services/ratchetjq-scanner.service'
import { RatchetJQTransferService } from './services/ratchetjq-transfer.service'

/**
 * Every job acceptor this process can run, the counterpart of the runner's
 * `jobs.JobTypes()` (`apps/runner/pkg/ratchetjq/jobs/registry.go:JobTypes`).
 *
 * Built by the injector rather than listed as values, because an acceptor
 * generally has to read something to decide whether an outcome stands — so
 * adding one is a provider, a constructor parameter here, and an entry in
 * `inject`. The registry keys the list by each acceptor's own `type` and refuses
 * a duplicate at startup.
 */
const JOB_ACCEPTORS = {
  provide: RATCHETJQ_JOB_ACCEPTORS,
  useFactory: (logAndComplete: LogAndCompleteAcceptor): IJobAcceptor[] => [logAndComplete],
  inject: [LogAndCompleteAcceptor],
}

/**
 * Every executor kind this process can push a job to, the run segment's
 * counterpart of the acceptor list above.
 *
 * Two lists rather than one because they are keyed differently and used at
 * opposite ends of a job: an acceptor is found by job type once an outcome comes
 * back, an executor by executor kind on the way out. Adding a kind is a class, a
 * constructor parameter here, and an entry in `inject`.
 */
const JOB_EXECUTORS = {
  provide: RATCHETJQ_JOB_EXECUTORS,
  useFactory: (runner: RatchetJQRunnerExecutor): ISyncJobExecutor[] => [runner],
  inject: [RatchetJQRunnerExecutor],
}

/**
 * RatchetJQ — the redesigned job service, running beside the legacy one rather
 * than replacing it. Nothing in the existing job path is wired to this module.
 *
 * TRANSFER is here — executors claim jobs, producers hint that work arrived — and
 * so is the Scanner, which force-advances what no executor is pulling, retries
 * the accepts nobody settled, and retires the jobs whose rounds are used up.
 * PROPOSER submits: `Exec` writes the job row and hints its executor, and its
 * synchronous form runs the job on that executor now and answers with what it
 * reported. Report takes the outcome back: it moves the row into `accepting` and
 * runs the accept segment's first round, inline for an executor waiting on the
 * verdict and detached for one that is not.
 *
 * The whole lifecycle is therefore wired, submission through to every terminal
 * stage: accepted, rejected behind a rollback job, or timed out behind one.
 */
@Module({
  // `Runner` is registered, not imported from the box module that owns it, which
  // is what `usage` and `region` do with the same entity. A module import would
  // point this module at box, and box is about to be one of the things that
  // submits jobs here.
  imports: [TypeOrmModule.forFeature([RatchetJQJob, Runner])],
  controllers: [RatchetJQTransferController],
  providers: [
    RatchetJQTransferService,
    RatchetJQJobWriter,
    RatchetJQProposerService,
    RatchetJQReportService,
    RatchetJQRunnerExecutor,
    RatchetJQScannerPool,
    RatchetJQScannerService,
    RatchetJQJobAcceptorRegistry,
    RatchetJQJobExecutorRegistry,
    RatchetJQAcceptFinalizer,
    RatchetJQAcceptRound,
    LogAndCompleteAcceptor,
    JOB_ACCEPTORS,
    JOB_EXECUTORS,
  ],
  exports: [RatchetJQTransferService, RatchetJQProposerService, RatchetJQReportService, RatchetJQScannerService],
})
export class RatchetJQModule {}
