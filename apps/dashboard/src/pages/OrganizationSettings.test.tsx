// @vitest-environment jsdom
/*
 * Copyright 2026 BoxLite AI
 * SPDX-License-Identifier: AGPL-3.0
 */

import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { MemoryRouter, useLocation, useNavigate } from 'react-router-dom'
import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest'
import OrganizationSettings from './OrganizationSettings'

const mocks = vi.hoisted(() => ({
  api: { organizationsApi: { listOrganizationInvitations: vi.fn(async () => ({ data: [] })) } },
  organizations: { refreshOrganizations: async () => undefined },
  selection: {
    selectedOrganization: { id: 'org-1', name: 'Acme' },
    organizationMembers: [{ userId: 'user-1', email: 'owner@example.com', role: 'owner', isDefaultForUser: true }],
    refreshOrganizationMembers: async () => [],
    authenticatedUserOrganizationMember: { userId: 'user-1', role: 'owner' },
  },
  auth: { user: { profile: { sub: 'user-1' } } },
}))

vi.mock('@/hooks/useApi', () => ({ useApi: () => mocks.api }))
vi.mock('@/hooks/useOrganizations', () => ({ useOrganizations: () => mocks.organizations }))
vi.mock('@/hooks/useSelectedOrganization', () => ({ useSelectedOrganization: () => mocks.selection }))
vi.mock('react-oidc-context', () => ({ useAuth: () => mocks.auth }))
vi.mock('usehooks-ts', () => ({ useCopyToClipboard: () => [false, vi.fn()] }))
vi.mock('sonner', () => ({ toast: { success: vi.fn(), error: vi.fn() } }))
vi.mock('@/components/Banner', () => ({ BannerStack: () => null }))

function Navigation() {
  const location = useLocation()
  const navigate = useNavigate()
  return (
    <>
      <output>
        {location.pathname}
        {location.search}
      </output>
      <button onClick={() => navigate(-1)}>Back</button>
    </>
  )
}

describe('Organization settings tabs', () => {
  let root: Root | null = null

  beforeAll(() => {
    globalThis.IS_REACT_ACT_ENVIRONMENT = true
    window.matchMedia = () =>
      ({ matches: false, addEventListener: () => undefined, removeEventListener: () => undefined }) as never
  })

  afterEach(() => {
    act(() => root?.unmount())
    root = null
    document.body.innerHTML = ''
    vi.clearAllMocks()
  })

  async function renderPage(path = '/dashboard/settings') {
    const host = document.createElement('div')
    document.body.appendChild(host)
    await act(async () => {
      root = createRoot(host)
      root.render(
        <MemoryRouter initialEntries={[path]}>
          <OrganizationSettings />
          <Navigation />
        </MemoryRouter>,
      )
    })
  }

  it('opens General with metadata and loads members only after choosing Member', async () => {
    await renderPage()
    expect(document.querySelector<HTMLInputElement>('#organization-name')?.value).toBe('Acme')
    expect([...document.querySelectorAll('input')].some((input) => input.value === 'org-1')).toBe(true)
    expect(mocks.api.organizationsApi.listOrganizationInvitations).not.toHaveBeenCalled()
    const tabs = [...document.querySelectorAll<HTMLButtonElement>('[role="tab"]')]
    expect(tabs.map((tab) => tab.textContent)).toEqual(['General', 'Member'])
    expect(tabs[0].getAttribute('aria-selected')).toBe('true')
    await act(async () => tabs[1].dispatchEvent(new MouseEvent('mousedown', { bubbles: true, button: 0 })))
    expect(document.querySelector('output')?.textContent).toBe('/dashboard/settings?tab=member')
    expect(document.querySelector('tbody')?.textContent).toContain('owner@example.com')
    await act(async () =>
      [...document.querySelectorAll('button')].find((button) => button.textContent === 'Back')?.click(),
    )
    expect(document.querySelector('[role="tab"][aria-selected="true"]')?.textContent).toBe('General')
  })

  it('opens Member directly from a bookmarked tab URL', async () => {
    await renderPage('/dashboard/settings?tab=member')
    expect(document.querySelector('[role="tab"][aria-selected="true"]')?.textContent).toBe('Member')
    expect(document.querySelector('tbody')?.textContent).toContain('owner@example.com')
  })
})
