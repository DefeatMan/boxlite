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

/**
 * Just enough of a browser page for the custom fields: elements are plain
 * objects, and `submits` counts the steps a field moves the Form forward.
 */
function page({ stored = new Map<string, string>(), navigation = 'navigate' } = {}) {
  const submits: number[] = []
  const head: any[] = []
  const rootClasses = new Set<string>()
  const element = (tagName: string): any => {
    const node: any = {
      tagName,
      value: '',
      children: [] as any[],
      listeners: {} as Record<string, () => void>,
      append: (...items: any[]) => node.children.push(...items),
      appendChild: (item: any) => node.children.push(item),
      addEventListener: (type: string, listener: () => void) => (node.listeners[type] = listener),
    }
    return node
  }
  const document = {
    createElement: element,
    documentElement: {
      classList: { toggle: (name: string, on: boolean) => (on ? rootClasses.add(name) : rootClasses.delete(name)) },
    },
    head: { appendChild: (item: any) => head.push(item) },
    getElementById: () => null,
    querySelector: () => null,
  }
  const window = {
    performance: { getEntriesByType: () => [{ type: navigation }] },
    localStorage: {
      getItem: (key: string) => stored.get(key) ?? null,
      setItem: (key: string, value: string) => stored.set(key, value),
    },
  }
  return { document, window, head, submits, stored, rootClasses }
}

/**
 * A custom field as Forms runs it: `getParams()` throws until Forms has
 * resolved the field's params, and Forms then calls the field's `update()`.
 * `getValue()` resolves to the field's own `getValue()`, never a value the
 * Action seeded.
 */
function field(code: string, name: string, browser: ReturnType<typeof page>, params: Record<string, string>) {
  const factory = runInNewContext(`${code}\n;${name}`, {
    document: browser.document,
    window: browser.window,
    setTimeout,
  })
  let resolved = false
  const handler = factory({
    form: { goForward: () => browser.submits.push(Date.now()) },
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

const settle = () => new Promise((resolve) => setTimeout(resolve, 5))

test('the link Form carries its styles in the address field', () => {
  const form = loadAccountLinkForm()
  for (const id of ['account', 'cancel']) assert.doesNotMatch(customCode(form, id), /__[A-Z_]+_JSON__/)

  assert.match(customCode(form, 'account'), /\.bl-link-cancel \{/)
})

test('the link Form passes the address, mode and render id to its custom fields as params', () => {
  const form = loadAccountLinkForm()
  const params = (id: string) =>
    form.nodes.flatMap((node: any) => node.config?.components ?? []).find((entry: any) => entry.id === id).config.params

  assert.deepEqual(params('account'), { address: '{{vars.address}}', mode: '{{vars.mode}}' })
  assert.deepEqual(params('cancel'), { render: '{{vars.render}}' })
})

test('the address field shows the address once Forms resolves its params', async () => {
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

test('the address field leaves an unresolved template out', () => {
  const account = field(customCode(loadAccountLinkForm(), 'account'), 'linkAccountField', page(), {
    address: '{{vars.address}}',
  })

  const input = account.handler.init()
  account.resolveParams()

  assert.equal(input.value, '')
})

test('Cancel answers cancel and moves the Form forward', async () => {
  const browser = page()
  const cancel = field(customCode(loadAccountLinkForm(), 'cancel'), 'linkCancelField', browser, {
    render: 'render-1',
  })

  const line = cancel.handler.init()
  cancel.resolveParams()
  await settle()
  assert.equal(browser.submits.length, 0)
  assert.equal(cancel.handler.getValue(), '')

  line.children.find((child: any) => child.tagName === 'button').listeners.click()

  assert.equal(browser.submits.length, 1)
  assert.equal(cancel.handler.getValue(), 'cancel')
})

test('a second load of one render, or a reload, cancels by itself', async () => {
  const code = customCode(loadAccountLinkForm(), 'cancel')
  const stored = new Map<string, string>()

  const load = async (browser: ReturnType<typeof page>, render: string) => {
    const cancel = field(code, 'linkCancelField', browser, { render })
    cancel.handler.init()
    cancel.resolveParams()
    await settle()
    return cancel.handler
  }

  const first = page({ stored })
  await load(first, 'render-1')
  assert.equal(first.submits.length, 0)

  const copied = page({ stored })
  const again = await load(copied, 'render-1')
  assert.equal(copied.submits.length, 1)
  assert.equal(again.getValue(), 'cancel')

  const reloaded = page({ navigation: 'reload' })
  await load(reloaded, 'render-2')
  assert.equal(reloaded.submits.length, 1)

  const next = page({ stored })
  await load(next, 'render-3')
  assert.equal(next.submits.length, 0)
})
