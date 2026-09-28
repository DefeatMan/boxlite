/*
 * Copyright 2026 BoxLite AI
 * SPDX-License-Identifier: AGPL-3.0
 */

import { BadRequestException, Controller, Get, Logger, NotFoundException, Query, Res, UseGuards } from '@nestjs/common'
import { ApiExcludeController } from '@nestjs/swagger'
import { Response } from 'express'
import { JWTPayload, SignJWT, jwtVerify } from 'jose'
import { AnonymousRateLimitGuard } from '../common/guards/anonymous-rate-limit.guard'
import { TypedConfigService } from '../config/typed-config.service'

/**
 * What the Post-Login Action hands over when it interrupts a social login: who
 * is signing in, and the address they now have to prove they own by entering
 * that account's password (POL-555).
 */
export interface AccountLinkSession {
  socialUserId: string
  email: string
}

/**
 * How long the `state` this endpoint mints stays acceptable at the callback.
 *
 * It bounds one password entry on Auth0's own login page, not a user session.
 * The login transaction Auth0 is holding open expires on a similar order, so a
 * longer window here would only keep a dead transaction alive.
 */
const LINK_STATE_TTL_SECONDS = 600

/**
 * Read the claims the Action signed.
 *
 * Read strictly: this payload decides which address the user is about to be
 * asked to authenticate against, so a missing or oddly-typed claim has to stop
 * the flow rather than send them somewhere half-specified.
 */
export function readAccountLinkSession(payload: JWTPayload): AccountLinkSession {
  const socialUserId = payload.sub
  const email = payload.email
  if (typeof socialUserId !== 'string' || socialUserId.trim() === '') {
    throw new Error('session token carries no subject')
  }
  if (typeof email !== 'string' || email.trim() === '') {
    throw new Error('session token carries no email')
  }
  return { socialUserId, email: email.trim() }
}

/**
 * The second `/authorize` the user is sent through.
 *
 * `prompt=login` is what makes this an authentication rather than a silent
 * replay: without it the tenant would answer from the session cookie the social
 * login just set, and the link would be granted to whoever holds that cookie
 * instead of to whoever knows the password.
 *
 * `connection` pins the attempt to the database connection, so the social
 * buttons never render on that page and cannot satisfy it.
 */
export function buildSecondAuthorizeUrl(options: {
  authorizeUrl: string
  clientId: string
  redirectUri: string
  connection: string
  email: string
  state: string
}): string {
  const url = new URL(options.authorizeUrl)
  url.search = new URLSearchParams({
    client_id: options.clientId,
    response_type: 'code',
    redirect_uri: options.redirectUri,
    scope: 'openid email',
    connection: options.connection,
    prompt: 'login',
    login_hint: options.email,
    state: options.state,
  }).toString()
  return url.toString()
}

/**
 * Excluded from the OpenAPI document on purpose: these are browser redirects
 * Auth0 drives mid-login, never calls an SDK client makes.
 */
@ApiExcludeController()
@Controller('auth/link')
export class AccountLinkController {
  private readonly logger = new Logger(AccountLinkController.name)

  constructor(private readonly configService: TypedConfigService) {}

  /**
   * Where the Post-Login Action sends the browser.
   *
   * Auth0 appends `state` itself and expects the same value back when the
   * transaction resumes, so it travels through the second sign-in inside a
   * token this endpoint signs with the same shared secret.
   */
  @Get('start')
  @UseGuards(AnonymousRateLimitGuard)
  async start(
    @Query('session_token') sessionToken: string | undefined,
    @Query('state') transactionState: string | undefined,
    @Res() res: Response,
  ): Promise<void> {
    if (!this.configService.get('oidc.accountLink.enabled')) {
      throw new NotFoundException()
    }
    if (!transactionState) {
      throw new BadRequestException('Missing state')
    }

    const secret = new TextEncoder().encode(this.configService.getOrThrow('oidc.accountLink.redirectSecret'))

    let session: AccountLinkSession
    try {
      const { payload } = await jwtVerify(sessionToken ?? '', secret, { algorithms: ['HS256'] })
      session = readAccountLinkSession(payload)
    } catch (error) {
      // The token is the tenant's, not the user's, so there is nothing here for
      // them to correct; the reason goes to the log, not the response.
      this.logger.warn(`Rejected account link session token: ${error instanceof Error ? error.message : String(error)}`)
      throw new BadRequestException('Invalid account link session')
    }

    const state = await new SignJWT({ tx: transactionState, email: session.email })
      .setProtectedHeader({ alg: 'HS256' })
      .setSubject(session.socialUserId)
      .setIssuedAt()
      .setExpirationTime(`${LINK_STATE_TTL_SECONDS}s`)
      .sign(secret)

    res.redirect(
      302,
      buildSecondAuthorizeUrl({
        authorizeUrl: this.configService.getOrThrow('oidc.accountLink.authorizeUrl'),
        clientId: this.configService.getOrThrow('oidc.accountLink.clientId'),
        redirectUri: this.configService.getOrThrow('oidc.accountLink.redirectUri'),
        connection: this.configService.getOrThrow('oidc.accountLink.databaseConnection'),
        email: session.email,
        state,
      }),
    )
  }
}
