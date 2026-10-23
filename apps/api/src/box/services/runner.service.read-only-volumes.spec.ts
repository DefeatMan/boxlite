/*
 * Copyright 2026 BoxLite AI
 * SPDX-License-Identifier: AGPL-3.0
 */

import { RunnerService } from './runner.service'

// A runner older than read-only support drops `readOnly` and binds the volume
// read-write, so a box asking for a read-only mount must never land there.
describe('RunnerService read-only volume placement', () => {
  function serviceWith(runners: { id: string; appVersion: string | null }[]) {
    const runnerRepository = {
      find: jest.fn().mockResolvedValue(runners.map((runner) => ({ ...runner, availabilityScore: 50 }))),
    }
    const configService = { getOrThrow: jest.fn().mockReturnValue(1) }
    return new RunnerService(
      runnerRepository as any,
      {} as any,
      {} as any,
      {} as any,
      configService as any,
      {} as any,
      {} as any,
      {} as any,
      {} as any,
    )
  }

  it('offers only runners new enough to bind a volume read-only', async () => {
    const service = serviceWith([
      { id: 'old', appVersion: '0.10.7+abc123' },
      { id: 'unknown', appVersion: null },
      { id: 'dev', appVersion: 'v0.0.0-dev' },
      { id: 'new', appVersion: '0.10.8+def456' },
      { id: 'newer', appVersion: 'v0.11.0' },
    ])

    const runners = await service.findAvailableRunners({ requireReadOnlyVolumes: true })

    expect(runners.map((runner) => runner.id).sort()).toEqual(['new', 'newer'])
  })

  it('keeps every runner when no read-only mount is asked for', async () => {
    const service = serviceWith([
      { id: 'old', appVersion: '0.10.7+abc123' },
      { id: 'new', appVersion: '0.10.8+def456' },
    ])

    const runners = await service.findAvailableRunners({})

    expect(runners.map((runner) => runner.id).sort()).toEqual(['new', 'old'])
  })

  it('says why when no runner can bind read-only', async () => {
    const service = serviceWith([{ id: 'old', appVersion: '0.10.7+abc123' }])

    await expect(service.getRandomAvailableRunner({ requireReadOnlyVolumes: true })).rejects.toThrow(/read-only/)
  })
})
