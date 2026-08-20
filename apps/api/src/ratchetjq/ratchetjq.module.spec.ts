/*
 * Copyright 2026 BoxLite AI
 * SPDX-License-Identifier: AGPL-3.0
 */

import { Test } from '@nestjs/testing'
import { ECHO_JOB_TYPE, LogAndCompleteAcceptor } from './acceptors/log-and-complete.acceptor'
import { RATCHETJQ_JOB_ACCEPTORS, RatchetJQJobAcceptorRegistry } from './common/job-acceptor-registry'
import { RatchetJQModule } from './ratchetjq.module'
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
})
