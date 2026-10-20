// @vitest-environment jsdom
/*
 * Copyright 2026 BoxLite AI
 * SPDX-License-Identifier: AGPL-3.0
 */

import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import Keys from './Keys'

const mocks = vi.hoisted(() => ({
  create: vi.fn(async () => ({ value: 'test-key' })),
  member: { role: 'owner', assignedRoles: [] as { permissions: string[] }[] },
}))

vi.mock('@/hooks/useConfig', () => ({ useConfig: () => ({ apiUrl: 'https://api.example.com' }) }))
vi.mock('@/hooks/useSelectedOrganization', () => ({
  useSelectedOrganization: () => ({
    selectedOrganization: { id: 'org-1' },
    authenticatedUserOrganizationMember: mocks.member,
  }),
}))
vi.mock('@/hooks/queries/useApiKeysQuery', () => ({ useApiKeysQuery: () => ({ data: [] }) }))
vi.mock('@/hooks/mutations/useRevokeApiKeyMutation', () => ({ useRevokeApiKeyMutation: () => ({}) }))
vi.mock('@/hooks/mutations/useCreateApiKeyMutation', () => ({
  useCreateApiKeyMutation: () => ({ mutateAsync: mocks.create }),
}))
vi.mock('@/hooks/useCopyToClipboard', () => ({ useCopyToClipboard: () => [null, vi.fn()] }))
vi.mock('@/components/ApiKeyTable', () => ({ ApiKeyTable: () => null }))
vi.mock('sonner', () => ({ toast: { success: vi.fn(), error: vi.fn() } }))

describe('console tenant key defaults', () => {
  let root: Root

  beforeAll(() => {
    globalThis.IS_REACT_ACT_ENVIRONMENT = true
  })

  beforeEach(() => {
    vi.clearAllMocks()
    mocks.member = { role: 'owner', assignedRoles: [] }
  })

  afterEach(() => {
    act(() => root?.unmount())
    document.body.innerHTML = ''
  })

  async function createKey() {
    const host = document.createElement('div')
    document.body.appendChild(host)
    await act(async () => {
      root = createRoot(host)
      root.render(<Keys />)
    })
    await act(async () => document.querySelector<HTMLButtonElement>('button[title="Create Key"]')?.click())
    const name = document.querySelector<HTMLInputElement>('input[placeholder="Name"]')
    expect(name).toBeTruthy()
    await act(async () => {
      Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')?.set?.call(name, 'automation')
      name?.dispatchEvent(new Event('input', { bubbles: true }))
    })
    await act(async () => {
      document
        .querySelector('#create-api-key-form')
        ?.dispatchEvent(new Event('submit', { bubbles: true, cancelable: true }))
    })
    expect(mocks.create).toHaveBeenCalledTimes(1)
    return (mocks.create.mock.calls[0] as unknown as [{ permissions: string[] }])[0].permissions
  }

  it('includes independent tenant read and write scopes for an owner', async () => {
    const permissions = await createKey()

    expect(permissions).toContain('read:tenant')
    expect(permissions).toContain('write:tenant')
  })

  it('includes assigned tenant read for a member but never tenant write', async () => {
    mocks.member = {
      role: 'member',
      assignedRoles: [{ permissions: ['write:boxes', 'read:tenant', 'write:tenant'] }],
    }
    const permissions = await createKey()

    expect(permissions).toContain('read:tenant')
    expect(permissions).not.toContain('write:tenant')
  })

  it('does not grant tenant scopes to a member without them', async () => {
    mocks.member = { role: 'member', assignedRoles: [{ permissions: ['write:boxes'] }] }

    expect(await createKey()).toEqual(['write:boxes'])
  })
})
