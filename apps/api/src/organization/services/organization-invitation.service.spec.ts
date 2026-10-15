/*
 * Copyright 2026 BoxLite AI
 * SPDX-License-Identifier: AGPL-3.0
 */

import { OrganizationInvitationService } from './organization-invitation.service'
import { OrganizationInvitationStatus } from '../enums/organization-invitation-status.enum'
import { ConfigService } from '@nestjs/config'
import { OrganizationInvitation } from '../entities/organization-invitation.entity'
import { OrganizationEvents } from '../constants/organization-events.constant'

// A script must tell a stale invitation (409) from a missing owner role (403).
describe('OrganizationInvitationService state errors', () => {
  function serviceFor(invitation: { status: OrganizationInvitationStatus; expiresAt: Date }) {
    const repository = { findOne: jest.fn(async () => invitation), save: jest.fn() }
    const service = new OrganizationInvitationService(
      repository as never,
      {} as never,
      {} as never,
      {} as never,
      {} as never,
      {} as never,
      {} as never,
      {} as never,
    )
    return { service, repository }
  }

  const staleInvitations = [
    ['no longer pending', OrganizationInvitationStatus.ACCEPTED, 60_000],
    ['expired', OrganizationInvitationStatus.PENDING, -60_000],
  ] as const

  it.each(staleInvitations)('answers 409 when cancelling an invitation that is %s', async (_, status, expiresInMs) => {
    const { service, repository } = serviceFor({ status, expiresAt: new Date(Date.now() + expiresInMs) })

    await expect(service.cancel('org-1', 'inv-1')).rejects.toMatchObject({ status: 409 })
    expect(repository.save).not.toHaveBeenCalled()
  })

  it.each(staleInvitations)('answers 409 when updating an invitation that is %s', async (_, status, expiresInMs) => {
    const { service, repository } = serviceFor({ status, expiresAt: new Date(Date.now() + expiresInMs) })

    await expect(service.update('org-1', 'inv-1', { assignedRoleIds: [] } as never)).rejects.toMatchObject({
      status: 409,
    })
    expect(repository.save).not.toHaveBeenCalled()
  })
})

describe('OrganizationInvitationService lifetime', () => {
  beforeEach(() => jest.useFakeTimers().setSystemTime(new Date('2026-10-15T12:00:00Z')))
  afterEach(() => jest.useRealTimers())

  function createService() {
    const repository = {
      findOne: jest.fn(async () => null),
      save: jest.fn(async (value: OrganizationInvitation) => value),
    }
    const events = { emit: jest.fn() }
    const service = new OrganizationInvitationService(
      repository as never,
      { findOne: async () => ({ id: 'org-1', name: 'Acme' }) } as never,
      {} as never,
      { findByIds: async () => [] } as never,
      { findOneByEmail: async () => null } as never,
      events as never,
      {} as never,
      new ConfigService({ organizationInvitation: { ttlSeconds: 3600 } }),
    )
    return { service, repository, events }
  }

  it('stores the configured deadline and sends that same deadline to the mail event', async () => {
    const { service, repository, events } = createService()
    await service.create(
      'org-1',
      { email: 'invitee@example.com', role: 'owner', assignedRoleIds: [] } as never,
      'owner@example.com',
    )
    const expiresAt = new Date('2026-10-15T13:00:00Z')
    expect(repository.save).toHaveBeenCalledWith(expect.objectContaining({ expiresAt }))
    expect(events.emit).toHaveBeenCalledWith(
      OrganizationEvents.INVITATION_CREATED,
      expect.objectContaining({ expiresAt }),
    )
  })

  it('preserves an explicit API deadline', async () => {
    const { service, repository } = createService()
    const expiresAt = new Date('2026-10-16T12:00:00Z')
    await service.create(
      'org-1',
      { email: 'invitee@example.com', role: 'owner', assignedRoleIds: [], expiresAt } as never,
      'owner@example.com',
    )
    expect(repository.save).toHaveBeenCalledWith(expect.objectContaining({ expiresAt }))
  })
})
