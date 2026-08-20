/*
 * Copyright 2026 BoxLite AI
 * SPDX-License-Identifier: AGPL-3.0
 */

import { Module } from '@nestjs/common'
import { TypeOrmModule } from '@nestjs/typeorm'
import { LogAndCompleteAcceptor } from './acceptors/log-and-complete.acceptor'
import { RatchetJQAcceptFinalizer } from './common/accept-finalizer'
import { IJobAcceptor } from './common/job-acceptor'
import { RATCHETJQ_JOB_ACCEPTORS, RatchetJQJobAcceptorRegistry } from './common/job-acceptor-registry'
import { RatchetJQScannerPool } from './common/scanner-pool'
import { RatchetJQTransferController } from './controllers/ratchetjq-transfer.controller'
import { RatchetJQJob } from './entities/ratchetjq-job.entity'
import { RatchetJQTransferService } from './services/ratchetjq-transfer.service'

/**
 * Every job acceptor this process can run, the counterpart of the runner's
 * `jobs.JobTypes()` (`apps/runner/pkg/ratchetjq/jobs/registry.go:22`).
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
 * RatchetJQ — the redesigned job service, running beside the legacy one rather
 * than replacing it. Nothing in the existing job path is wired to this module.
 *
 * TRANSFER is here — executors claim jobs, producers hint that work arrived — and
 * so is the Scanner, which force-advances what no executor is pulling and retries
 * the accepts nobody settled. The PROPOSER half is not: submitting jobs,
 * accepting their outcomes in the first place, and the two sweeps that retire
 * jobs whose rounds are used up all need a job-creation path that does not exist
 * yet. Registering an acceptor therefore changes nothing that runs today: no row
 * reaches `accepting` until Report does.
 */
@Module({
  imports: [TypeOrmModule.forFeature([RatchetJQJob])],
  controllers: [RatchetJQTransferController],
  providers: [
    RatchetJQTransferService,
    RatchetJQScannerPool,
    RatchetJQScannerService,
    RatchetJQJobAcceptorRegistry,
    RatchetJQAcceptFinalizer,
    LogAndCompleteAcceptor,
    JOB_ACCEPTORS,
  ],
  exports: [RatchetJQTransferService, RatchetJQScannerService],
})
export class RatchetJQModule {}
