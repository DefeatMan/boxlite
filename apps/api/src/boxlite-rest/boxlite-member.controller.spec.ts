/*
 * Copyright 2026 BoxLite AI
 * SPDX-License-Identifier: AGPL-3.0
 */

jest.mock('uuid', () => ({ v4: jest.fn(() => 'mock-uuid'), validate: jest.fn(() => true) }))

import { ValidationPipe, type INestApplication } from '@nestjs/common'
import { Test } from '@nestjs/testing'
import { getRedisConnectionToken } from '@nestjs-modules/ioredis'
import Ajv2020 from 'ajv/dist/2020'
import addFormats from 'ajv-formats'
import type { AddressInfo } from 'net'
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { QueryFailedError } from 'typeorm'
import { parse } from 'yaml'
import { CombinedAuthGuard } from '../auth/combined-auth.guard'
import { AuthenticatedRateLimitGuard } from '../common/guards/authenticated-rate-limit.guard'
import { OrganizationUserDto } from '../organization/dto/organization-user.dto'
import { OrganizationUser } from '../organization/entities/organization-user.entity'
import { OrganizationMemberRole } from '../organization/enums/organization-member-role.enum'
import { OrganizationInvitationStatus } from '../organization/enums/organization-invitation-status.enum'
import { OrganizationActionGuard } from '../organization/guards/organization-action.guard'
import { OrganizationInvitationService } from '../organization/services/organization-invitation.service'
import { OrganizationService } from '../organization/services/organization.service'
import { OrganizationUserService } from '../organization/services/organization-user.service'
import { SystemRole } from '../user/enums/system-role.enum'
import { User } from '../user/user.entity'
import { BoxliteInvitationController } from './boxlite-invitation.controller'
import { BoxliteMemberController } from './boxlite-member.controller'

// org-1 has an owner (user-1) and a plain member (user-3); user-2 belongs to org-2 only.
const memberships = new Map([
  ['org-1:user-1', { organizationId: 'org-1', userId: 'user-1', role: OrganizationMemberRole.OWNER }],
  ['org-1:user-3', { organizationId: 'org-1', userId: 'user-3', role: OrganizationMemberRole.MEMBER }],
  ['org-2:user-2', { organizationId: 'org-2', userId: 'user-2', role: OrganizationMemberRole.OWNER }],
])

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i
const tenant = parse(readFileSync(resolve(__dirname, '../../../../openapi/tenant.openapi.yaml'), 'utf8'))
const tenantId = 'https://contract.test/tenant.openapi.yaml'
const ajv = addFormats(new Ajv2020({ strict: false, allErrors: true }))
ajv.addSchema({ components: tenant.components, paths: tenant.paths }, tenantId)

