/*
 * Copyright 2026 BoxLite AI
 * SPDX-License-Identifier: AGPL-3.0
 */

import { createHash, hkdfSync, randomBytes } from 'node:crypto'
import { Injectable } from '@nestjs/common'
import { EncryptJWT, JWTPayload, jwtVerify } from 'jose'
import { TypedConfigService } from '../config/typed-config.service'
import { Auth0ManagementService } from '../user/auth0-management.service'

/** The one path the account link callback is served at. */
export const ACCOUNT_LINK_CALLBACK_PATH = '/api/auth/link/callback'

/**
 * What the Post-Login Action hands over when it interrupts a social login
 * (POL-555): who is signing in, the address they now have to prove they own,
 * and — from the values the tenant configurator deployed — which database
 * connection that proof happens on and where the tenant returns afterwards.
 */
export interface AccountLinkSession {
  socialUserId: string
  email: string
  connection: string
  callbackUrl: string
}

/**
 * How long the state minted at the start stays acceptable at the callback.
 *
 * It bounds one password entry, or one sign-up, on the tenant's own page. The
 * login transaction Auth0 holds open expires on a similar order, so a longer
 * window here would only keep a dead transaction alive.
 */
const LINK_STATE_TTL_SECONDS = 600

/**
 * Read the claims the Action signed.
 *
 * Read strictly: this payload decides which address the user is about to be
 * asked to authenticate against and where the tenant sends them afterwards, so
 * a missing or oddly-typed claim has to stop the flow rather than send them
 * somewhere half-specified.
 */
export function readAccountLinkSession(payload: JWTPayload): AccountLinkSession {
  const { sub: socialUserId, email, connection, callback } = payload
  if (typeof socialUserId !== 'string' || socialUserId.trim() === '') {
    throw new Error('session token carries no subject')
  }
  if (typeof email !== 'string' || email.trim() === '') {
    throw new Error('session token carries no email')
  }
  if (typeof connection !== 'string' || connection.trim() === '') {
    throw new Error('session token carries no database connection')
  }
  if (typeof callback !== 'string' || new URL(callback).pathname !== ACCOUNT_LINK_CALLBACK_PATH) {
    throw new Error('session token carries no account link callback')
  }
  return { socialUserId, email: email.trim(), connection, callbackUrl: callback }
}

/**
 * The login-time account link, on the API side.
 *
 * The controller only moves requests and redirects; every token this flow
 * mints or accepts, and every call it makes to the tenant, is here.
 *
 * One secret keys all of it. The session token the Action signs is HS256
 * under the secret itself, because that is all Auth0's `encodeToken` accepts.
 * The state only this service reads is encrypted instead — it carries the
 * PKCE verifier through the browser — under a key derived from the secret, so
 * signing and encryption never share key bytes.
 */
@Injectable()
export class AccountLinkService {
  constructor(
    private readonly configService: TypedConfigService,
    private readonly auth0Management: Auth0ManagementService,
  ) {}

  /** Verify the session token the Action sent the browser here with. */
  async readSession(sessionToken: string): Promise<AccountLinkSession> {
    const { payload } = await jwtVerify(sessionToken, this.signingKey(), { algorithms: ['HS256'] })
    return readAccountLinkSession(payload)
  }

  /**
   * Start a second sign-in that only this service can finish.
   *
   * The returned challenge goes to the tenant; the verifier stays inside the
   * encrypted state, which the browser carries but cannot open.
   */
  async beginSignIn(
    session: AccountLinkSession,
    transactionState: string,
  ): Promise<{ state: string; codeChallenge: string }> {
    const codeVerifier = randomBytes(32).toString('base64url')
    const state = await new EncryptJWT({
      tx: transactionState,
      email: session.email,
      connection: session.connection,
      callback: session.callbackUrl,
      cv: codeVerifier,
    })
      .setProtectedHeader({ alg: 'dir', enc: 'A256GCM' })
      .setSubject(session.socialUserId)
      .setIssuedAt()
      .setExpirationTime(`${LINK_STATE_TTL_SECONDS}s`)
      .encrypt(this.stateKey())
    return { state, codeChallenge: createHash('sha256').update(codeVerifier).digest('base64url') }
  }

  /**
   * Whether the address already has a password account to sign in to, or the
   * second sign-in has to create one.
   */
  async hasDatabaseAccount(session: AccountLinkSession): Promise<boolean> {
    const users = await this.auth0Management.usersByEmail(session.email)
    return users.some((user) => user.identities?.some((identity) => identity.connection === session.connection))
  }

  private signingKey(): Uint8Array {
    return new TextEncoder().encode(this.configService.getOrThrow('oidc.accountLink.redirectSecret'))
  }

  private stateKey(): Uint8Array {
    return new Uint8Array(
      hkdfSync(
        'sha256',
        this.configService.getOrThrow('oidc.accountLink.redirectSecret'),
        new Uint8Array(),
        'boxlite-account-link-state',
        32,
      ),
    )
  }
}
