// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (c) 2026 BoxLite AI

import assert from 'node:assert/strict'
import test from 'node:test'

import { scopeContext } from './module.js'

interface Context {
  visible: string
  hidden: string
}

const accumulated = { visible: 'from a declared edge', hidden: 'from an undeclared one' }
const producerOf = new Map([
  ['visible', 'upstream'],
  ['hidden', 'elsewhere'],
])

const scoped = () => scopeContext<Context>(accumulated, ['visible'], 'consumer', producerOf)

test('hands over the values the job declared it needs', () => {
  const { visible } = scoped()
  assert.equal(visible, 'from a declared edge')
})

test('refuses a value from a job outside `needs:` and names the edge to add', () => {
  assert.throws(
    () => scoped().hidden,
    /module 'consumer' read 'hidden', which jobs\.elsewhere produces — add elsewhere to jobs\.consumer\.needs in pipeline\.yml/,
  )
})

test('refuses a key no job produces at all', () => {
  assert.throws(
    () => (scoped() as unknown as Record<string, unknown>).typoed,
    /module 'consumer' read 'typoed', which no job in pipeline\.yml declares as an output/,
  )
})

test('refuses an assignment, pointing at declare() instead', () => {
  assert.throws(() => {
    ;(scoped() as unknown as Record<string, unknown>).visible = 'mutated'
  }, /module 'consumer' assigned to context key 'visible' — return it from declare\(\)/)
})

test('answers the promise probe rather than throwing on it', async () => {
  // `await` reads `.then` before it treats a value as settled. Left to the refusal rule that read
  // would fail with an error about a key nobody wrote, from a line that never mentions one.
  const context = scoped()
  assert.equal((context as unknown as Record<string, unknown>).then, undefined)
  assert.equal(await context, context)
})

test('reports its shape as the visible keys only', () => {
  const context = scoped()
  assert.deepEqual(Object.keys(context), ['visible'])
  assert.deepEqual({ ...context }, { visible: 'from a declared edge' })
  assert.ok('visible' in context)
  assert.ok(!('hidden' in context))
})
