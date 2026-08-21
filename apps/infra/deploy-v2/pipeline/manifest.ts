// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (c) 2026 BoxLite AI

/*
 * The stack's dependency graph, read from a GitHub Actions workflow document.
 *
 * Order used to be the order of statements in one long function, where an edge existed because a
 * `const` happened to be declared above its reader — invisible, and impossible to assert against.
 * Here every edge is a `needs:` entry a reviewer can read, and `outputs:` names exactly what each
 * module hands the next, so pipeline/run.ts can refuse a module that reaches for a value it never
 * declared a dependency on.
 *
 * Workflow syntax rather than a bespoke schema because the graph this file describes is the same
 * graph .github/workflows/deploy-infra.yml already describes for the build legs, and because the
 * repo already parses workflow YAML this way (deployment/composite-actions.test.ts).
 *
 * It is a manifest, not a workflow: it lives outside .github/workflows/, so GitHub never runs it.
 * Three deliberate departures from the schema GitHub would enforce, kept because dropping them
 * would mean inventing a parallel vocabulary for the same ideas:
 *
 *   uses:    names the module file that implements the job, where GitHub wants a workflow.
 *   with:    carries the job's retry policy, where GitHub passes reusable-workflow inputs.
 *   outputs: maps an output name to prose describing it, where GitHub wants an expression. The
 *            names are load-bearing; the prose is for whoever reads the graph.
 *
 * Visibility follows GitHub exactly, though: a job reads the outputs of the jobs in its own
 * `needs:` and no others. Transitive reach is what made the original ordering unreviewable.
 */

import { readFileSync } from 'node:fs'
import { load as loadYaml } from 'js-yaml'

import { DEFAULT_RETRY_POLICY, validateRetryPolicy, type RetryPolicy } from './retry.js'

export interface PipelineJob {
  readonly id: string
  readonly name: string
  /** Manifest-relative path of the module implementing this job. */
  readonly uses: string
  readonly needs: readonly string[]
  readonly retry: RetryPolicy
  /** Context keys the module must return — checked against what it actually returns. */
  readonly outputs: readonly string[]
  readonly outputDescriptions: ReadonlyMap<string, string>
}

export interface PipelineManifest {
  readonly name: string
  readonly source: string
  readonly jobs: readonly PipelineJob[]
}

const TOP_LEVEL_KEYS = new Set(['name', 'on', 'jobs'])
const JOB_KEYS = new Set(['name', 'needs', 'uses', 'with', 'outputs'])
const RETRY_INPUTS = new Set(['retry-attempts', 'retry-delay-seconds', 'retry-max-delay-seconds'])

function asRecord(value: unknown, where: string): Record<string, unknown> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    throw new Error(`${where} must be a mapping`)
  }
  return value as Record<string, unknown>
}

function asString(value: unknown, where: string): string {
  if (typeof value !== 'string' || value.trim() === '') {
    throw new Error(`${where} must be a non-empty string`)
  }
  return value
}

function asFiniteNumber(value: unknown, where: string): number {
  if (typeof value !== 'number' || !Number.isFinite(value)) {
    throw new Error(`${where} must be a finite number, received ${JSON.stringify(value)}`)
  }
  return value
}

function rejectUnknownKeys(record: Record<string, unknown>, allowed: ReadonlySet<string>, where: string): void {
  const unknown = Object.keys(record).filter((key) => !allowed.has(key))
  if (unknown.length > 0) {
    throw new Error(
      `${where} has unsupported key(s) ${unknown.join(', ')} — this manifest understands ` +
        `${[...allowed].join(', ')} only`,
    )
  }
}

/** GitHub accepts a bare string or a sequence; normalize both, and reject duplicates. */
function parseNeeds(value: unknown, where: string): readonly string[] {
  if (value === undefined) return []
  const listed = typeof value === 'string' ? [value] : value
  if (!Array.isArray(listed)) throw new Error(`${where} must be a job id or a sequence of job ids`)
  const needs = listed.map((entry, index) => asString(entry, `${where}[${index}]`))
  const duplicate = needs.find((id, index) => needs.indexOf(id) !== index)
  if (duplicate) throw new Error(`${where} lists ${duplicate} twice`)
  return needs
}

