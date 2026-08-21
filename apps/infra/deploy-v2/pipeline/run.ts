// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (c) 2026 BoxLite AI

/*
 * Run the manifest: for each job in dependency order, retry its async phase, declare its
 * resources once, and check that what it returned is what the manifest said it would.
 *
 * The last part is what keeps pipeline.yml honest. A graph that only orders modules drifts the
 * first time someone returns an extra value and a later module quietly reads it; here the extra
 * value is an error naming the job and the key, at the deploy that introduced it.
 */

import { outputProducers, type PipelineJob, type PipelineManifest } from './manifest.js'
import { scopeContext, type ModuleRegistry } from './module.js'
import { planPipeline, visibleOutputs } from './schedule.js'
import { abortReason, withRetry, type RetryAttemptEvent, type RetryOptions } from './retry.js'

export type PipelineEvent =
  | { readonly type: 'start'; readonly job: PipelineJob; readonly position: number; readonly total: number }
  | { readonly type: 'retry'; readonly job: PipelineJob; readonly attempt: RetryAttemptEvent }
  | { readonly type: 'done'; readonly job: PipelineJob }

export interface PipelineRunOptions {
  signal?: AbortSignal
  onEvent?: (event: PipelineEvent) => void
  /** Injected by tests so a retry policy's backoff costs no wall clock. */
  sleep?: RetryOptions['sleep']
}

/*
 * Every job has a module and every module has a job. Checked before anything is declared: a
 * registry missing an entry would otherwise fail halfway through, after the jobs before it had
 * already registered resources.
 */
export function assertRegistryMatchesManifest<TContext extends object>(
  manifest: PipelineManifest,
  registry: ModuleRegistry<TContext>,
): void {
  const declared = new Set(manifest.jobs.map((job) => job.id))

  const unimplemented = manifest.jobs.filter((job) => !registry.has(job.id)).map((job) => job.id)
  if (unimplemented.length > 0) {
    throw new Error(`${manifest.source}: no module registered for job(s) ${unimplemented.join(', ')}`)
  }

  const unlisted = [...registry.keys()].filter((id) => !declared.has(id))
  if (unlisted.length > 0) {
    throw new Error(`${manifest.source}: module(s) ${unlisted.join(', ')} are registered but declare no job`)
  }

  for (const [id, module] of registry) {
    if (module.id !== id) {
      throw new Error(`${manifest.source}: module registered as ${id} reports its id as ${module.id}`)
    }
  }
}

function assertDeclaredOutputs(job: PipelineJob, patch: Readonly<Record<string, unknown>>): void {
  const returned = Object.keys(patch)
  const missing = job.outputs.filter((key) => !returned.includes(key))
  const unexpected = returned.filter((key) => !job.outputs.includes(key))

  if (missing.length > 0) {
    throw new Error(
      `module '${job.id}' returned no ${missing.join(', ')} — jobs.${job.id}.outputs in the ` +
        'manifest says it produces it',
    )
  }
  if (unexpected.length > 0) {
    throw new Error(
      `module '${job.id}' returned ${unexpected.join(', ')}, which jobs.${job.id}.outputs does ` +
        'not declare — add it there so dependents can name the edge',
    )
  }
}

export async function runPipeline<TContext extends object>(
  manifest: PipelineManifest,
  registry: ModuleRegistry<TContext>,
  options: PipelineRunOptions = {},
): Promise<Partial<TContext>> {
  const { signal, onEvent = () => {}, sleep } = options
  const plan = planPipeline(manifest)
  assertRegistryMatchesManifest(manifest, registry)

  const producerOf = outputProducers(manifest)
  const accumulated: Record<string, unknown> = {}

  for (const [index, job] of plan.entries()) {
    if (signal?.aborted) throw abortReason(signal)
    onEvent({ type: 'start', job, position: index + 1, total: plan.length })

    const module = registry.get(job.id)!
    const context = scopeContext<TContext>(accumulated, visibleOutputs(manifest, job), job.id, producerOf)

    const resolved = module.resolve
      ? await failing(job, 'resolve', () =>
          withRetry(() => module.resolve!(context), job.retry, {
            signal,
            sleep,
            onRetry: (attempt) => onEvent({ type: 'retry', job, attempt }),
          }),
        )
      : undefined

    const patch = await failing(job, 'declare', () => module.declare(context, resolved))
    assertDeclaredOutputs(job, patch as Record<string, unknown>)
    Object.assign(accumulated, patch)

    onEvent({ type: 'done', job })
  }

  return accumulated as Partial<TContext>
}

/*
 * Say which job and which phase failed. Without it a stack trace from inside a shared builder
 * names the builder, and the operator has to work back to which of twelve jobs called it.
 */
async function failing<T>(job: PipelineJob, phase: string, operation: () => Promise<T> | T): Promise<T> {
  try {
    return await operation()
  } catch (error) {
    const reason = error instanceof Error ? error.message : String(error)
    throw new Error(`deploy-v2: job '${job.id}' failed to ${phase}: ${reason}`, { cause: error })
  }
}
