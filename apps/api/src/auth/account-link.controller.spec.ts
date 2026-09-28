/*
 * Copyright 2026 BoxLite AI
 * SPDX-License-Identifier: AGPL-3.0
 */

import { BadRequestException, NotFoundException } from '@nestjs/common'
import { SignJWT, jwtVerify } from 'jose'
import { AccountLinkController, buildSecondAuthorizeUrl, readAccountLinkSession } from './account-link.controller'

const REDIRECT_SECRET = 'redirect-secret-value'
const SECRET = new TextEncoder().encode(REDIRECT_SECRET)
const AUTHORIZE_URL = 'https://auth.dev.boxlite.ai/authorize'
const REDIRECT_URI = 'https://api.dev.boxlite.ai/api/auth/link/callback'
const DB_CONNECTION = 'Username-Password-Authentication'
const SOCIAL_USER_ID = 'google-oauth2|103'

function makeController(overrides: Record<string, unknown> = {}) {
  const values: Record<string, unknown> = {
    'oidc.accountLink.enabled': true,
    'oidc.accountLink.redirectSecret': REDIRECT_SECRET,
    'oidc.accountLink.authorizeUrl': AUTHORIZE_URL,
    'oidc.accountLink.clientId': 'link-client',
    'oidc.accountLink.redirectUri': REDIRECT_URI,
    'oidc.accountLink.databaseConnection': DB_CONNECTION,
    ...overrides,
  }
  const configService = {
    get: jest.fn((key: string) => values[key]),
    getOrThrow: jest.fn((key: string) => {
      if (values[key] === undefined) throw new Error(`account-link.controller.spec: unexpected config key "${key}"`)
      return values[key]
    }),
  }
  const response = { redirect: jest.fn() }
  return { controller: new AccountLinkController(configService as any), response }
}

function actionToken(
  claims: Record<string, unknown> = { email: 'ada@example.com' },
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

describe('readAccountLinkSession', () => {
  it('names the missing claim so a malformed Action is diagnosable', () => {
    expect(() => readAccountLinkSession({ email: 'ada@example.com' })).toThrow('carries no subject')
    expect(() => readAccountLinkSession({ sub: SOCIAL_USER_ID })).toThrow('carries no email')
  })

  it('rejects an email that is not a string, rather than coercing it', () => {
    expect(() => readAccountLinkSession({ sub: SOCIAL_USER_ID, email: 42 })).toThrow('carries no email')
  })

  it('trims the address the second sign-in will be pinned to', () => {
    expect(readAccountLinkSession({ sub: SOCIAL_USER_ID, email: '  ada@example.com  ' })).toEqual({
      socialUserId: SOCIAL_USER_ID,
      email: 'ada@example.com',
    })
  })
})

describe('buildSecondAuthorizeUrl', () => {
  it('escapes an address whose plus sign would otherwise decode as a space', () => {
    const url = new URL(
      buildSecondAuthorizeUrl({
        authorizeUrl: AUTHORIZE_URL,
        clientId: 'link-client',
        redirectUri: REDIRECT_URI,
        connection: DB_CONNECTION,
        email: 'ada+boxlite@example.com',
        state: 'state-value',
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
    ['carrying no email', () => actionToken({})],
    ['carrying no subject', () => actionToken(undefined, { subject: '' })],
    ['not a token at all', async () => 'not-a-jwt'],
  ])('refuses a session token %s', async (_case, token) => {
    const { controller, response } = makeController()

    await expect(controller.start(await token(), 'tx-1', response as any)).rejects.toBeInstanceOf(BadRequestException)
    expect(response.redirect).not.toHaveBeenCalled()
  })

  it('forces a fresh password sign-in against the database connection', async () => {
    const { controller, response } = makeController()

    await controller.start(await actionToken({ email: 'ada@example.com' }), 'tx-1', response as any)

    const url = redirectedTo(response)
    expect(`${url.origin}${url.pathname}`).toBe(AUTHORIZE_URL)
    expect(Object.fromEntries(url.searchParams)).toMatchObject({
      client_id: 'link-client',
      response_type: 'code',
      redirect_uri: REDIRECT_URI,
      connection: DB_CONNECTION,
      // Without prompt=login the tenant would answer from the cookie the social
      // login just set, and never ask for the password this flow exists to check.
      prompt: 'login',
      login_hint: 'ada@example.com',
    })
  })

  it('carries the Auth0 transaction and the social identity through its own signed state', async () => {
    const { controller, response } = makeController()

    await controller.start(await actionToken({ email: 'ada@example.com' }), 'tx-1', response as any)

    const state = redirectedTo(response).searchParams.get('state')
    const { payload } = await jwtVerify(state as string, SECRET, { algorithms: ['HS256'] })
    expect(payload).toMatchObject({ tx: 'tx-1', sub: SOCIAL_USER_ID, email: 'ada@example.com' })
    expect(payload.exp).toBeGreaterThan(payload.iat as number)
  })
})