function parseRetry(value: unknown, where: string): RetryPolicy {
  if (value === undefined) return DEFAULT_RETRY_POLICY
  const inputs = asRecord(value, where)
  rejectUnknownKeys(inputs, RETRY_INPUTS, where)

  const seconds = (key: string, fallbackMs: number) =>
    inputs[key] === undefined ? fallbackMs : asFiniteNumber(inputs[key], `${where}.${key}`) * 1_000

  const policy: RetryPolicy = {
    attempts:
      inputs['retry-attempts'] === undefined
        ? DEFAULT_RETRY_POLICY.attempts
        : asFiniteNumber(inputs['retry-attempts'], `${where}.retry-attempts`),
    delayMs: seconds('retry-delay-seconds', DEFAULT_RETRY_POLICY.delayMs),
    maxDelayMs: seconds('retry-max-delay-seconds', DEFAULT_RETRY_POLICY.maxDelayMs),
  }
  return validateRetryPolicy(policy, where)
}

function parseOutputs(value: unknown, where: string): ReadonlyMap<string, string> {
  if (value === undefined) return new Map()
  const declared = asRecord(value, where)
  return new Map(
    Object.entries(declared).map(([name, description]) => [
      asString(name, `${where} key`),
      asString(description, `${where}.${name}`),
    ]),
  )
}

function parseJob(id: string, value: unknown, source: string): PipelineJob {
  const where = `${source} jobs.${id}`
  const job = asRecord(value, where)
  rejectUnknownKeys(job, JOB_KEYS, where)

  const needs = parseNeeds(job.needs, `${where}.needs`)
  if (needs.includes(id)) throw new Error(`${where}.needs lists its own job`)
  const outputDescriptions = parseOutputs(job.outputs, `${where}.outputs`)

  return {
    id,
    name: asString(job.name, `${where}.name`),
    uses: asString(job.uses, `${where}.uses`),
    needs,
    retry: parseRetry(job.with, `${where}.with`),
    outputs: [...outputDescriptions.keys()],
    outputDescriptions,
  }
}

export function parsePipelineManifest(yamlText: string, source: string): PipelineManifest {
  const document = asRecord(loadYaml(yamlText), `${source} document`)
  rejectUnknownKeys(document, TOP_LEVEL_KEYS, source)

  const jobs = asRecord(document.jobs, `${source} jobs`)
  const entries = Object.entries(jobs)
  if (entries.length === 0) throw new Error(`${source} declares no jobs`)

  const parsed = entries.map(([id, job]) => parseJob(id, job, source))
  const known = new Set(parsed.map((job) => job.id))

  for (const job of parsed) {
    const missing = job.needs.filter((id) => !known.has(id))
    if (missing.length > 0) {
      throw new Error(`${source} jobs.${job.id}.needs names unknown job(s): ${missing.join(', ')}`)
    }
  }

  // One key, one producer. Two jobs declaring the same output would make the value a module read
  // depend on which of them ran last, which is the ambiguity this manifest exists to remove.
  const producerOf = new Map<string, string>()
  for (const job of parsed) {
    for (const output of job.outputs) {
      const existing = producerOf.get(output)
      if (existing) {
        throw new Error(`${source} declares output ${output} on both jobs.${existing} and jobs.${job.id}`)
      }
      producerOf.set(output, job.id)
    }
  }

  return {
    name: document.name === undefined ? source : asString(document.name, `${source} name`),
    source,
    jobs: parsed,
  }
}

export function loadPipelineManifest(location: URL | string): PipelineManifest {
  const source = location instanceof URL ? location.pathname.split('/').pop()! : location
  return parsePipelineManifest(readFileSync(location, 'utf8'), source)
}

/** Which job declares each output — used to explain an undeclared read. */
export function outputProducers(manifest: PipelineManifest): ReadonlyMap<string, string> {
  const producerOf = new Map<string, string>()
  for (const job of manifest.jobs) {
    for (const output of job.outputs) producerOf.set(output, job.id)
  }
  return producerOf
}
