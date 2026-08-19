/*
 * Copyright 2026 BoxLite AI
 * SPDX-License-Identifier: AGPL-3.0
 */

import { Test } from '@nestjs/testing'
import { ECHO_JOB_TYPE, LogAndCompleteAcceptor } from './acceptors/log-and-complete.acceptor'
import { RATCHETJQ_JOB_ACCEPTORS, RatchetJQJobAcceptorRegistry } from './common/job-acceptor-registry'
import { RATCHETJQ_JOB_EXECUTORS, RatchetJQJobExecutorRegistry } from './common/job-executor-registry'
import { RatchetJQExecutor } from './enums/ratchetjq-executor.enum'
import { RatchetJQRunnerExecutor } from './executors/ratchetjq-runner.executor'
import { RatchetJQModule } from './ratchetjq.module'
import { RatchetJQProposerService } from './services/ratchetjq-proposer.service'
import { RatchetJQReportService } from './services/ratchetjq-report.service'
import { RatchetJQScannerService } from './services/ratchetjq-scanner.service'

// The DataSource shape is what @nestjs/typeorm's repository factory reads while
// wiring up; useMocker fills in every other token the module reaches for, such as
// the ioredis connection. Same stub as UsageModule's own spec.
const externalStub = () => ({
  entityMetadatas: [],
  options: { type: 'postgres' },
  getRepository: () => ({}),
})

describe('RatchetJQModule', () => {
  it('builds the acceptor list through the injector and keys it by job type', async () => {
    const moduleRef = await Test.createTestingModule({ imports: [RatchetJQModule] })
      .useMocker(externalStub)
      .compile()

    expect(moduleRef.get(RATCHETJQ_JOB_ACCEPTORS)).toHaveLength(1)
    expect(moduleRef.get(RatchetJQJobAcceptorRegistry).acceptorFor(ECHO_JOB_TYPE)).toBeInstanceOf(
      LogAndCompleteAcceptor,
    )
  })

  // The Scanner takes the registry as a constructor dependency, so this is what
  // proves the accept segment is reachable in a built module rather than only in
  // a test that hands the Scanner its stubs.
  it('gives the Scanner the registry it dispatches accepts through', async () => {
    const moduleRef = await Test.createTestingModule({ imports: [RatchetJQModule] })
      .useMocker(externalStub)
      .compile()

    expect(moduleRef.get(RatchetJQScannerService)).toBeInstanceOf(RatchetJQScannerService)
  })

  // The run segment's half of the same shape: the executor list is built by the
  // injector and keyed by the kind each implementation reports, so a submission
  // naming `runner` resolves to the class that pushes to one.
  it('builds the executor list through the injector and keys it by executor kind', async () => {
    const moduleRef = await Test.createTestingModule({ imports: [RatchetJQModule] })
      .useMocker(externalStub)
      .compile()

    expect(moduleRef.get(RATCHETJQ_JOB_EXECUTORS)).toHaveLength(1)
    expect(moduleRef.get(RatchetJQJobExecutorRegistry).executorFor(RatchetJQExecutor.RUNNER)).toBeInstanceOf(
      RatchetJQRunnerExecutor,
    )
  })

  // PROPOSER reaches the accept segment (to accept what it pushed) and the accept
  // segment reaches the writer (to queue a rollback). Those two edges only stay
  // acyclic because row creation sits below both, and Nest refuses to build a
  // module with a cycle — so resolving PROPOSER is the assertion.
  it('resolves PROPOSER and Report together, so neither closes a cycle', async () => {
    const moduleRef = await Test.createTestingModule({ imports: [RatchetJQModule] })
      .useMocker(externalStub)
      .compile()

    expect(moduleRef.get(RatchetJQReportService)).toBeInstanceOf(RatchetJQReportService)
    expect(moduleRef.get(RatchetJQProposerService)).toBeInstanceOf(RatchetJQProposerService)
  })

  // PROPOSER's entry point takes TRANSFER as a dependency, since submitting hints
  // the executor it submitted for. This is what proves that pair resolves in a
  // built module rather than only where a test hands it its stubs.
  it('builds the proposer with the transfer it hints through', async () => {
    const moduleRef = await Test.createTestingModule({ imports: [RatchetJQModule] })
      .useMocker(externalStub)
      .compile()

    expect(moduleRef.get(RatchetJQProposerService)).toBeInstanceOf(RatchetJQProposerService)
  })
})
