/*
 * Copyright 2026 BoxLite AI
 * SPDX-License-Identifier: AGPL-3.0
 */

import { Test } from '@nestjs/testing'
import { readFileSync } from 'fs'
import { join } from 'path'
import { IJobAcceptor } from './common/job-acceptor'
import { RATCHETJQ_JOB_ACCEPTORS } from './common/job-acceptor-registry'
import { RatchetJQModule } from './ratchetjq.module'

/**
 * The checked-in list both halves of a job type are checked against
 * (`apps/libs/ratchetjq-contract/README.md`).
 *
 * Read rather than imported, so no `resolveJsonModule` setting stands between the
 * test and the file, and read from `__dirname` rather than the working directory,
 * which jest does not promise.
 */
const CONTRACT_PATH = join(__dirname, '../../../libs/ratchetjq-contract/job-types.json')

// The same stub the module spec uses: the DataSource shape @nestjs/typeorm's
// repository factory reads while wiring up, with useMocker filling in the rest.
const externalStub = () => ({
  entityMetadatas: [],
  options: { type: 'postgres' },
  getRepository: () => ({}),
})

/**
 * The declared job type names.
 *
 * A missing or empty file fails the test rather than passing it: a contract test
 * that finds nothing to compare against and reports success is worse than no
 * test.
 */
function declaredJobTypes(): string[] {
  const contract = JSON.parse(readFileSync(CONTRACT_PATH, 'utf8')) as { jobTypes?: string[] }
  if (!contract.jobTypes?.length) {
    throw new Error(`The job type contract at ${CONTRACT_PATH} declares no job types`)
  }

  return contract.jobTypes
}

/**
 * The acceptor list as the module actually built it.
 *
 * Read off the injection token rather than assembled from the acceptor classes,
 * which is the whole point: a test that listed the classes itself would keep
 * passing while `ratchetjq.module.ts` diverged from it, and that list is the thing
 * under test.
 */
async function registeredJobTypes(): Promise<string[]> {
  const moduleRef = await Test.createTestingModule({ imports: [RatchetJQModule] })
    .useMocker(externalStub)
    .compile()

  return moduleRef.get<IJobAcceptor[]>(RATCHETJQ_JOB_ACCEPTORS).map((acceptor) => acceptor.type)
}

/**
 * The control plane half of the cross-language check; the runner's half is
 * `jobs/contract_test.go`.
 *
 * A job type is registered twice in two languages — a prototype on the runner, an
 * acceptor here — keyed by the same string, and nothing at build time compares the
 * two. A name present on one side only is not a runtime error either: the job is
 * left to its lease, burns every round it has, and is retired as `timeout` behind
 * a rollback job. So each side checks itself against one checked-in list, and
 * drift fails CI on whichever side drifted.
 */
describe('RatchetJQ job type contract', () => {
  // Both directions, because they are different mistakes: an acceptor for a type
  // no runner runs is dead code, and a declared type with no acceptor is a job
  // that reaches `accepting` and can never leave it.
  it('registers an acceptor for exactly the declared job types', async () => {
    expect((await registeredJobTypes()).sort()).toEqual(declaredJobTypes().sort())
  })
})
