/*
 * Copyright 2026 BoxLite AI
 * SPDX-License-Identifier: AGPL-3.0
 */

jest.mock('uuid', () => ({ v4: jest.fn(() => 'mock-uuid'), validate: jest.fn(() => true) }))

import { ValidationPipe, type INestApplication } from '@nestjs/common'
import { Test } from '@nestjs/testing'
import { getRedisConnectionToken } from '@nestjs-modules/ioredis'
import type { AddressInfo } from 'net'
import { CombinedAuthGuard } from '../auth/combined-auth.guard'
import { AuthenticatedRateLimitGuard } from '../common/guards/authenticated-rate-limit.guard'
import { OrganizationMemberRole } from '../organization/enums/organization-member-role.enum'
import { OrganizationResourcePermission as Permission } from '../organization/enums/organization-resource-permission.enum'
import { OrganizationResourceActionGuard } from '../organization/guards/organization-resource-action.guard'
import { OrganizationService } from '../organization/services/organization.service'
import { OrganizationUserService } from '../organization/services/organization-user.service'
import { SystemRole } from '../user/enums/system-role.enum'
import { ApiKeyController } from './api-key.controller'
import { ApiKeyService } from './api-key.service'

describe('API key delegation', () => {
  let app: INestApplication
  let principal: Record<string, unknown>
  let membership: { role: OrganizationMemberRole; assignedRoles: { permissions: Permission[] }[] }
  const createApiKey = jest.fn(async (_org: string, _user: string, name: string, permissions: Permission[]) => ({
    apiKey: { name, permissions, createdAt: new Date(), keyPrefix: 'blk_test', keySuffix: '123' },
    value: 'test-key',
  }))

  beforeAll(async () => {
    const moduleRef = await Test.createTestingModule({
      controllers: [ApiKeyController],
      providers: [
        OrganizationResourceActionGuard,
        { provide: ApiKeyService, useValue: { createApiKey } },
        { provide: OrganizationService, useValue: { findOne: async (id: string) => ({ id }) } },
        { provide: OrganizationUserService, useValue: { findOne: async () => membership } },
        { provide: getRedisConnectionToken(), useValue: { get: async () => null, set: async () => 'OK' } },
      ],
    })
      .overrideGuard(CombinedAuthGuard)
      .useValue({
        canActivate: (context: any) => {
          context.switchToHttp().getRequest().user = { ...principal }
          return true
        },
      })
      .overrideGuard(AuthenticatedRateLimitGuard)
      .useValue({ canActivate: () => true })
      .compile()
    app = moduleRef.createNestApplication()
    app.useGlobalPipes(new ValidationPipe({ transform: true }))
    await app.listen(0)
  })

  afterAll(async () => app?.close())

  beforeEach(() => {
    jest.clearAllMocks()
    membership = { role: OrganizationMemberRole.OWNER, assignedRoles: [] }
    principal = {
      userId: 'owner-1',
      organizationId: 'org-1',
      role: SystemRole.USER,
      apiKey: { organizationId: 'org-1', permissions: [Permission.WRITE_BOXES] },
    }
  })

  async function create(permissions: Permission[]) {
    const address = app.getHttpServer().address() as AddressInfo
    return fetch(`http://127.0.0.1:${address.port}/api-keys`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ name: 'delegated-key', permissions }),
    })
  }

  it.each([SystemRole.USER, SystemRole.ADMIN])(
    'refuses scope expansion by a %s key before persistence',
    async (role) => {
      principal.role = role

      expect((await create([Permission.DELETE_BOXES])).status).toBe(403)
      expect(createApiKey).not.toHaveBeenCalled()
    },
  )

  it('refuses expansion by an empty key', async () => {
    principal.apiKey = { organizationId: 'org-1', permissions: [] }

    expect((await create([Permission.WRITE_BOXES])).status).toBe(403)
    expect(createApiKey).not.toHaveBeenCalled()
  })

  it('refuses expansion by a legacy key with no permissions array', async () => {
    principal.apiKey = { organizationId: 'org-1' }

    expect((await create([Permission.WRITE_BOXES])).status).toBe(403)
    expect(createApiKey).not.toHaveBeenCalled()
  })

  it.each([{ permissions: [] }, { permissions: [Permission.WRITE_BOXES] }])(
    'allows a permission subset $permissions',
    async ({ permissions }) => {
      expect((await create(permissions)).status).toBe(201)
      expect(createApiKey).toHaveBeenCalledWith('org-1', 'owner-1', 'delegated-key', permissions, undefined)
    },
  )

  it('preserves owner JWT grants', async () => {
    delete principal.apiKey

    expect((await create([Permission.DELETE_BOXES])).status).toBe(201)
  })

  it('still bounds a member by assigned role permissions', async () => {
    membership.role = OrganizationMemberRole.MEMBER

    expect((await create([Permission.WRITE_BOXES])).status).toBe(403)
    expect(createApiKey).not.toHaveBeenCalled()
  })

  it('allows a member grant only when both the key and assigned role hold it', async () => {
    membership = {
      role: OrganizationMemberRole.MEMBER,
      assignedRoles: [{ permissions: [Permission.WRITE_BOXES] }],
    }

    expect((await create([Permission.WRITE_BOXES])).status).toBe(201)
  })
})
