/*
 * Copyright 2025 Daytona Platforms Inc.
 * Modified by BoxLite AI, 2025-2026
 * SPDX-License-Identifier: AGPL-3.0
 */

import { LogoText } from '@/assets/Logo'
import LoadingFallback from '@/components/LoadingFallback'
import { RoutePath } from '@/enums/RoutePath'
import { consumeJustLoggedOut } from '@/lib/auth-session'
import type { ReactNode } from 'react'
import { useCallback, useRef, useState } from 'react'
import { useAuth } from 'react-oidc-context'
import { Navigate, useLocation } from 'react-router-dom'

const TERMS_URL = 'https://boxlite.ai/legal/terms'
const PRIVACY_URL = 'https://boxlite.ai/legal/privacy'

// Sign-in never starts on its own: a signed-out visitor first sees the Terms of
// Service and Privacy Policy notice, and Continue hands them to the OIDC hosted
// login (Auth0 in dev/prod, Dex locally), so the app still never collects
// credentials. ApiProvider sends signed-out /dashboard links here with their
// returnTo, so a deep link meets the same notice. After a logout the page says
// so and offers Sign in instead.
const LandingPage: React.FC = () => {
  const { signinRedirect, isAuthenticated, isLoading } = useAuth()
  const location = useLocation()
  const redirecting = useRef(false)
  const [loggedOut] = useState(() => consumeJustLoggedOut())
  const returnTo = returnToFrom(location.state) ?? RoutePath.DASHBOARD + location.search

  const signIn = useCallback(() => {
    if (redirecting.current) return
    redirecting.current = true
    void signinRedirect({ state: { returnTo } })
  }, [signinRedirect, returnTo])

  if (isAuthenticated) {
    return <Navigate to={`${RoutePath.DASHBOARD}${location.search}`} replace />
  }

  // Covers the code exchange on the way back from the hosted login.
  if (isLoading) {
    return <LoadingFallback />
  }

  return (
    <div className="flex min-h-svh flex-col items-center justify-center gap-6 px-6 text-center">
      <LogoText className="h-9 w-auto" />
      {loggedOut && <p className="font-mono text-[13px] text-muted-foreground">You&apos;ve been signed out.</p>}
      <button
        type="button"
        onClick={signIn}
        className="border border-border px-5 py-2.5 text-[13px] font-medium transition-colors hover:bg-card focus-visible:border-brand focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand/35"
      >
        {loggedOut ? 'Sign in' : 'Continue to BoxLite'}
      </button>
      <p className="max-w-sm font-mono text-[13px] text-muted-foreground">
        By continuing, you agree to the <LegalLink href={TERMS_URL}>Terms of Service</LegalLink> and{' '}
        <LegalLink href={PRIVACY_URL}>Privacy Policy</LegalLink>.
      </p>
    </div>
  )
}

// The foreground color sets the links apart from the muted sentence: a link
// that only differs by its underline is easy to read past.
function LegalLink({ href, children }: { href: string; children: ReactNode }) {
  return (
    <a href={href} target="_blank" rel="noopener" className="text-foreground underline underline-offset-2">
      {children}
    </a>
  )
}

function returnToFrom(state: unknown): string | undefined {
  if (typeof state !== 'object' || state === null) return undefined
  const { returnTo } = state as { returnTo?: unknown }
  return typeof returnTo === 'string' ? returnTo : undefined
}

export default LandingPage
