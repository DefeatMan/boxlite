/*
 * Copyright 2026 BoxLite AI
 * SPDX-License-Identifier: AGPL-3.0
 */

describe('OIDC account link configuration', () => {
  const REQUIRED_KEYS = [
    'OIDC_ACCOUNT_LINK_CLIENT_ID',
    'OIDC_ACCOUNT_LINK_CLIENT_SECRET',
    'OIDC_ACCOUNT_LINK_REDIRECT_SECRET',
    'OIDC_ACCOUNT_LINK_DB_CONNECTION',
    'OIDC_ACCOUNT_LINK_REDIRECT_URI',
    'OIDC_ACCOUNT_LINK_AUTHORIZE_URL',
  ]
  const ENV_KEYS = [...REQUIRED_KEYS, 'OIDC_ACCOUNT_LINK_ENABLED']
  const saved: Record<string, string | undefined> = {}

  beforeEach(() => {
    for (const key of ENV_KEYS) {
      saved[key] = process.env[key]
      delete process.env[key]
    }
    jest.resetModules()
  })

  afterEach(() => {
    for (const key of ENV_KEYS) {
      if (saved[key] === undefined) delete process.env[key]
      else process.env[key] = saved[key]
    }
    jest.resetModules()
  })

  function loadAccountLinkConfiguration() {
    const { configuration } = require('./configuration') as typeof import('./configuration')
    return configuration.oidc.accountLink
  }

  function enable() {
    process.env.OIDC_ACCOUNT_LINK_ENABLED = 'true'
    process.env.OIDC_ACCOUNT_LINK_CLIENT_ID = 'link-client'
    process.env.OIDC_ACCOUNT_LINK_CLIENT_SECRET = 'link-secret'
    process.env.OIDC_ACCOUNT_LINK_REDIRECT_SECRET = 'redirect-secret'
    process.env.OIDC_ACCOUNT_LINK_DB_CONNECTION = 'Username-Password-Authentication'
    process.env.OIDC_ACCOUNT_LINK_REDIRECT_URI = 'https://api.dev.boxlite.ai/api/auth/link/callback'
    process.env.OIDC_ACCOUNT_LINK_AUTHORIZE_URL = 'https://auth.dev.boxlite.ai/authorize'
  }

  it('stays inert, and demands nothing, while account linking is off', () => {
    expect(loadAccountLinkConfiguration()).toEqual({
      enabled: false,
      clientId: undefined,
      clientSecret: undefined,
      redirectSecret: undefined,
      databaseConnection: undefined,
      redirectUri: undefined,
      authorizeUrl: undefined,
    })
  })

  it.each(REQUIRED_KEYS)('refuses to boot with account linking on but %s missing', (key) => {
    enable()
    delete process.env[key]

    expect(() => loadAccountLinkConfiguration()).toThrow(`${key} is required when OIDC_ACCOUNT_LINK_ENABLED is true`)
  })

  // Each provider puts /authorize somewhere else relative to its issuer, so the
  // value is taken as configured rather than rebuilt from the issuer's origin.
  it.each([
    ['Auth0, at the issuer origin', 'https://tenant.us.auth0.com/authorize'],
    ['Okta, below the issuer path', 'https://tenant.okta.com/oauth2/default/v1/authorize'],
    ['the local Dex stack, named /auth', 'http://localhost:25556/dex/auth'],
  ])('keeps the authorize endpoint of %s verbatim', (_provider, configured) => {
    enable()
    process.env.OIDC_ACCOUNT_LINK_AUTHORIZE_URL = configured

    expect(loadAccountLinkConfiguration().authorizeUrl).toBe(configured)
  })

  it('rejects an authorize endpoint carrying a query the second sign-in would inherit', () => {
    enable()
    process.env.OIDC_ACCOUNT_LINK_AUTHORIZE_URL = 'https://auth.dev.boxlite.ai/authorize?audience=api'

    expect(() => loadAccountLinkConfiguration()).toThrow('must not carry a query or fragment')
  })

  it('rejects a callback carrying a query, which Auth0 would never match', () => {
    enable()
    process.env.OIDC_ACCOUNT_LINK_REDIRECT_URI = 'https://api.dev.boxlite.ai/api/auth/link/callback?stage=dev'

    expect(() => loadAccountLinkConfiguration()).toThrow('must not carry a query or fragment')
  })

  // The tenant compares both URLs character by character, so a trailing slash
  // the operator registered has to survive configuration rather than be
  // normalised away into a value the tenant would reject.
  it.each([
    ['OIDC_ACCOUNT_LINK_REDIRECT_URI', 'redirectUri', 'https://api.dev.boxlite.ai/api/auth/link/callback/'],
    ['OIDC_ACCOUNT_LINK_AUTHORIZE_URL', 'authorizeUrl', 'https://auth.dev.boxlite.ai/authorize/'],
  ])('keeps the trailing slash %s was registered with', (key, field, configured) => {
    enable()
    process.env[key] = configured

    expect(loadAccountLinkConfiguration()[field as 'redirectUri' | 'authorizeUrl']).toBe(configured)
  })
})
