// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (c) 2026 BoxLite AI

/*
 * What a module is, and what it is allowed to see.
 *
 * Two phases, because only one of them can be retried. `resolve` does the async work — an AWS
 * lookup, loading a builder — and is repeated under the job's retry policy. `declare` registers
 * resources and runs exactly once: a second pass would re-register the same URNs and the Pulumi
 * engine would reject the duplicate rather than recover. Splitting them is what lets retry be
 * real here instead of a wrapper that turns one failure into an unrecoverable one.
 *
 * The context a module receives is a view, not the accumulated whole. Reading a key produced by a
 * job outside its `needs:` throws and names the edge to add, so an undeclared dependency fails at
 * the first deploy that exercises it rather than surviving as an ordering nobody wrote down.
 */

export interface StackModule<TContext extends object, TResolved = void> {
  /** Must equal the job id in pipeline.yml; run.ts pairs them by this. */
  readonly id: string
  /** Retried under the job's policy. Must be safe to repeat — no resource registration here. */
  resolve?(context: TContext): Promise<TResolved> | TResolved
  /** Runs once. Returns exactly the outputs the job declares — no more, no fewer. */
  declare(context: TContext, resolved: TResolved): Partial<TContext> | Promise<Partial<TContext>>
}

/*
 * `unknown` rather than a per-module type: the registry is heterogeneous, and each module's
 * resolved value is private to it. Assignment works because `resolve` is covariant in its return
 * and `declare` is declared as a method, whose parameters TypeScript checks bivariantly.
 */
export type ModuleRegistry<TContext extends object> = ReadonlyMap<string, StackModule<TContext, unknown>>

/*
 * `await` probes an object for `.then` before treating it as a value, so a scoped context that
 * threw on every undeclared key would turn `await someHelper(context)` into an error about a key
 * nobody wrote. Reported as absent instead — a module named `then` is not a case worth keeping.
 */
const PROMISE_PROBE = 'then'

export function scopeContext<TContext extends object>(
  accumulated: Readonly<Record<string, unknown>>,
  visible: readonly string[],
  jobId: string,
  producerOf: ReadonlyMap<string, string>,
): TContext {
  const allowed = new Set(visible)

  // Unprefixed: these always surface through pipeline/run.ts, which names the job and phase.
  const refuse = (key: string): never => {
    const producer = producerOf.get(key)
    throw new Error(
      producer
        ? `module '${jobId}' read '${key}', which jobs.${producer} produces — add ` +
          `${producer} to jobs.${jobId}.needs in pipeline.yml`
        : `module '${jobId}' read '${key}', which no job in pipeline.yml declares as an output`,
    )
  }

  return new Proxy(Object.create(null) as TContext, {
    get(_target, key) {
      if (typeof key !== 'string' || key === PROMISE_PROBE) return undefined
      return allowed.has(key) ? accumulated[key] : refuse(key)
    },
    has(_target, key) {
      return typeof key === 'string' && allowed.has(key)
    },
    ownKeys() {
      return [...allowed]
    },
    getOwnPropertyDescriptor(_target, key) {
      if (typeof key !== 'string' || !allowed.has(key)) return undefined
      // configurable, because the target genuinely has no such property and a proxy may not
      // report a non-configurable one that does not exist.
      return { configurable: true, enumerable: true, value: accumulated[key], writable: false }
    },
    set(_target, key) {
      throw new Error(
        `module '${jobId}' assigned to context key '${String(key)}' — return it from ` +
          `declare() and list it under jobs.${jobId}.outputs instead`,
      )
    },
  })
}
