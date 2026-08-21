// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (c) 2026 BoxLite AI

/*
 * The one guard that loads the real registry instead of reading it as text.
 *
 * It works because no module touches an SST ambient global at module scope — every reference to
 * `sst`, `$app`, `$util` or `aws` sits inside a declare or resolve body, which nothing here calls.
 * Importing the registry therefore needs no `sst install`, while still proving that the twelve
 * modules and the twelve jobs in pipeline.yml are the same twelve, paired by id.
 *
 * Text assertions over these files live in contract.test.ts, which is what tsconfig.tooling.json
 * can type-check; this file is covered by the full `npm run typecheck` after `sst install`.
 */

import assert from 'node:assert/strict'
import test from 'node:test'

import { MODULE_REGISTRY, loadStackManifest } from './index.js'
import { assertRegistryMatchesManifest } from './pipeline/run.js'
import { planPipeline } from './pipeline/schedule.js'

const manifest = loadStackManifest()

test('the shipped manifest and the shipped registry describe the same pipeline', () => {
  assert.doesNotThrow(() => assertRegistryMatchesManifest(manifest, MODULE_REGISTRY))
  assert.equal(MODULE_REGISTRY.size, manifest.jobs.length)
})

test('the plan order satisfies every edge in the shipped graph', () => {
  const plan = planPipeline(manifest)
  const position = new Map(plan.map((job, index) => [job.id, index]))

  for (const job of manifest.jobs) {
    for (const need of job.needs) {
      assert.ok(
        position.get(need)! < position.get(job.id)!,
        `${job.id} is planned at ${position.get(job.id)}, before its dependency ${need} at ${position.get(need)}`,
      )
    }
    assert.equal(typeof MODULE_REGISTRY.get(job.id)!.declare, 'function', `${job.id} must implement declare`)
  }
})
