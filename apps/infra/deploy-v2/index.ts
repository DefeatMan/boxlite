// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (c) 2026 BoxLite AI

/// <reference path="../.sst/platform/config.d.ts" />

/*
 * The deploy-v2 entry point: pair every job in pipeline.yml with the module that implements it,
 * then run the graph.
 *
 * Additive. stack/deploy.ts and the sst.config.ts that calls it are untouched and still the
 * deploy path in use; adopting this one is a single line in sst.config.ts, spelled out in
 * deploy-v2/README.md.
 *
 * The modules are imported eagerly and their builders are not: each module holds a
 * `() => import(...)` thunk that its resolve phase runs, so loading this file costs twelve small
 * files rather than the whole stack.
 */

import { loadPipelineManifest, type PipelineManifest } from './pipeline/manifest.js'
import type { ModuleRegistry, StackModule } from './pipeline/module.js'
import { runPipeline, type PipelineEvent, type PipelineRunOptions } from './pipeline/run.js'
import type { StackContext } from './stack-context.js'

import { api } from './modules/api.js'
import { boundary } from './modules/boundary.js'
import { clickhouse } from './modules/clickhouse.js'
import { clickhouseReady } from './modules/clickhouse-ready.js'
import { config } from './modules/config.js'
import { edge } from './modules/edge.js'
import { foundation } from './modules/foundation.js'
import { observability } from './modules/observability.js'
import { router } from './modules/router.js'
import { runners } from './modules/runners.js'
import { s3Access } from './modules/s3-access.js'
import { secrets } from './modules/secrets.js'

const MODULES: readonly StackModule<StackContext, unknown>[] = [
  config,
  boundary,
  s3Access,
  secrets,
  foundation,
  router,
  clickhouse,
  observability,
  clickhouseReady,
  api,
  edge,
  runners,
]

export const MODULE_REGISTRY: ModuleRegistry<StackContext> = new Map<string, StackModule<StackContext, unknown>>(
  MODULES.map((module) => [module.id, module]),
)

export const MANIFEST_LOCATION = new URL('./pipeline.yml', import.meta.url)

export function loadStackManifest(): PipelineManifest {
  return loadPipelineManifest(MANIFEST_LOCATION)
}

/*
 * One line per job, plus a line per retry. Written to stdout rather than kept silent because a
 * deploy that pauses for twenty seconds should say which job is waiting and why — SST's own
 * output shows resources, and a resolve phase registers none.
 */
function reportProgress(event: PipelineEvent): void {
  if (event.type === 'start') {
    console.log(`deploy-v2: [${event.position}/${event.total}] ${event.job.id} — ${event.job.name}`)
    return
  }
  if (event.type === 'retry') {
    const { error, nextAttempt, attempts, delayMs } = event.attempt
    const reason = error instanceof Error ? error.message : String(error)
    console.warn(
      `deploy-v2: ${event.job.id} could not resolve (${reason}); ` +
        `retrying ${nextAttempt}/${attempts} in ${delayMs / 1_000}s`,
    )
  }
}

export async function deployStackV2(options: PipelineRunOptions = {}): Promise<void> {
  await runPipeline(loadStackManifest(), MODULE_REGISTRY, { onEvent: reportProgress, ...options })
}
