/*
 * Copyright 2026 BoxLite AI
 * SPDX-License-Identifier: AGPL-3.0
 */

import { Module } from '@nestjs/common'
import { TypeOrmModule } from '@nestjs/typeorm'
import { RatchetJQTransferController } from './controllers/ratchetjq-transfer.controller'
import { RatchetJQJob } from './entities/ratchetjq-job.entity'
import { RatchetJQTransferService } from './services/ratchetjq-transfer.service'

/**
 * RatchetJQ — the redesigned job service, running beside the legacy one rather
 * than replacing it. Nothing in the existing job path is wired to this module.
 *
 * Only the TRANSFER role is here so far: executors can claim jobs and producers
 * can hint that work arrived. The PROPOSER half — submitting jobs, accepting
 * their outcomes and the Scanner's global sweep — is not implemented yet, so a
 * claim only ever finds rows something else inserted.
 */
@Module({
  imports: [TypeOrmModule.forFeature([RatchetJQJob])],
  controllers: [RatchetJQTransferController],
  providers: [RatchetJQTransferService],
  exports: [RatchetJQTransferService],
})
export class RatchetJQModule {}
