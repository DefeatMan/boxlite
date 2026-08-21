// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (c) 2026 BoxLite AI

/*
 * Turn the manifest's `needs:` edges into the order modules run in, and into what each one is
 * allowed to see.
 *
 * Sequential, not concurrent: every module registers resources with the same Pulumi engine, and
 * the engine already parallelizes the actual provisioning from the dependency graph it infers
 * between resources. Running the declaration phase concurrently would interleave registrations
 * for no gain and make a failure's blast radius depend on scheduling.
 *
 * Ties are broken by declaration order in pipeline.yml, so the plan is a property of the manifest
 * rather than of Map iteration — a reordered plan should mean someone edited the graph.
 */

import type { PipelineJob, PipelineManifest } from './manifest.js'

/** Topological order over `needs:`, deterministic for a given manifest. */
export function planPipeline(manifest: PipelineManifest): readonly PipelineJob[] {
  const pending = new Map(manifest.jobs.map((job) => [job.id, job]))
  const satisfied = new Set<string>()
  const plan: PipelineJob[] = []

  while (pending.size > 0) {
    // Declaration order, so the first ready job in the file is the next job in the plan.
    const ready = [...pending.values()].filter((job) => job.needs.every((id) => satisfied.has(id)))
    if (ready.length === 0) throw new Error(`${manifest.source}: ${describeCycle(pending)}`)
    for (const job of ready) {
      plan.push(job)
      satisfied.add(job.id)
      pending.delete(job.id)
    }
  }

  return plan
}

/*
 * Name the actual loop. Everything still pending is either in a cycle or downstream of one, so
 * walking edges from any of them reaches a repeat; the slice from that repeat is the cycle.
 */
function describeCycle(pending: ReadonlyMap<string, PipelineJob>): string {
  const path: string[] = []
  let current = pending.keys().next().value as string

  while (!path.includes(current)) {
    path.push(current)
    const next = pending.get(current)?.needs.find((id) => pending.has(id))
    if (!next) return `jobs ${[...pending.keys()].join(', ')} cannot be ordered`
    current = next
  }

  // Edges point at prerequisites, so the walked path runs backwards; reverse it to read as flow.
  const cycle = [...path.slice(path.indexOf(current)), current].reverse()
  return `needs: forms a cycle — ${cycle.join(' → ')}`
}

/*
 * The outputs a job may read: those of the jobs in its own `needs:`, and no others.
 *
 * Direct-only, matching GitHub — `needs.<job>.outputs` reaches a direct dependency and nothing
 * beyond it. A transitive rule would let a module read a value across an edge nobody declared,
 * which is the property the manifest exists to remove.
 */
export function visibleOutputs(manifest: PipelineManifest, job: PipelineJob): readonly string[] {
  const byId = new Map(manifest.jobs.map((entry) => [entry.id, entry]))
  return job.needs.flatMap((id) => byId.get(id)?.outputs ?? [])
}