async function expectTenantResponse(response: Response, path: string, method: string, status: number) {
  expect(response.status).toBe(status)
  const contract = tenant.paths[path]?.[method.toLowerCase()]?.responses[status]
  expect(contract).toBeDefined()
  if (status === 204) {
    expect(contract.content).toBeUndefined()
    expect(await response.text()).toBe('')
    return
  }
  const pointer = path.replace(/~/g, '~0').replace(/\//g, '~1')
  const validate = ajv.getSchema(
    `${tenantId}#/paths/${pointer}/${method.toLowerCase()}/responses/${status}/content/application~1json/schema`,
  )
  if (!validate) throw new Error(`Missing Tenant API success schema: ${method} ${path} ${status}`)
  const body = await response.json()
  expect(validate(body) ? [] : validate.errors).toEqual([])
  return body
}

// An API-key principal, as ApiKeyStrategy builds it: the key names its organization.
function apiKeyPrincipal(
  userId: string,
  organizationId: string,
  permissions: string[] = ['read:tenant', 'write:tenant'],
) {
  return {
    userId,
    email: `${userId}@example.com`,
    role: SystemRole.USER,
    organizationId,
    apiKey: { organizationId, permissions },
  }
}

describe('BoxLite REST members and invitations', () => {
  let app: INestApplication
  let principal: Record<string, unknown>
  const organizationUserService = {
    findOne: jest.fn(async (organizationId: string, userId: string) => memberships.get(`${organizationId}:${userId}`)),
    findAll: jest.fn(async () => [
      {
        userId: 'user-1',
        email: 'owner@example.com',
        name: 'Owner',
        role: OrganizationMemberRole.OWNER,
        createdAt: new Date('2026-09-01T00:00:00.000Z'),
      },
    ]),
    delete: jest.fn(async () => undefined),
  }
  const invitation = {
    id: 'inv-1',
    email: 'new@example.com',
    status: OrganizationInvitationStatus.PENDING,
    invitedBy: 'user-1@example.com',
    createdAt: new Date('2026-09-02T00:00:00.000Z'),
    expiresAt: new Date('2026-09-09T00:00:00.000Z'),
  }
  const organizationInvitationService = {
    create: jest.fn(async () => invitation),
    findPending: jest.fn(async () => [invitation]),
    // The invitation id column is a uuid, and Postgres answers any other string
    // with a cast error rather than a miss.
    cancel: jest.fn(async (_organizationId: string, invitationId: string) => {
      if (!UUID.test(invitationId)) {
        throw new QueryFailedError('SELECT', [invitationId], new Error('invalid input syntax for type uuid'))
      }
    }),
  }

  beforeAll(async () => {
    const moduleRef = await Test.createTestingModule({
      controllers: [BoxliteMemberController, BoxliteInvitationController],
      providers: [
        OrganizationActionGuard,
        { provide: OrganizationUserService, useValue: organizationUserService },
        { provide: OrganizationInvitationService, useValue: organizationInvitationService },
        { provide: OrganizationService, useValue: { findOne: async (id: string) => ({ id }) } },
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
    app.setGlobalPrefix('api')
    app.useGlobalPipes(new ValidationPipe({ transform: true }))
    await app.listen(0)
  })

  afterAll(async () => {
    await app?.close()
  })

  beforeEach(() => {
    jest.clearAllMocks()
  })

  async function call(method: string, path: string, body?: unknown): Promise<Response> {
    const address = app.getHttpServer().address() as AddressInfo
    return fetch(`http://127.0.0.1:${address.port}/api${path}`, {
      method,
      headers: body ? { 'content-type': 'application/json' } : undefined,
      body: body ? JSON.stringify(body) : undefined,
    })
  }

  const operations = [
    { method: 'GET', path: '/members', scope: 'read:tenant', status: 200 },
    { method: 'GET', path: '/invitations', scope: 'read:tenant', status: 200 },
    { method: 'POST', path: '/invitations', scope: 'write:tenant', status: 201 },
    {
      method: 'DELETE',
      path: '/members/user-3',
      schemaPath: '/members/{user_id}',
      scope: 'write:tenant',
      status: 204,
    },
    {
      method: 'DELETE',
      path: '/invitations/6f1c2a4e-0b7d-4c3e-9a5f-2d8e1b7c4a90',
      schemaPath: '/invitations/{invitation_id}',
      scope: 'write:tenant',
      status: 204,
    },
  ]

  function callTenant(method: string, path: string) {
    return call(method, path, method === 'POST' ? { email: 'new@example.com' } : undefined)
  }

  function expectNoTenantServiceCalls() {
    expect(organizationUserService.findAll).not.toHaveBeenCalled()
    expect(organizationUserService.delete).not.toHaveBeenCalled()
    expect(organizationInvitationService.findPending).not.toHaveBeenCalled()
    expect(organizationInvitationService.create).not.toHaveBeenCalled()
    expect(organizationInvitationService.cancel).not.toHaveBeenCalled()
  }

  describe.each(['/v1', '/v1/default', '/v1/org-1'])('tenant key scopes on %s', (prefix) => {
    it.each(operations)('refuses an unscoped owner key for $method $path', async ({ method, path }) => {
      principal = apiKeyPrincipal('user-1', 'org-1', [])

      expect((await callTenant(method, `${prefix}${path}`)).status).toBe(403)
      expectNoTenantServiceCalls()
    })

    it.each(operations)('refuses a box-only key for $method $path', async ({ method, path }) => {
      principal = apiKeyPrincipal('user-1', 'org-1', ['write:boxes', 'delete:boxes'])

      expect((await callTenant(method, `${prefix}${path}`)).status).toBe(403)
      expectNoTenantServiceCalls()
    })

    it.each(operations)(
      'keeps tenant read and write independent for $method $path',
      async ({ method, path, scope }) => {
        principal = apiKeyPrincipal('user-1', 'org-1', [scope === 'read:tenant' ? 'write:tenant' : 'read:tenant'])

        expect((await callTenant(method, `${prefix}${path}`)).status).toBe(403)
        expectNoTenantServiceCalls()
      },
    )

    it.each(operations)(
      'allows an explicitly scoped owner key for $method $path',
      async ({ method, path, schemaPath, scope, status }) => {
        principal = apiKeyPrincipal('user-1', 'org-1', [scope])

        const response = await callTenant(method, `${prefix}${path}`)
        const contractPath = `${prefix === '/v1' ? '' : '/{prefix}'}${schemaPath ?? path}`
        await expectTenantResponse(response, contractPath, method, status)
      },
    )

    it.each(['missing email', 'missing user'])('returns a schema-valid member with %s', async (missing) => {
      principal = apiKeyPrincipal('user-1', 'org-1')
      const membership = Object.assign(new OrganizationUser(), {
        userId: 'user-1',
        organizationId: 'org-1',
        role: OrganizationMemberRole.OWNER,
        assignedRoles: [],
        createdAt: new Date('2026-09-01T00:00:00.000Z'),
      })
      const user = missing === 'missing user' ? undefined : Object.assign(new User(), { email: '', name: 'Owner' })
      organizationUserService.findAll.mockResolvedValueOnce([OrganizationUserDto.fromEntities(membership, user)])

      const response = await call('GET', `${prefix}/members`)
      const contractPath = `${prefix === '/v1' ? '' : '/{prefix}'}/members`
      const body = await expectTenantResponse(response, contractPath, 'GET', 200)
      expect(body.members[0].email).toBeNull()
    })
  })

  it.each(operations)('bounds an admin API key for $method $path', async ({ method, path }) => {
    principal = { ...apiKeyPrincipal('user-1', 'org-1', []), role: SystemRole.ADMIN }

    expect((await callTenant(method, `/v1/org-1${path}`)).status).toBe(403)
    expectNoTenantServiceCalls()
  })

  it.each(operations)('preserves owner JWT access for $method $path', async ({ method, path, status }) => {
    principal = apiKeyPrincipal('user-1', 'org-1')
    delete principal.apiKey

    expect((await callTenant(method, `/v1/org-1${path}`)).status).toBe(status)
  })

  it.each(operations.filter(({ method }) => method === 'GET'))(
    'preserves member JWT access for $path',
    async ({ path }) => {
      principal = apiKeyPrincipal('user-3', 'org-1')
      delete principal.apiKey

      expect((await call('GET', `/v1/org-1${path}`)).status).toBe(200)
    },
  )

  it.each(operations)('refuses scoped keys from another organization for $method $path', async ({ method, path }) => {
    principal = apiKeyPrincipal('user-2', 'org-2')

    expect((await callTenant(method, `/v1/org-1${path}`)).status).toBe(403)
    expectNoTenantServiceCalls()
  })

  it('refuses a legacy key with no permissions field', async () => {
    principal = { ...apiKeyPrincipal('user-1', 'org-1'), apiKey: { organizationId: 'org-1' } }

    expect((await call('GET', '/v1/members')).status).toBe(403)
    expectNoTenantServiceCalls()
  })

  it.each(['runner', 'proxy', 'health-check'])('refuses %s credentials on tenant routes', async (role) => {
    principal = { role }

    expect((await call('GET', '/v1/org-1/members')).status).toBe(403)
    expectNoTenantServiceCalls()
  })

  it("lets an owner's explicitly scoped API key remove a member", async () => {
    principal = apiKeyPrincipal('user-1', 'org-1')

    const response = await call('DELETE', '/v1/org-1/members/user-3')

    expect(response.status).toBe(204)
    expect(organizationUserService.delete).toHaveBeenCalledWith('org-1', 'user-3')
  })

  it('refuses member removal to a caller without the owner role', async () => {
    principal = apiKeyPrincipal('user-3', 'org-1')

    const response = await call('DELETE', '/v1/org-1/members/user-1')

    expect(response.status).toBe(403)
    expect(organizationUserService.delete).not.toHaveBeenCalled()
  })

  it("refuses an API key acting on another organization's members", async () => {
    principal = apiKeyPrincipal('user-2', 'org-2')

    const response = await call('DELETE', '/v1/org-1/members/user-3')

    expect(response.status).toBe(403)
    expect(organizationUserService.delete).not.toHaveBeenCalled()
  })

  it("lists the key's organization members on the canonical route", async () => {
    principal = apiKeyPrincipal('user-3', 'org-1')

    const response = await call('GET', '/v1/members')

    expect(response.status).toBe(200)
    expect(await response.json()).toEqual({
      members: [
        {
          user_id: 'user-1',
          email: 'owner@example.com',
          name: 'Owner',
          role: 'owner',
          joined_at: '2026-09-01T00:00:00.000Z',
        },
      ],
    })
    expect(organizationUserService.findAll).toHaveBeenCalledWith('org-1')
  })

  it('invites by email with the owner role and returns the pending invitation', async () => {
    principal = apiKeyPrincipal('user-1', 'org-1')

    const response = await call('POST', '/v1/org-1/invitations', { email: 'new@example.com' })

    expect(response.status).toBe(201)
    expect(await response.json()).toEqual({
      id: 'inv-1',
      email: 'new@example.com',
      status: 'pending',
      invited_by: 'user-1@example.com',
      created_at: '2026-09-02T00:00:00.000Z',
      expires_at: '2026-09-09T00:00:00.000Z',
    })
    expect(organizationInvitationService.create).toHaveBeenCalledWith(
      'org-1',
      { email: 'new@example.com', role: OrganizationMemberRole.OWNER, assignedRoleIds: [], expiresAt: undefined },
      'user-1@example.com',
    )
  })

  it('passes a requested expiry to the service as a date', async () => {
    principal = apiKeyPrincipal('user-1', 'org-1')

    const response = await call('POST', '/v1/org-1/invitations', {
      email: 'new@example.com',
      expires_at: '2099-10-01T00:00:00.000Z',
    })

    expect(response.status).toBe(201)
    expect(organizationInvitationService.create).toHaveBeenCalledWith(
      'org-1',
      {
        email: 'new@example.com',
        role: OrganizationMemberRole.OWNER,
        assignedRoleIds: [],
        expiresAt: new Date('2099-10-01T00:00:00.000Z'),
      },
      'user-1@example.com',
    )
  })

  it('lists pending invitations to any member of the organization', async () => {
    principal = apiKeyPrincipal('user-3', 'org-1')

    const response = await call('GET', '/v1/org-1/invitations')

    expect(response.status).toBe(200)
    expect(await response.json()).toEqual({
      invitations: [
        {
          id: 'inv-1',
          email: 'new@example.com',
          status: 'pending',
          invited_by: 'user-1@example.com',
          created_at: '2026-09-02T00:00:00.000Z',
          expires_at: '2026-09-09T00:00:00.000Z',
        },
      ],
    })
    expect(organizationInvitationService.findPending).toHaveBeenCalledWith('org-1')
  })

  it('rejects an invitation without a valid email before reaching the service', async () => {
    principal = apiKeyPrincipal('user-1', 'org-1')

    const response = await call('POST', '/v1/org-1/invitations', { email: 'not-an-email' })

    expect(response.status).toBe(400)
    expect(organizationInvitationService.create).not.toHaveBeenCalled()
  })

  it('refuses an invitation from a caller without the owner role', async () => {
    principal = apiKeyPrincipal('user-3', 'org-1')

    expect((await call('POST', '/v1/org-1/invitations', { email: 'new@example.com' })).status).toBe(403)
    expect(organizationInvitationService.create).not.toHaveBeenCalled()
  })

  it('lets an owner cancel a pending invitation, and refuses a plain member', async () => {
    const invitationId = '6f1c2a4e-0b7d-4c3e-9a5f-2d8e1b7c4a90'
    principal = apiKeyPrincipal('user-1', 'org-1')
    expect((await call('DELETE', `/v1/org-1/invitations/${invitationId}`)).status).toBe(204)
    expect(organizationInvitationService.cancel).toHaveBeenCalledWith('org-1', invitationId)

    principal = apiKeyPrincipal('user-3', 'org-1')
    expect((await call('DELETE', `/v1/org-1/invitations/${invitationId}`)).status).toBe(403)
    expect(organizationInvitationService.cancel).toHaveBeenCalledTimes(1)
  })

  it('answers 404 for an invitation id that is not a UUID', async () => {
    principal = apiKeyPrincipal('user-1', 'org-1')

    expect((await call('DELETE', '/v1/org-1/invitations/not-a-uuid')).status).toBe(404)
  })

  it('rejects invitation fields the contract does not define', async () => {
    principal = apiKeyPrincipal('user-1', 'org-1')

    const response = await call('POST', '/v1/org-1/invitations', { email: 'new@example.com', role: 'member' })

    expect(response.status).toBe(400)
    expect(organizationInvitationService.create).not.toHaveBeenCalled()
  })

  it('rejects an invitation that would already be expired', async () => {
    principal = apiKeyPrincipal('user-1', 'org-1')

    const response = await call('POST', '/v1/org-1/invitations', {
      email: 'new@example.com',
      expires_at: '2020-01-01T00:00:00.000Z',
    })

    expect(response.status).toBe(400)
    expect(organizationInvitationService.create).not.toHaveBeenCalled()
  })
})
