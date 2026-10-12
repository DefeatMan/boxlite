// @vitest-environment jsdom
/*
 * Modified by BoxLite AI, 2026
 * SPDX-License-Identifier: AGPL-3.0
 */

import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { MemoryRouter, Route, Routes, useLocation } from 'react-router-dom'
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import { ApiProvider } from './ApiProvider'

const auth = {
  user: null as { access_token: string } | null,
  isAuthenticated: false,
  isLoading: false,
  signinRedirect: vi.fn(),
  removeUser: vi.fn(),
}
// The 401 handler ApiProvider hands to the client it builds.
let onUnauthorized: (() => unknown) | undefined

vi.mock('react-oidc-context', () => ({ useAuth: () => auth }))
vi.mock('@/hooks/useConfig', () => ({ useConfig: () => ({}) }))
vi.mock('@/components/LoadingFallback', () => ({ default: () => <p>loading</p> }))
vi.mock('@/api/apiClient', () => ({
  ApiClient: class {
    constructor(_config: unknown, _accessToken: string, handleUnauthorized: () => unknown) {
      onUnauthorized = handleUnauthorized
    }
    setAccessToken() {}
  },
}))

function Landing() {
  const { state } = useLocation()
  return <p>landing {(state as { returnTo?: string } | null)?.returnTo}</p>
}

let container: HTMLDivElement
let root: Root

beforeAll(() => {
  globalThis.IS_REACT_ACT_ENVIRONMENT = true
})

beforeEach(() => {
  auth.user = null
  auth.isAuthenticated = false
  auth.isLoading = false
  auth.signinRedirect = vi.fn()
  auth.removeUser = vi.fn()
  onUnauthorized = undefined
  container = document.createElement('div')
  document.body.appendChild(container)
  root = createRoot(container)
})

afterEach(() => {
  act(() => root.unmount())
  container.remove()
})

function render() {
  act(() =>
    root.render(
      <MemoryRouter initialEntries={['/dashboard/boxes?page=2']}>
        <Routes>
          <Route path="/" element={<Landing />} />
          <Route
            path="/dashboard/*"
            element={
              <ApiProvider>
                <p>console</p>
              </ApiProvider>
            }
          />
        </Routes>
      </MemoryRouter>,
    ),
  )
}

describe('ApiProvider', () => {
  it('sends a signed-out deep link to the landing page, keeping where it pointed', () => {
    render()

    expect(container.textContent).toBe('landing /dashboard/boxes?page=2')
    expect(auth.signinRedirect).not.toHaveBeenCalled()
  })

  it('signs a user whose token was rejected straight back in', async () => {
    auth.user = { access_token: 'token' }
    auth.isAuthenticated = true
    render()
    expect(container.textContent).toBe('console')

    await act(async () => {
      await onUnauthorized?.()
    })
    auth.user = null
    auth.isAuthenticated = false
    render()

    expect(auth.removeUser).toHaveBeenCalledOnce()
    expect(auth.signinRedirect).toHaveBeenCalledWith({ state: { returnTo: '/dashboard/boxes?page=2' } })
    expect(container.textContent).not.toContain('landing')
  })
})
