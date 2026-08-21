// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (c) 2026 BoxLite AI

import assert from 'node:assert/strict'
import test from 'node:test'

import { parsePipelineManifest } from './manifest.js'
import { planPipeline, visibleOutputs } from './schedule.js'

const parse = (yaml: string) => parsePipelineManifest(yaml, 'pipeline.yml')
const order = (yaml: string) => planPipeline(parse(yaml)).map((job) => job.id)

test('orders a job after every job it needs', () => {
  // Declared leaf-first on purpose: the plan must come from the edges, not from the file order.
  const plan = order(`
jobs:
  last:
    name: Last
    needs: [middle, first]
    uses: ./m.ts
  middle:
    name: Middle
    needs: [first]
    uses: ./m.ts
  first:
    name: First
    uses: ./m.ts
`)

  assert.deepEqual(plan, ['first', 'middle', 'last'])
})

test('breaks ties by declaration order so the plan is a property of the manifest', () => {
  const yaml = `
jobs:
  beta:
    name: Beta
    uses: ./m.ts
  alpha:
    name: Alpha
    uses: ./m.ts
  gamma:
    name: Gamma
    needs: [alpha]
    uses: ./m.ts
`
  assert.deepEqual(order(yaml), ['beta', 'alpha', 'gamma'])
})

test('names the loop when the edges cannot be ordered', () => {
  assert.throws(
    () => order(`
jobs:
  a:
    name: A
    needs: [c]
    uses: ./m.ts
  b:
    name: B
    needs: [a]
    uses: ./m.ts
  c:
    name: C
    needs: [b]
    uses: ./m.ts
`),
    /needs: forms a cycle — (a → b → c → a|b → c → a → b|c → a → b → c)/,
  )
})

test('a job sees its direct dependencies output and nothing further', () => {
  const manifest = parse(`
jobs:
  root:
    name: Root
    uses: ./m.ts
    outputs:
      fromRoot: a root value
  middle:
    name: Middle
    needs: [root]
    uses: ./m.ts
    outputs:
      fromMiddle: a middle value
  leaf:
    name: Leaf
    needs: [middle]
    uses: ./m.ts
`)
  const byId = new Map(manifest.jobs.map((job) => [job.id, job]))

  assert.deepEqual(visibleOutputs(manifest, byId.get('middle')!), ['fromRoot'])
  // Not fromRoot: reaching a grandparent's value means declaring the edge, as on GitHub.
  assert.deepEqual(visibleOutputs(manifest, byId.get('leaf')!), ['fromMiddle'])
  assert.deepEqual(visibleOutputs(manifest, byId.get('root')!), [])
})
