/*
 * Copyright 2026 BoxLite AI
 * SPDX-License-Identifier: AGPL-3.0
 */

import { BadRequestException, NotFoundException } from '@nestjs/common'
import { SignJWT, jwtVerify } from 'jose'
import { AccountLinkController, buildSecondAuthorizeUrl } from './account-link.controller'
import { AccountLinkService, readAccountLinkSession } from './account-link.service'

const REDIRECT_SECRET = 'redirect-secret-value-of-32-chars!'
const SECRET = new TextEncoder().encode(REDIRECT_SECRET)
const TENANT = 'https://auth.dev.boxlite.ai'
const CALLBACK_URL = 'https://api.dev.boxlite.ai/api/auth/link/callback'
const DB_CONNECTION = 'Username-Password-Authentication'
const SPA_CLIENT = 'dashboard-spa'
const SOCIAL_USER_ID = 'google-oauth2|103'
const PRIMARY_USER_ID = 'auth0|primary'

const SESSION_CLAIMS = { email: 'ada@example.com', connection: DB_CONNECTION, callback: CALLBACK_URL }

function makeController(overrides: Record<string, unknown> = {}) {
  const values: Record<string, unknown> = {
    'oidc.accountLink.enabled': true,
    'oidc.accountLink.redirectSecret': REDIRECT_SECRET,
    'oidc.accountLink.clientId': SPA_CLIENT,
    'oidc.accountLink.authorizeUrl': `${TENANT}/authorize`,
    ...overrides,
  }
  const configService = {
    get: jest.fn((key: string) => values[key]),
    getOrThrow: jest.fn((key: string) => {
      if (values[key] === undefined) throw new Error(`account-link.controller.spec: unexpected config key "${key}"`)
      return values[key]
    }),
  }
  const auth0Management = {
    usersByEmail: jest.fn().mockResolvedValue([
      {
        user_id: PRIMARY_USER_ID,
        identities: [{ provider: 'auth0', user_id: 'primary', connection: DB_CONNECTION }],
      },
    ]),
  }
  const service = new AccountLinkService(configService as any, auth0Management as any)
  const response = { redirect: jest.fn() }
  return {
    controller: new AccountLinkController(configService as any, service),
    service,
    auth0Management,
    response,
  }
}

function actionToken(
  claims: Record<string, unknown> = SESSION_CLAIMS,
  { subject = SOCIAL_USER_ID, expiresIn = '60s', secret = SECRET }: Partial<Record<string, any>> = {},
) {
  const token = new SignJWT(claims).setProtectedHeader({ alg: 'HS256' }).setIssuedAt().setExpirationTime(expiresIn)
  if (subject) token.setSubject(subject)
  return token.sign(secret)
}

/** The `location` the controller handed to `res.redirect`, already parsed. */
function redirectedTo(response: { redirect: jest.Mock }): URL {
  expect(response.redirect).toHaveBeenCalledTimes(1)
  const [status, location] = response.redirect.mock.calls[0]
  expect(status).toBe(302)
  return new URL(location)
}

/** Run the start leg and hand back the authorize URL it produced. */
async function started(controller: AccountLinkController, response: { redirect: jest.Mock }) {
  await controller.start(await actionToken(), 'tx-1', response as any)
  const authorize = redirectedTo(response)
  response.redirect.mockClear()
  return authorize
}

describe('readAccountLinkSession', () => {
  it('names the missing claim so a malformed Action is diagnosable', () => {
    const { email: _email, ...noEmail } = SESSION_CLAIMS
    const { connection: _connection, ...noConnection } = SESSION_CLAIMS
    expect(() => readAccountLinkSession(SESSION_CLAIMS)).toThrow('carries no subject')
    expect(() => readAccountLinkSession({ sub: SOCIAL_USER_ID, ...noEmail })).toThrow('carries no email')
    expect(() => readAccountLinkSession({ sub: SOCIAL_USER_ID, ...noConnection })).toThrow('no database connection')
  })

  it('accepts a callback only at the one path this API serves it', () => {
    expect(() =>
      readAccountLinkSession({
        sub: SOCIAL_USER_ID,
        ...SESSION_CLAIMS,
        callback: 'https://api.dev.boxlite.ai/elsewhere',
      }),
    ).toThrow('no account link callback')
  })

  it('trims the address the second sign-in will be pinned to', () => {
    expect(readAccountLinkSession({ sub: SOCIAL_USER_ID, ...SESSION_CLAIMS, email: '  ada@example.com  ' })).toEqual({
      socialUserId: SOCIAL_USER_ID,
      email: 'ada@example.com',
      connection: DB_CONNECTION,
      callbackUrl: CALLBACK_URL,
    })
  })
})

