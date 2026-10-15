/*
 * Copyright 2025 Daytona Platforms Inc.
 * Modified by BoxLite AI, 2025-2026
 * SPDX-License-Identifier: AGPL-3.0
 */

import { PageContent, PageHeader, PageLayout, PageTitle } from '@/components/PageLayout'
import { UserOrganizationInvitationTable } from '@/components/UserOrganizationInvitations/UserOrganizationInvitationTable'
import { useApi } from '@/hooks/useApi'
import { useOrganizations } from '@/hooks/useOrganizations'
import { useSelectedOrganization } from '@/hooks/useSelectedOrganization'
import { useUserOrganizationInvitations } from '@/hooks/useUserOrganizationInvitations'
import { handleApiError } from '@/lib/error-handling'
import { OrganizationInvitation } from '@boxlite-ai/api-client'
import React, { useCallback, useEffect, useRef, useState } from 'react'
import { useSearchParams } from 'react-router-dom'
import { toast } from 'sonner'

const UserOrganizationInvitations: React.FC = () => {
  const { organizationsApi } = useApi()

  const { refreshOrganizations } = useOrganizations()
  const { onSelectOrganization } = useSelectedOrganization()
  const { setCount } = useUserOrganizationInvitations()

  const [invitations, setInvitations] = useState<OrganizationInvitation[]>([])
  const [loadingInvitations, setLoadingInvitations] = useState(true)

  const [loadingInvitationAction, setLoadingInvitationAction] = useState<Record<string, boolean>>({})

  const fetchInvitations = useCallback(
    async (showTableLoadingState = true) => {
      if (showTableLoadingState) {
        setLoadingInvitations(true)
      }
      try {
        const response = await organizationsApi.listOrganizationInvitationsForAuthenticatedUser()
        setInvitations(response.data)
        setCount(response.data.length)
      } catch (error) {
        handleApiError(error, 'Failed to fetch invitations')
      } finally {
        setLoadingInvitations(false)
      }
    },
    [organizationsApi, setCount],
  )

  useEffect(() => {
    fetchInvitations()
  }, [fetchInvitations])

  const [searchParams, setSearchParams] = useSearchParams()
  const attemptedLinks = useRef(new Set<string>())
  const [linkStatus, setLinkStatus] = useState<'joining' | 'failed' | null>(null)

  // The membership already exists by now, so a failed switch is reported as such,
  // not as a failed accept.
  const switchToJoinedOrganization = useCallback(
    async (organizationId: string) => {
      try {
        // Refresh the list without persisting a choice; selection saves it only
        // after membership validation succeeds.
        await refreshOrganizations()
        await onSelectOrganization(organizationId)
      } catch (error) {
        handleApiError(error, 'Failed to switch to the joined organization')
      }
    },
    [refreshOrganizations, onSelectOrganization],
  )

  const acceptInvitation = useCallback(
    async (invitationId: string): Promise<boolean> => {
      setLoadingInvitationAction((prev) => ({ ...prev, [invitationId]: true }))
      try {
        const { data: invitation } = await organizationsApi.acceptOrganizationInvitation(invitationId)
        toast.success(`You joined ${invitation.organizationName}`)
        await switchToJoinedOrganization(invitation.organizationId)
        await fetchInvitations(false)
        return true
      } catch (error) {
        handleApiError(error, 'Failed to accept invitation')
        return false
      } finally {
        setLoadingInvitationAction((prev) => ({ ...prev, [invitationId]: false }))
      }
    },
    [organizationsApi, switchToJoinedOrganization, fetchInvitations],
  )

  useEffect(() => {
    const invitationId = searchParams.get('id')
    if (!invitationId || loadingInvitations || attemptedLinks.current.has(invitationId)) return
    // Effects can replay; accepting a link must issue only one mutation per visit.
    attemptedLinks.current.add(invitationId)
    setLinkStatus('joining')
    void acceptInvitation(invitationId).then((accepted) => {
      setLinkStatus(accepted ? null : 'failed')
      setSearchParams(
        (current) => {
          const next = new URLSearchParams(current)
          if (next.get('id') === invitationId) next.delete('id')
          return next
        },
        { replace: true },
      )
    })
  }, [searchParams, setSearchParams, loadingInvitations, acceptInvitation])

  const handleDeclineInvitation = async (invitation: OrganizationInvitation): Promise<boolean> => {
    setLoadingInvitationAction((prev) => ({ ...prev, [invitation.id]: true }))
    try {
      await organizationsApi.declineOrganizationInvitation(invitation.id)
      toast.success('Invitation declined successfully')
      await fetchInvitations(false)
      return true
    } catch (error) {
      handleApiError(error, 'Failed to decline invitation')
      return false
    } finally {
      setLoadingInvitationAction((prev) => ({ ...prev, [invitation.id]: false }))
    }
  }

  return (
    <PageLayout>
      <PageHeader size="full">
        <PageTitle>Invitations</PageTitle>
      </PageHeader>

      <PageContent size="full">
        {linkStatus === 'joining' && <p role="status">Joining organization...</p>}
        {linkStatus === 'failed' && (
          <p role="alert" className="mb-4 text-sm text-destructive">
            Unable to join using this invitation. Sign in with the invited email address, or ask the organization owner
            for a new invitation.
          </p>
        )}
        <UserOrganizationInvitationTable
          data={invitations}
          loadingData={loadingInvitations}
          onAcceptInvitation={(invitation) => acceptInvitation(invitation.id)}
          onDeclineInvitation={handleDeclineInvitation}
          loadingInvitationAction={loadingInvitationAction}
        />
      </PageContent>
    </PageLayout>
  )
}

export default UserOrganizationInvitations
