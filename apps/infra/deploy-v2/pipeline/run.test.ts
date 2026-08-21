// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (c) 2026 BoxLite AI

import assert from 'node:assert/strict'
import test from 'node:test'

import { parsePipelineManifest } from './manifest.js'
import type { ModuleRegistry, StackModule } from './module.js'
import { assertRegistryMatchesManifest, runPipeline } from './run.js'

interface Context {
  base: string
  derived: string
}

const parse = (yaml: string) => parsePipelineManifest(yaml, 'pipeline.yml')

const registryOf = (...modules: StackModule<Context, unknown>[]): ModuleRegistry<Context> =>
  new Map<string, StackModule<Context, unknown>>(modules.map((module) => [module.id, module]))

const noSleep = async () => {}

const TWO_JOBS = `
jobs:
  producer:
    name: Producer
    uses: ./modules/producer.ts
    with:
      retry-attempts: 3
      retry-delay-seconds: 0
    outputs:
      base: a value the consumer reads
  consumer:
    name: Consumer
    needs: [producer]
    uses: ./modules/consumer.ts
    outputs:
      derived: a value built from base
`

test('runs jobs in dependency order and threads declared outputs between them', async () => {
  const ran: string[] = []

  const context = await runPipeline(
    parse(TWO_JOBS),
    registryOf(
      {
        id: 'consumer',
        declare({ base }) {
          ran.push('consumer')
          return { derived: `${base} + consumer` }
        },
      },
      {
        id: 'producer',
        declare() {
          ran.push('producer')
          return { base: 'producer' }
        },
      },
    ),
    { sleep: noSleep },
  )

  // Registered in reverse; the manifest, not the registry, decides the order.
  assert.deepEqual(ran, ['producer', 'consumer'])
  assert.deepEqual(context, { base: 'producer', derived: 'producer + consumer' })
})

test('retries a failing resolve phase, then declares exactly once', async () => {
  let resolves = 0
  let declares = 0
  const retries: number[] = []

  await runPipeline(
    parse(TWO_JOBS),
    registryOf(
      {
        id: 'producer',
        resolve() {
          resolves += 1
          if (resolves < 3) throw new Error(`cold lookup ${resolves}`)
          return 'resolved'
        },
        declare(_context, resolved) {
          declares += 1
          return { base: String(resolved) }
        },
      },
      { id: 'consumer', declare: ({ base }) => ({ derived: base }) },
    ),
    { sleep: noSleep, onEvent: (event) => event.type === 'retry' && retries.push(event.attempt.nextAttempt) },
  )

  assert.equal(resolves, 3)
  assert.equal(declares, 1)
  assert.deepEqual(retries, [2, 3])
})

test('never repeats a declare phase, because its resources are already registered', async () => {
  let declares = 0

  await assert.rejects(
    runPipeline(
      parse(TWO_JOBS),
      registryOf(
        {
          id: 'producer',
          declare() {
            declares += 1
            throw new Error('duplicate URN waiting to happen')
          },
        },
        { id: 'consumer', declare: ({ base }) => ({ derived: base }) },
      ),
      { sleep: noSleep },
    ),
    /job 'producer' failed to declare: duplicate URN waiting to happen/,
  )
  // The job's policy allows three attempts; the declare phase is outside it.
  assert.equal(declares, 1)
})

test('names the job and phase a failure came from', async () => {
  await assert.rejects(
    runPipeline(
      parse(TWO_JOBS),
      registryOf(
        {
          id: 'producer',
          resolve() {
            throw new Error('sts unreachable')
          },
          declare: () => ({ base: 'unused' }),
        },
        { id: 'consumer', declare: ({ base }) => ({ derived: base }) },
      ),
      { sleep: noSleep },
    ),
    (error: Error) => {
      assert.match(error.message, /job 'producer' failed to resolve: sts unreachable/)
      assert.match((error.cause as Error).message, /sts unreachable/)
      return true
    },
  )
})

test('stops a module reading across an edge the manifest does not declare', async () => {
  const withoutEdge = parse(`
jobs:
  producer:
    name: Producer
    uses: ./modules/producer.ts
    outputs:
      base: a value the consumer must not reach for
  consumer:
    name: Consumer
    uses: ./modules/consumer.ts
    outputs:
      derived: a value built from base
`)

  await assert.rejects(
    runPipeline(
      withoutEdge,
      registryOf(
        { id: 'producer', declare: () => ({ base: 'producer' }) },
        { id: 'consumer', declare: ({ base }) => ({ derived: base }) },
      ),
      { sleep: noSleep },
    ),
    /module 'consumer' read 'base', which jobs\.producer produces — add producer to jobs\.consumer\.needs/,
  )
})

test('rejects a module that returns an output the manifest does not declare', async () => {
  await assert.rejects(
    runPipeline(
      parse(TWO_JOBS),
      registryOf(
        { id: 'producer', declare: () => ({ base: 'producer', derived: 'smuggled' }) },
        { id: 'consumer', declare: ({ base }) => ({ derived: base }) },
      ),
      { sleep: noSleep },
    ),
    /module 'producer' returned derived, which jobs\.producer\.outputs does not declare/,
  )
})

test('rejects a module that skips an output the manifest promises', async () => {
  await assert.rejects(
    runPipeline(
      parse(TWO_JOBS),
      registryOf(
        { id: 'producer', declare: () => ({}) },
        { id: 'consumer', declare: ({ base }) => ({ derived: base }) },
      ),
      { sleep: noSleep },
    ),
    /module 'producer' returned no base — jobs\.producer\.outputs in the manifest says it produces it/,
  )
})

test('pairs every job with a module before anything is declared', async () => {
  const manifest = parse(TWO_JOBS)
  const consumer: StackModule<Context, unknown> = { id: 'consumer', declare: ({ base }) => ({ derived: base }) }

  assert.throws(
    () => assertRegistryMatchesManifest(manifest, registryOf(consumer)),
    /no module registered for job\(s\) producer/,
  )
  assert.throws(
    () =>
      assertRegistryMatchesManifest(
        manifest,
        registryOf(consumer, { id: 'producer', declare: () => ({ base: 'p' }) }, {
          id: 'stray',
          declare: () => ({}),
        }),
      ),
    /module\(s\) stray are registered but declare no job/,
  )
  assert.throws(
    () =>
      assertRegistryMatchesManifest(
        manifest,
        new Map<string, StackModule<Context, unknown>>([
          ['producer', { id: 'mislabelled', declare: () => ({ base: 'p' }) }],
          ['consumer', consumer],
        ]),
      ),
    /module registered as producer reports its id as mislabelled/,
  )

  // A registry gap is caught before the first module runs, not halfway through.
  let declared = false
  await assert.rejects(
    runPipeline(
      manifest,
      registryOf({
        id: 'producer',
        declare() {
          declared = true
          return { base: 'producer' }
        },
      }),
      { sleep: noSleep },
    ),
    /no module registered for job\(s\) consumer/,
  )
  assert.equal(declared, false)
})
