// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (c) 2026 BoxLite AI

/*
 * Guards over the shipped manifest and the modules it names.
 *
 * Read as text rather than imported, for the reason stack/contract.test.ts gives: the modules
 * reference the SST ambient globals, which only exist once `sst install` has written
 * .sst/platform/config.d.ts. These assertions have to hold everywhere `npm test` runs.
 */

import assert from 'node:assert/strict'
import { existsSync, readFileSync } from 'node:fs'
import test from 'node:test'
import { load as loadYaml } from 'js-yaml'

import { liveText } from '../shared/live-source.js'
import { loadPipelineManifest } from './pipeline/manifest.js'
import { planPipeline } from './pipeline/schedule.js'

const MANIFEST_URL = new URL('./pipeline.yml', import.meta.url)
const manifest = loadPipelineManifest(MANIFEST_URL)
const rawJobs = (loadYaml(readFileSync(MANIFEST_URL, 'utf8')) as { jobs: Record<string, Record<string, unknown>> }).jobs

const moduleSource = (uses: string) => liveText('script', readFileSync(new URL(uses, MANIFEST_URL), 'utf8'))
const liveModules = manifest.jobs.map((job) => moduleSource(job.uses)).join('\n')

/*
 * `uses:` is the only field nothing else can check. The registry is built from index.ts's own
 * imports, so registry.test.ts pairs jobs to modules by id without ever reading this path — which
 * means a `uses:` pointing at the wrong file, or at no file, would otherwise go unnoticed.
 */
test('every job names a module file that exists and reports the job id', () => {
  for (const job of manifest.jobs) {
    assert.ok(existsSync(new URL(job.uses, MANIFEST_URL)), `jobs.${job.id}.uses names ${job.uses}, which does not exist`)
    assert.match(
      moduleSource(job.uses),
      new RegExp(`id:\\s*'${job.id}'`),
      `${job.uses} must report id '${job.id}', or pipeline/run.ts will refuse the registry`,
    )
  }
})

test('the shipped graph is orderable and starts where the configuration is resolved', () => {
  const plan = planPipeline(manifest).map((job) => job.id)

  assert.equal(plan[0], 'config', 'every other job reads the stage configuration')
  assert.equal(plan.length, manifest.jobs.length)
  // Nothing consumes these two, so a job ordered after them would be a mistake in the graph.
  assert.ok(plan.indexOf('api') < plan.indexOf('edge'))
  assert.ok(plan.indexOf('api') < plan.indexOf('runners'))
  // The transform has to be registered before the components that create roles internally.
  assert.ok(plan.indexOf('boundary') < plan.indexOf('foundation'))
})

/*
 * The honesty check on retry. A `with:` block promises the runner will repeat something; the only
 * thing it can repeat is a module's resolve phase. A job that declares a policy without one would
 * advertise a guarantee nothing implements, and a module that grows an async phase without a
 * policy would silently take the default instead of a considered one.
 */
test('a retry policy is declared exactly where there is a resolve phase to retry', () => {
  for (const job of manifest.jobs) {
    const declaresPolicy = Object.hasOwn(rawJobs[job.id], 'with')
    const hasResolvePhase = /^\s*resolve[:(]/m.test(moduleSource(job.uses))

    assert.equal(
      declaresPolicy,
      hasResolvePhase,
      declaresPolicy
        ? `jobs.${job.id} declares a retry policy but ${job.uses} has no resolve phase to retry`
        : `${job.uses} has a resolve phase, so jobs.${job.id} must declare its retry policy`,
    )
  }
})

test('the manifest declares every value modules pass between each other', () => {
  const live = liveText('script', readFileSync(new URL('./stack-context.ts', import.meta.url), 'utf8'))
  const body = live.slice(live.indexOf('export interface StackContext'))
  const contextKeys = [...body.matchAll(/^ {2}(\w+)\??:/gm)].map(([, key]) => key)

  assert.ok(contextKeys.length > 20, 'the context keys were not extracted; the interface shape must have changed')

  const declared = new Set(manifest.jobs.flatMap((job) => job.outputs))
  const undeclared = contextKeys.filter((key) => !declared.has(key))
  assert.deepEqual(undeclared, [], 'every StackContext key must be some job’s declared output')

  const unused = [...declared].filter((key) => !contextKeys.includes(key))
  assert.deepEqual(unused, [], 'every declared output must be a StackContext key')
})

/*
 * Drift guard against the entry point this one was split out of. deploy-v2 delegates to the same
 * stack/ builders rather than reimplementing them, so a builder added to stack/deploy.ts and not
 * here means the two entry points deploy different stacks.
 */
test('covers every builder stack/deploy.ts calls', () => {
  const liveDeploy = liveText('scriptEmittingShell', readFileSync(new URL('../stack/deploy.ts', import.meta.url), 'utf8'))
  const builders = [...new Set([...liveDeploy.matchAll(/\b((?:build|create)[A-Z]\w*)\(/g)].map(([, name]) => name))]

  assert.ok(builders.length >= 7, `expected stack/deploy.ts to call several builders, found ${builders.join(', ')}`)
  for (const builder of builders) {
    assert.match(liveModules, new RegExp(`\\b${builder}\\b`), `no deploy-v2 module calls ${builder}`)
  }
})
