// @vitest-environment jsdom
/*
 * Modified by BoxLite AI, 2026
 * SPDX-License-Identifier: AGPL-3.0
 */

import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { MemoryRouter, Route, Routes, type InitialEntry } from 'react-router-dom'
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import { markJustLoggedOut } from '@/lib/auth-session'
import LandingPage from './LandingPage'

const auth = { isAuthenticated: false, isLoading: false, signinRedirect: vi.fn() }

vi.mock('react-oidc-context', () => ({ useAuth: () => auth }))
vi.mock('@/assets/Logo', () => ({ LogoText: () => <span>BoxLite</span> }))

const NOTICE_LINKS = [
  { text: 'Terms of Service', href: 'https://boxlite.ai/legal/terms', target: '_blank', rel: 'noopener' },
  { text: 'Privacy Policy', href: 'https://boxlite.ai/legal/privacy', target: '_blank', rel: 'noopener' },
]

let container: HTMLDivElement
let root: Root

beforeAll(() => {
  globalThis.IS_REACT_ACT_ENVIRONMENT = true
})

beforeEach(() => {
  auth.isAuthenticated = false
  auth.isLoading = false
  auth.signinRedirect = vi.fn()
  sessionStorage.clear()
  container = document.createElement('div')
  document.body.appendChild(container)
  root = createRoot(container)
})

afterEach(() => {
  act(() => root.unmount())
  container.remove()
})

function render(entry: InitialEntry = '/') {
  act(() =>
    root.render(
      <MemoryRouter initialEntries={[entry]}>
        <Routes>
          <Route path="/" element={<LandingPage />} />
          <Route path="/dashboard" element={<p>dashboard</p>} />
        </Routes>
      </MemoryRouter>,
    ),
  )
}

function clickButton(label: string) {
  const button = [...container.querySelectorAll('button')].find((candidate) => candidate.textContent === label)
  if (!button) throw new Error(`no "${label}" button in: ${container.textContent}`)
  act(() => button.click())
}

function noticeLinks() {
  return [...container.querySelectorAll('a')].map((link) => ({
    text: link.textContent,
    href: link.getAttribute('href'),
    target: link.getAttribute('target'),
    rel: link.getAttribute('rel'),
  }))
}

describe('LandingPage', () => {
  it('shows the terms to a signed-out visitor instead of starting the hosted login', () => {
    render('/?ref=docs')

    expect(container.textContent).toContain('Continue to BoxLite')
    expect(container.textContent).toContain('By continuing, you agree to the Terms of Service and Privacy Policy.')
    expect(noticeLinks()).toEqual(NOTICE_LINKS)
    expect(auth.signinRedirect).not.toHaveBeenCalled()
  })

  it('signs in on Continue and keeps the query for the dashboard', () => {
    render('/?ref=docs')

    clickButton('Continue to BoxLite')

    expect(auth.signinRedirect).toHaveBeenCalledOnce()
    expect(auth.signinRedirect).toHaveBeenCalledWith({ state: { returnTo: '/dashboard?ref=docs' } })
  })

  it('returns a deep link that ApiProvider sent here to where it started', () => {
    render({ pathname: '/', state: { returnTo: '/dashboard/user/invitations?id=inv-1' } })

    clickButton('Continue to BoxLite')

    expect(auth.signinRedirect).toHaveBeenCalledWith({ state: { returnTo: '/dashboard/user/invitations?id=inv-1' } })
  })

  it('says a visitor who just logged out has been signed out, with the same notice', () => {
    markJustLoggedOut()
    render()

    expect(container.textContent).toContain("You've been signed out.")
    expect(noticeLinks()).toEqual(NOTICE_LINKS)
    clickButton('Sign in')
    expect(auth.signinRedirect).toHaveBeenCalledOnce()
  })

  it('sends a signed-in visitor straight to the dashboard', () => {
    auth.isAuthenticated = true
    render()

    expect(container.textContent).toBe('dashboard')
  })
})
