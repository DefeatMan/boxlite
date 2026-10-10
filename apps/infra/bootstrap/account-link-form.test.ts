// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (c) 2026 BoxLite AI

import assert from 'node:assert/strict'
import test from 'node:test'
import { runInNewContext } from 'node:vm'

import { loadAccountLinkForm } from './account-link-form.js'

function customCode(form: any, id: string): string {
  const component = form.nodes
    .flatMap((node: any) => node.config?.components ?? [])
    .find((entry: any) => entry.id === id)
  assert.equal(component?.type, 'CUSTOM', `${id} is a custom field`)
  return component.config.code
}

/** Just enough of a browser page for the address field: elements are plain objects. */
function page() {
  const head: any[] = []
  const rootClasses = new Set<string>()
  const element = (tagName: string): any => ({ tagName, value: '' })
  const document = {
    createElement: element,
    documentElement: {
      classList: { toggle: (name: string, on: boolean) => (on ? rootClasses.add(name) : rootClasses.delete(name)) },
    },
    head: { appendChild: (item: any) => head.push(item) },
    getElementById: () => null,
  }
  return { document, head, rootClasses }
}

/**
 * A custom field as Forms runs it: `getParams()` throws until Forms has
 * resolved the field's params, and Forms then calls the field's `update()`.
 * `getValue()` resolves to the field's own `getValue()`, never a value the
 * Action seeded.
 */
function field(code: string, name: string, browser: ReturnType<typeof page>, params: Record<string, string>) {
  const factory = runInNewContext(`${code}\n;${name}`, { document: browser.document })
  let resolved = false
  const handler = factory({
    custom: {
      getValue: async () => handler.getValue(),
      getParams: () => {
        if (!resolved) throw new Error('You cannot call context.custom.getParams() before init()')
        return params
      },
    },
  })
  return {
    handler,
    resolveParams() {
      resolved = true
      handler.update?.()
    },
  }
}

test('the link Form carries its styles in the address field', () => {
  const form = loadAccountLinkForm()
  const account = customCode(form, 'account')

  assert.doesNotMatch(account, /__[A-Z_]+_JSON__/)
  assert.match(account, /\.bl-link-account \{/)
})

test('the link Form passes the address and mode to its custom field as params', () => {
  const form = loadAccountLinkForm()
  const params = (id: string) =>
    form.nodes.flatMap((node: any) => node.config?.components ?? []).find((entry: any) => entry.id === id).config.params

  assert.deepEqual(params('account'), { address: '{{vars.address}}', mode: '{{vars.mode}}' })
})

test('the address field shows the address once Forms resolves its params', () => {
  const browser = page()
  const account = field(customCode(loadAccountLinkForm(), 'account'), 'linkAccountField', browser, {
    address: 'ada@example.com',
  })

  const input = account.handler.init()
  assert.equal(input.value, '')
  account.resolveParams()

  assert.equal(input.value, 'ada@example.com')
  assert.equal(input.disabled, true)
  assert.equal(browser.head.length, 1)
})

test('the address field leaves an unresolved template out', () => {
  const account = field(customCode(loadAccountLinkForm(), 'account'), 'linkAccountField', page(), {
    address: '{{vars.address}}',
  })

  const input = account.handler.init()
  account.resolveParams()

  assert.equal(input.value, '')
})

test('the address field hides the password field in code mode only', () => {
  const code = customCode(loadAccountLinkForm(), 'account')
  const shown = (mode: string) => {
    const browser = page()
    const account = field(code, 'linkAccountField', browser, { address: 'ada@example.com', mode })
    account.handler.init()
    account.resolveParams()
    return browser.rootClasses.has('bl-link-code')
  }

  assert.equal(shown('code'), true)
  assert.equal(shown('password'), false)
  assert.match(code, /\.bl-link-code \.af-componentId-password \{\\n {2}display: none !important/)
})