describe('buildSecondAuthorizeUrl', () => {
  it('escapes an address whose plus sign would otherwise decode as a space', () => {
    const url = new URL(
      buildSecondAuthorizeUrl({
        authorizeUrl: `${TENANT}/authorize`,
        clientId: SPA_CLIENT,
        session: {
          socialUserId: SOCIAL_USER_ID,
          email: 'ada+boxlite@example.com',
          connection: DB_CONNECTION,
          callbackUrl: CALLBACK_URL,
        },
        state: 'state-value',
        codeChallenge: 'challenge',
        signUp: false,
      }),
    )

    expect(url.searchParams.get('login_hint')).toBe('ada+boxlite@example.com')
    expect(url.search).toContain('login_hint=ada%2Bboxlite%40example.com')
  })
})

describe('AccountLinkController.start', () => {
  it('is invisible on a deployment that has not enabled account linking', async () => {
    const { controller, response } = makeController({ 'oidc.accountLink.enabled': false })

    await expect(controller.start(await actionToken(), 'tx-1', response as any)).rejects.toBeInstanceOf(
      NotFoundException,
    )
    expect(response.redirect).not.toHaveBeenCalled()
  })

  it('refuses a request Auth0 did not attach a transaction state to', async () => {
    const { controller, response } = makeController()

    await expect(controller.start(await actionToken(), undefined, response as any)).rejects.toBeInstanceOf(
      BadRequestException,
    )
    expect(response.redirect).not.toHaveBeenCalled()
  })

  it.each([
    ['signed with another secret', () => actionToken(undefined, { secret: new TextEncoder().encode('other-secret') })],
    ['already expired', () => actionToken(undefined, { expiresIn: '-1s' })],
    ['carrying no email', () => actionToken({ connection: DB_CONNECTION, callback: CALLBACK_URL })],
    ['carrying no subject', () => actionToken(undefined, { subject: '' })],
    [
      'pointing the tenant somewhere else',
      () => actionToken({ ...SESSION_CLAIMS, callback: 'https://evil.example/x' }),
    ],
    ['not a token at all', async () => 'not-a-jwt'],
  ])('refuses a session token %s', async (_case, token) => {
    const { controller, response } = makeController()

    await expect(controller.start(await token(), 'tx-1', response as any)).rejects.toBeInstanceOf(BadRequestException)
    expect(response.redirect).not.toHaveBeenCalled()
  })

  it('forces a fresh password sign-in through the dashboard client when the address has a password account', async () => {
    const { controller, response } = makeController()

    const url = await started(controller, response)

    expect(`${url.origin}${url.pathname}`).toBe(`${TENANT}/authorize`)
    expect(Object.fromEntries(url.searchParams)).toMatchObject({
      client_id: SPA_CLIENT,
      response_type: 'code',
      redirect_uri: CALLBACK_URL,
      connection: DB_CONNECTION,
      // Without prompt=login the tenant would answer from the cookie the social
      // login just set, and never ask for the password this flow exists to check.
      prompt: 'login',
      login_hint: 'ada@example.com',
      code_challenge_method: 'S256',
    })
    expect(url.searchParams.has('screen_hint')).toBe(false)
  })

  it('opens the tenant sign-up when no password account holds the address', async () => {
    const { controller, auth0Management, response } = makeController()
    // The social identity itself holds the address, but it is not the database
    // connection, so it is no account to sign in to.
    auth0Management.usersByEmail.mockResolvedValue([
      {
        user_id: SOCIAL_USER_ID,
        identities: [{ provider: 'google-oauth2', user_id: '103', connection: 'google-oauth2' }],
      },
    ])

    expect((await started(controller, response)).searchParams.get('screen_hint')).toBe('signup')
  })

  it('carries nothing the browser can read in its state', async () => {
    const { controller, response } = makeController()

    const state = (await started(controller, response)).searchParams.get('state') as string

    // Five dot-separated parts is a JWE: the verifier and the social identity
    // travel encrypted, and even the shared secret itself cannot verify it as
    // a signed token.
    expect(state.split('.')).toHaveLength(5)
    await expect(jwtVerify(state, SECRET)).rejects.toThrow()
  })
})
