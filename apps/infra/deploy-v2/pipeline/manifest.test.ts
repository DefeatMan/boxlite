// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (c) 2026 BoxLite AI

import assert from 'node:assert/strict'
import test from 'node:test'

import { DEFAULT_RETRY_POLICY } from './retry.js'
import { outputProducers, parsePipelineManifest } from './manifest.js'

const parse = (yaml: string) => parsePipelineManifest(yaml, 'pipeline.yml')

const MINIMAL = `
jobs:
  first:
    name: First
    uses: ./modules/first.ts
    outputs:
      alpha: the alpha value
  second:
    name: Second
    needs: first
    uses: ./modules/second.ts
    with:
      retry-attempts: 5
      retry-delay-seconds: 1.5
      retry-max-delay-seconds: 12
`

test('reads jobs, edges, retry policy and outputs out of workflow syntax', () => {
  const manifest = parse(MINIMAL)

  assert.deepEqual(
    manifest.jobs.map((job) => job.id),
    ['first', 'second'],
  )

  const [first, second] = manifest.jobs
  assert.equal(first.name, 'First')
  assert.equal(first.uses, './modules/first.ts')
  assert.deepEqual(first.needs, [])
  assert.deepEqual(first.outputs, ['alpha'])
  assert.equal(first.outputDescriptions.get('alpha'), 'the alpha value')
  // No `with:` means the documented default, not "no retry".
  assert.deepEqual(first.retry, DEFAULT_RETRY_POLICY)

  // A bare string is the same edge as a one-element sequence, as on GitHub.
  assert.deepEqual(second.needs, ['first'])
  assert.deepEqual(second.outputs, [])
  // Seconds in the manifest, milliseconds in the policy.
  assert.deepEqual(second.retry, { attempts: 5, delayMs: 1_500, maxDelayMs: 12_000 })
})

test('names the producer of every output', () => {
  assert.deepEqual([...outputProducers(parse(MINIMAL))], [['alpha', 'first']])
})

test('rejects an edge to a job that does not exist', () => {
  assert.throws(
    () => parse(`
jobs:
  only:
    name: Only
    uses: ./modules/only.ts
    needs: [absent, missing]
`),
    /jobs\.only\.needs names unknown job\(s\): absent, missing/,
  )
})

test('rejects a job that depends on itself', () => {
  assert.throws(
    () => parse(`
jobs:
  loop:
    name: Loop
    uses: ./modules/loop.ts
    needs: [loop]
`),
    /jobs\.loop\.needs lists its own job/,
  )
})

test('rejects the same output declared by two jobs', () => {
  assert.throws(
    () => parse(`
jobs:
  left:
    name: Left
    uses: ./modules/left.ts
    outputs:
      shared: one description
  right:
    name: Right
    uses: ./modules/right.ts
    outputs:
      shared: another description
`),
    /declares output shared on both jobs\.left and jobs\.right/,
  )
})

test('rejects a key this manifest would silently ignore', () => {
  // `runs-on` is meaningful to GitHub and meaningless here; accepting it would let a reader
  // believe the manifest honours a workflow feature it has never implemented.
  assert.throws(
    () => parse(`
jobs:
  job:
    name: Job
    uses: ./modules/job.ts
    runs-on: ubuntu-24.04
`),
    /jobs\.job has unsupported key\(s\) runs-on/,
  )
  assert.throws(
    () => parse(`
jobs:
  job:
    name: Job
    uses: ./modules/job.ts
    with:
      retry-attemps: 3
`),
    /jobs\.job\.with has unsupported key\(s\) retry-attemps/,
  )
})

test('rejects a job missing the fields the runner needs', () => {
  assert.throws(() => parse('jobs:\n  job:\n    uses: ./modules/job.ts\n'), /jobs\.job\.name must be a non-empty string/)
  assert.throws(() => parse('jobs:\n  job:\n    name: Job\n'), /jobs\.job\.uses must be a non-empty string/)
  assert.throws(() => parse('jobs: {}\n'), /declares no jobs/)
})

test('rejects a retry policy the runner could not honour', () => {
  assert.throws(
    () => parse(`
jobs:
  job:
    name: Job
    uses: ./modules/job.ts
    with:
      retry-attempts: 0
`),
    /jobs\.job\.with: retry attempts must be a positive integer/,
  )
})

test('keeps `on:` a string key rather than a YAML boolean', () => {
  // YAML 1.1 resolves `on` to true, which would make the top-level key unrecognizable. js-yaml v4
  // follows the 1.2 core schema; pin it, because a loader change here breaks every manifest.
  assert.doesNotThrow(() => parse('on:\n  workflow_call:\njobs:\n  job:\n    name: Job\n    uses: ./m.ts\n'))
})
