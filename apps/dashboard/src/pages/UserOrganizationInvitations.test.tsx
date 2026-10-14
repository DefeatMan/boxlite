// @vitest-environment jsdom
/*
 * Copyright 2026 BoxLite AI
 * SPDX-License-Identifier: AGPL-3.0
 */

import { act, Suspense } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { MemoryRouter } from 'react-router-dom'
import { toast } from 'sonner'
import { clear } from 'suspend-react'
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import { LocalStorageKey } from '@/enums/LocalStorageKey'
import { useSelectedOrganization } from '@/hooks/useSelectedOrganization'
import { OrganizationsProvider } from '@/providers/OrganizationsProvider'
import { SelectedOrganizationProvider } from '@/providers/SelectedOrganizationProvider'
import UserOrganizationInvitations from './UserOrganizationInvitations'

const mocks = vi.hoisted(() => {
  const invitation = {
    id: 'inv-1',
    organizationId: 'org-2',
    organizationName: 'Acme',
    email: 'invitee@example.com',
    invitedBy: 'owner@example.com',
    expiresAt: new Date('2099-01-01T00:00:00.000Z'),
  }
  return {
    auth: { user: { profile: { sub: 'invitee' } } },
    api: {
      organizationsApi: {
        listOrganizationInvitationsForAuthenticatedUser: vi.fn(),
        acceptOrganizationInvitation: vi.fn(),
        listOrganizations: vi.fn(),
        listOrganizationMembers: vi.fn(),
      },
    },
    invitation,
    invitations: { setCount: () => undefined },
  }
})

vi.mock('@/hooks/useApi', () => ({ useApi: () => mocks.api }))
vi.mock('react-oidc-context', () => ({ useAuth: () => mocks.auth }))
vi.mock('posthog-js/react', () => ({ usePostHog: () => null }))
vi.mock('@/hooks/useUserOrganizationInvitations', () => ({ useUserOrganizationInvitations: () => mocks.invitations }))
vi.mock('sonner', () => ({ toast: { success: vi.fn(), error: vi.fn() } }))
// The page chrome reads the banner context, which this test does not mount.
vi.mock('@/components/PageLayout', () => ({
  PageLayout: ({ children }: { children: React.ReactNode }) => <div>{children}</div>,
  PageHeader: ({ children }: { children: React.ReactNode }) => <div>{children}</div>,
  PageContent: ({ children }: { children: React.ReactNode }) => <div>{children}</div>,
  PageTitle: ({ children }: { children: React.ReactNode }) => <h1>{children}</h1>,
}))

function SelectedOrganization() {
  const { selectedOrganization } = useSelectedOrganization()
  return <output>{selectedOrganization?.id}</output>
}

describe('review regressions: UserOrganizationInvitations', () => {
  let root: Root | null = null
  const { organizationsApi } = mocks.api
  const member = { userId: 'invitee', role: 'owner', assignedRoles: [] }

  beforeAll(() => {
    globalThis.IS_REACT_ACT_ENVIRONMENT = true
    // Pagination asks for the viewport size; jsdom has no matchMedia.
    window.matchMedia = () =>
      ({ matches: false, addEventListener: () => undefined, removeEventListener: () => undefined }) as never
  })

  beforeEach(() => {
    clear()
    vi.clearAllMocks()
    localStorage.clear()
    localStorage.setItem(LocalStorageKey.SelectedOrganizationId, 'org-1')
    const own = { id: 'org-1', name: 'Personal', isDefaultForAuthenticatedUser: true }
    const joined = { id: 'org-2', name: 'Acme', isDefaultForAuthenticatedUser: false }
    organizationsApi.listOrganizations.mockResolvedValueOnce({ data: [own] }).mockResolvedValue({ data: [own, joined] })
    organizationsApi.listOrganizationMembers.mockResolvedValue({ data: [member] })
    organizationsApi.listOrganizationInvitationsForAuthenticatedUser
      .mockResolvedValueOnce({ data: [mocks.invitation] })
      .mockResolvedValue({ data: [] })
    organizationsApi.acceptOrganizationInvitation.mockResolvedValue({ data: mocks.invitation })
  })

  afterEach(() => {
    act(() => root?.unmount())
    root = null
    document.body.innerHTML = ''
  })

  async function acceptTheInvitation() {
    const host = document.createElement('div')
    document.body.appendChild(host)
    await act(async () => {
      root = createRoot(host)
      root.render(
        <MemoryRouter initialEntries={['/dashboard/user/invitations']}>
          <Suspense fallback={null}>
            <OrganizationsProvider>
              <SelectedOrganizationProvider>
                <SelectedOrganization />
                <UserOrganizationInvitations />
              </SelectedOrganizationProvider>
            </OrganizationsProvider>
          </Suspense>
        </MemoryRouter>,
      )
    })

    const accept = [...document.querySelectorAll('button')].find((button) =>
      button.textContent?.includes('Accept invitation'),
    )
    expect(accept).toBeTruthy()
    await act(async () => accept?.click())
  }

  it('switches the console to the organization the user just joined', async () => {
    await acceptTheInvitation()

    expect(document.querySelector('output')?.textContent).toBe('org-2')
    expect(localStorage.getItem(LocalStorageKey.SelectedOrganizationId)).toBe('org-2')
  })

  it.each(['missing membership', 'request failed'])('keeps the previous selection after %s', async (failure) => {
    organizationsApi.listOrganizationMembers.mockImplementation(async (organizationId: string) => {
      if (organizationId === 'org-1') return { data: [member] }
      if (failure === 'request failed') throw new Error('Request failed with status code 429')
      return { data: [] }
    })
    await acceptTheInvitation()

    expect(document.querySelector('output')?.textContent).toBe('org-1')
    expect(localStorage.getItem(LocalStorageKey.SelectedOrganizationId)).toBe('org-1')
    expect(toast.success).toHaveBeenCalledWith('You joined Acme')
    expect(toast.error).not.toHaveBeenCalledWith('Failed to accept invitation', expect.anything())
    // Once on load, and again because the accepted invitation leaves the list.
    expect(organizationsApi.listOrganizationInvitationsForAuthenticatedUser).toHaveBeenCalledTimes(2)
  })
})
