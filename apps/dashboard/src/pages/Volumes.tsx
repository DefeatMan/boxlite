/*
 * Copyright 2025 Daytona Platforms Inc.
 * Modified by BoxLite AI, 2025-2026
 * SPDX-License-Identifier: AGPL-3.0
 */

import { Panel, PanelNote, StatCard, StatusMark } from '@/components/ascii'
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from '@/components/ui/alert-dialog'
import { Dialog, DialogContent, DialogHeader, DialogTitle } from '@/components/ui/dialog'
import { Plus, Search } from '@/components/ui/icon'
import { RoutePath } from '@/enums/RoutePath'
import { useCreateVolumeMutation } from '@/hooks/mutations/useCreateVolumeMutation'
import { useDeleteVolumeMutation } from '@/hooks/mutations/useDeleteVolumeMutation'
import { queryKeys } from '@/hooks/queries/queryKeys'
import { useVolumesQuery } from '@/hooks/queries/useVolumesQuery'
import { useSelectedOrganization } from '@/hooks/useSelectedOrganization'
import { useVolumeWsSync } from '@/hooks/useVolumeWsSync'
import { handleApiError } from '@/lib/error-handling'
import { cn } from '@/lib/utils'
import { OrganizationRolePermissionsEnum, VolumeDto, VolumeState } from '@boxlite-ai/api-client'
import { useQueryClient } from '@tanstack/react-query'
import React, { useCallback, useEffect, useMemo, useState } from 'react'
import { useNavigate } from 'react-router-dom'
import { toast } from 'sonner'

const NAME_REGEX = /^[a-zA-Z0-9][a-zA-Z0-9._-]*$/

// A volume nobody has mounted in this long is a cleanup candidate. It is the
// only actionable signal the page can offer: there is no capacity or usage
// reporting anywhere in the API, so "is anyone still using this" is the whole
// question this inventory answers.
const IDLE_AFTER_DAYS = 30

// `lastUsedAt` is written only when a box that mounts the volume is created
// (volume.service.ts:231), never on read or write — so it means "last mounted".
// Every label for it says so; "last used" would be a claim a long-running
// writer disproves.
function timeAgo(value?: string): string {
  if (!value) return 'never'
  const minutes = Math.floor((Date.now() - new Date(value).getTime()) / 60_000)
  if (minutes < 1) return 'just now'
  if (minutes < 60) return `${minutes}m ago`
  const hours = Math.floor(minutes / 60)
  if (hours < 24) return `${hours}h ago`
  return `${Math.floor(hours / 24)}d ago`
}

function isIdle(volume: VolumeDto, mountedBy: number): boolean {
  if (mountedBy > 0) return false
  if (!volume.lastUsedAt) return true
  return Date.now() - new Date(volume.lastUsedAt).getTime() > IDLE_AFTER_DAYS * 86_400_000
}

// Transitional states read as `warn` rather than blending in with the healthy
// ones: a volume stuck in `pending_delete` is exactly the leak this page exists
// to surface, so it must not look calm.
const STATE_TONE: Record<string, 'ok' | 'warn' | 'bad' | 'idle'> = {
  [VolumeState.READY]: 'ok',
  [VolumeState.CREATING]: 'warn',
  [VolumeState.PENDING_CREATE]: 'warn',
  [VolumeState.PENDING_DELETE]: 'warn',
  [VolumeState.DELETING]: 'warn',
  [VolumeState.ERROR]: 'bad',
  [VolumeState.DELETED]: 'idle',
}

type UsageEntry = { boxId: string; boxName: string; mountPath: string }

// The list is a triage surface, not a browser: the API returns volumes
// newest-mounted first (volume.service.ts:136-142), which buries exactly the
// rows worth acting on. These views put them back on top.
type View = 'all' | 'in-use' | 'idle' | 'attention'

// Stuck mid-transition or outright failed. A volume parked in `pending_delete`
// is the shape every leak in the shared dev org has taken, so it gets its own
// view rather than hiding among healthy rows.
function needsAttention(volume: VolumeDto): boolean {
  return (
    volume.state === VolumeState.ERROR ||
    volume.state === VolumeState.PENDING_DELETE ||
    volume.state === VolumeState.DELETING
  )
}

// What to paste into an SDK call to mount this volume. The API resolves a
// mount by name or id (volume.service.ts:167-172) and the name is the readable,
// stable one, so that is what gets copied — the console feeds the SDK rather
// than replacing it.
function mountSnippet(name: string): string {
  return `BoxOptions(volumes=[("${name}", "/data")])`
}

function CopyLine({ text, label }: { text: string; label: string }) {
  const [copied, setCopied] = useState(false)
  return (
    <button
      type="button"
      onClick={async () => {
        try {
          await navigator.clipboard.writeText(text)
          setCopied(true)
          window.setTimeout(() => setCopied(false), 1400)
        } catch {
          toast.error('Could not copy to clipboard')
        }
      }}
      aria-label={`Copy ${label}`}
      className="group flex w-full items-center justify-between gap-3 border border-dashed border-border bg-card/60 px-[11px] py-[8px] text-left transition-colors hover:border-brand"
    >
      <code className="truncate font-mono text-[11.5px] text-foreground">{text}</code>
      <span className="shrink-0 font-mono text-[9.5px] uppercase tracking-[1px] text-muted-foreground group-hover:text-brand">
        {copied ? 'copied' : 'copy'}
      </span>
    </button>
  )
}

// Which boxes mount a volume.
//
// The backend can already answer this — the reverse lookup exists, backed by
// the `idx_box_volumes_gin` index — but only inside the delete guard, as a
// `.getOne()` (volume.service.ts:92-104). Nothing exposes it on an endpoint.
// Exposing it is the admission condition for this feature (PRD §7); until then
// the page reads a stand-in so the shape it will consume is already settled.
function useVolumeUsage(): Record<string, UsageEntry[]> {
  return useMemo(
    () =>
      (globalThis as { __BOXLITE_VOLUME_USAGE__?: Record<string, UsageEntry[]> }).__BOXLITE_VOLUME_USAGE__ ?? {},
    [],
  )
}

const Volumes: React.FC = () => {
  const navigate = useNavigate()
  const queryClient = useQueryClient()
  const { selectedOrganization, authenticatedUserHasPermission } = useSelectedOrganization()
  // Volume state changes arrive over the notification socket; keep the
  // subscription alive across the restyle (dashboard CLAUDE.md, constraint 2).
  useVolumeWsSync()

  const queryKey = useMemo(() => queryKeys.volumes.list(selectedOrganization?.id ?? ''), [selectedOrganization?.id])
  const { data: volumes = [], isLoading, error: volumesError } = useVolumesQuery()
  const createVolume = useCreateVolumeMutation()
  const deleteVolume = useDeleteVolumeMutation({ invalidateOnSuccess: false })
  const usage = useVolumeUsage()

  const canWrite = authenticatedUserHasPermission(OrganizationRolePermissionsEnum.WRITE_VOLUMES)
  const canDelete = authenticatedUserHasPermission(OrganizationRolePermissionsEnum.DELETE_VOLUMES)

  const [filter, setFilter] = useState('')
  const [view, setView] = useState<View>('all')
  const [expanded, setExpanded] = useState<string | null>(null)
  const [createOpen, setCreateOpen] = useState(false)
  const [newName, setNewName] = useState('')
  const [pendingDelete, setPendingDelete] = useState<VolumeDto | null>(null)
  const [conflict, setConflict] = useState<{ volume: VolumeDto; boxes: UsageEntry[] } | null>(null)
  const [busy, setBusy] = useState<Record<string, boolean>>({})

  useEffect(() => {
    if (volumesError) {
      handleApiError(volumesError, 'Failed to fetch volumes')
    }
  }, [volumesError])

  const updateVolumeStateInCache = useCallback(
    (volumeId: string, state: VolumeState) => {
      queryClient.setQueriesData<VolumeDto[]>({ queryKey }, (previous) =>
        previous?.map((volume) => (volume.id === volumeId ? { ...volume, state } : volume)),
      )
    },
    [queryClient, queryKey],
  )

  const rows = useMemo(() => {
    const needle = filter.trim().toLowerCase()
    return volumes.filter((v) => {
      if (needle && !v.name.toLowerCase().includes(needle) && !v.id.toLowerCase().includes(needle)) return false
      const mounted = usage[v.id]?.length ?? 0
      if (view === 'in-use') return mounted > 0
      if (view === 'idle') return isIdle(v, mounted)
      if (view === 'attention') return needsAttention(v)
      return true
    })
  }, [volumes, filter, view, usage])

  const counts = useMemo(
    () => ({
      total: volumes.length,
      inUse: volumes.filter((v) => (usage[v.id]?.length ?? 0) > 0).length,
      idle: volumes.filter((v) => isIdle(v, usage[v.id]?.length ?? 0)).length,
      attention: volumes.filter(needsAttention).length,
    }),
    [volumes, usage],
  )

  // Selecting an active view again clears it, so the cards toggle.
  const selectView = (next: View) => setView((current) => (current === next ? 'all' : next))

  const nameValid = !newName || NAME_REGEX.test(newName)

  const handleCreate = async () => {
    const name = newName.trim()
    if (!name) {
      toast.error('Volume name is required')
      return
    }
    if (!nameValid) {
      toast.error('Only letters, digits, dots, underscores and dashes are allowed in the name.')
      return
    }
    try {
      await createVolume.mutateAsync({ volume: { name }, organizationId: selectedOrganization?.id })
      setCreateOpen(false)
      setNewName('')
      toast.success(`Creating volume ${name}`)
    } catch (error) {
      handleApiError(error, 'Failed to create volume')
    }
  }

  const handleDelete = async (volume: VolumeDto) => {
    // Refuse locally when a box is known to hold it, so the user sees every
    // blocker at once. The server's 409 names a single example (`.getOne()`).
    const holders = usage[volume.id] ?? []
    if (holders.length > 0) {
      setPendingDelete(null)
      setConflict({ volume, boxes: holders })
      return
    }

    setBusy((prev) => ({ ...prev, [volume.id]: true }))
    updateVolumeStateInCache(volume.id, VolumeState.PENDING_DELETE)
    try {
      await deleteVolume.mutateAsync({ volumeId: volume.id, organizationId: selectedOrganization?.id })
      if (selectedOrganization?.id) {
        await queryClient.invalidateQueries({ queryKey })
      }
      setPendingDelete(null)
      // Not "deleted": removal is a soft delete a reconciler finishes later, so
      // the row stays on screen until it does.
      toast.success(`Deleting volume ${volume.name}`)
    } catch (error) {
      handleApiError(error, 'Failed to delete volume')
      updateVolumeStateInCache(volume.id, volume.state)
      setPendingDelete(null)
    } finally {
      setBusy((prev) => ({ ...prev, [volume.id]: false }))
    }
  }

  const showEmpty = !isLoading && volumes.length === 0

  return (
    <div className="flex h-[calc(100svh-60px)] min-h-0 flex-col px-4 pt-5 sm:px-6 lg:px-[40px] lg:pt-[26px]">
      <div className="mb-[18px] flex items-end justify-between lg:mb-[22px]">
        <h1 className="font-mono text-[22px] font-medium leading-none tracking-[-0.5px]">Volumes</h1>
      </div>

      {showEmpty ? (
        <EmptyState canCreate={canWrite} onCreate={() => setCreateOpen(true)} />
      ) : (
        <>
          {/* Inventory, not capacity: no size or usage exists anywhere in the
              API (and neither Daytona nor E2B reports one today), so the cards
              count what can be acted on. `idle` is the actionable one. */}
          <div className="grid grid-cols-3 gap-2 sm:gap-3 lg:gap-[14px]">
            <StatCard
              label="total volumes"
              value={String(counts.total)}
              sub="all states"
              onClick={() => setView('all')}
              active={view === 'all'}
            />
            <StatCard
              label="in use"
              value={String(counts.inUse)}
              sub="mounted now"
              live
              onClick={() => selectView('in-use')}
              active={view === 'in-use'}
            />
            <StatCard
              label="idle"
              value={String(counts.idle)}
              sub={`no mount in ${IDLE_AFTER_DAYS}d`}
              onClick={() => selectView('idle')}
              active={view === 'idle'}
            />
          </div>

          <div className="mt-5 flex flex-col gap-3 sm:flex-row sm:items-stretch lg:mt-[26px]">
            <div className="flex h-11 w-full min-w-0 items-center gap-[11px] border border-dashed border-border bg-card px-[14px] sm:h-9 sm:max-w-[380px] sm:flex-none">
              <Search className="size-[15px] shrink-0" style={{ color: 'hsl(var(--brand))' }} strokeWidth={2} />
              <input
                value={filter}
                onChange={(e) => setFilter(e.target.value)}
                placeholder="Filter volumes…"
                className="w-full border-0 bg-transparent p-0 text-[13px] text-foreground outline-none placeholder:text-muted-foreground"
              />
              <span className="whitespace-nowrap font-mono text-[10px] uppercase tracking-[1px] text-muted-foreground">
                {rows.length}
              </span>
            </div>
            {/* Only exists when something is wrong — a permanently visible
                "0 problems" counter trains people to stop reading it. */}
            {counts.attention > 0 && (
              <button
                type="button"
                onClick={() => selectView('attention')}
                aria-pressed={view === 'attention'}
                className={cn(
                  'inline-flex h-11 items-center gap-2 border px-[13px] font-mono text-[11px] uppercase tracking-[1px] transition-colors sm:h-9',
                  view === 'attention'
                    ? 'border-warning/70 bg-warning-background/40 text-warning-foreground'
                    : 'border-border text-muted-foreground hover:border-warning/60 hover:text-warning-foreground',
                )}
              >
                <span className="size-[9px] shrink-0" style={{ background: 'hsl(var(--warning))' }} />
                {counts.attention} need{counts.attention > 1 ? '' : 's'} attention
              </button>
            )}
            <div className="flex-1" />
            {canWrite && (
              <button
                type="button"
                onClick={() => setCreateOpen(true)}
                className="inline-flex h-11 items-center justify-center gap-[7px] bg-primary px-[15px] text-[12.5px] font-semibold text-primary-foreground transition-opacity hover:opacity-85 sm:h-9"
              >
                <Plus className="size-3.5" strokeWidth={2.4} />
                New Volume
              </button>
            )}
          </div>

          <div className="mt-[14px] flex min-h-0 flex-1 flex-col overflow-y-auto">
            <div className="grid grid-cols-[1.5fr_1.4fr_1.1fr_0.8fr_0.9fr_auto] items-center gap-3 border-b border-border px-2 pb-2 font-mono text-[10px] uppercase tracking-[1px] text-muted-foreground">
              <span>Name</span>
              <span>Volume ID</span>
              <span>Status</span>
              <span>Used by</span>
              <span>Last mounted</span>
              <span className="text-right">Actions</span>
            </div>

            {rows.map((volume) => {
              const holders = usage[volume.id] ?? []
              const open = expanded === volume.id
              const removable = volume.state === VolumeState.READY || volume.state === VolumeState.ERROR
              return (
                <div key={volume.id} className="border-b border-border/60">
                  <div className="grid grid-cols-[1.5fr_1.4fr_1.1fr_0.8fr_0.9fr_auto] items-center gap-3 px-2 py-[13px] text-[13px]">
                    <button
                      type="button"
                      onClick={() => setExpanded(open ? null : volume.id)}
                      className="flex items-center gap-2 text-left font-mono font-medium text-foreground"
                    >
                      <span className="text-[10px]" style={{ color: 'hsl(var(--brand))' }}>
                        {open ? '▾' : '▸'}
                      </span>
                      <span className="truncate">{volume.name}</span>
                    </button>
                    <button
                      type="button"
                      onClick={async () => {
                        try {
                          await navigator.clipboard.writeText(volume.id)
                          toast.success('Volume ID copied')
                        } catch {
                          toast.error('Could not copy to clipboard')
                        }
                      }}
                      title="Copy volume ID"
                      className="truncate text-left font-mono text-[12px] text-muted-foreground transition-colors hover:text-foreground"
                    >
                      {volume.id}
                    </button>
                    <StatusMark tone={STATE_TONE[volume.state] ?? 'idle'}>
                      <span className="font-mono text-[11px] uppercase tracking-[0.5px]">{volume.state}</span>
                    </StatusMark>
                    <span className="font-mono text-[12px] text-muted-foreground">
                      {holders.length > 0 ? `${holders.length} box${holders.length > 1 ? 'es' : ''}` : '—'}
                    </span>
                    <span className="font-mono text-[12px] text-muted-foreground">{timeAgo(volume.lastUsedAt)}</span>
                    {canDelete ? (
                      <button
                        type="button"
                        onClick={() => setPendingDelete(volume)}
                        disabled={!removable || busy[volume.id]}
                        title={removable ? 'Delete volume' : 'Only a ready or errored volume can be deleted'}
                        className="justify-self-end border border-border px-[10px] py-[5px] font-mono text-[11px] text-muted-foreground transition-colors hover:border-destructive hover:text-destructive disabled:cursor-not-allowed disabled:opacity-30"
                      >
                        Delete
                      </button>
                    ) : (
                      <span />
                    )}
                  </div>

                  {open && (
                    <div className="px-2 pb-[15px]">
                      <Panel className="px-[13px] py-[11px]">
                        {(volume.state === VolumeState.PENDING_DELETE || volume.state === VolumeState.DELETING) && (
                          <PanelNote>
                            Reclaiming — this can take a few minutes. The volume stays listed until it finishes.
                          </PanelNote>
                        )}
                        {volume.errorReason && (
                          <p className="mb-3 border-l-2 border-destructive/60 bg-destructive/5 px-3 py-2 font-mono text-[11px] leading-relaxed text-destructive">
                            {volume.errorReason}
                          </p>
                        )}

                        <div className="grid grid-cols-1 gap-5 sm:grid-cols-2">
                          <div>
                            <div className="font-mono text-[9px] uppercase tracking-[1.2px] text-muted-foreground">
                              Mounted by
                            </div>
                            <div className="mt-[9px] flex flex-col gap-[6px] font-mono text-[11.5px]">
                              {holders.length === 0 ? (
                                <span className="text-muted-foreground">(none)</span>
                              ) : (
                                holders.map((h) => (
                                  <button
                                    key={h.boxId}
                                    type="button"
                                    onClick={() => navigate(`${RoutePath.BOXES}/${h.boxId}`)}
                                    className="flex items-center gap-3 text-left transition-colors hover:text-brand"
                                  >
                                    <span className="w-[120px] shrink-0 truncate">{h.boxName}</span>
                                    <span className="text-muted-foreground">{h.mountPath}</span>
                                  </button>
                                ))
                              )}
                            </div>
                          </div>
                          <div>
                            <div className="font-mono text-[9px] uppercase tracking-[1.2px] text-muted-foreground">
                              Timestamps
                            </div>
                            <div className="mt-[9px] flex flex-col gap-[6px] font-mono text-[11.5px]">
                              <div className="flex justify-between gap-3">
                                <span className="text-muted-foreground">created</span>
                                <span>{timeAgo(volume.createdAt)}</span>
                              </div>
                              <div className="flex justify-between gap-3">
                                <span className="text-muted-foreground">last mounted</span>
                                <span>{timeAgo(volume.lastUsedAt)}</span>
                              </div>
                            </div>
                          </div>
                        </div>

                        {/* The handle to paste into an SDK call. Volumes are
                            used from code — this page is the inventory and
                            debugging surface around that, so it hands over the
                            exact line rather than describing it. */}
                        {volume.state === VolumeState.READY && (
                          <div className="mt-[14px] border-t border-dashed border-border pt-[12px]">
                            <div className="font-mono text-[9px] uppercase tracking-[1.2px] text-muted-foreground">
                              {holders.length === 0 ? 'Fill it' : 'Mount it'}
                            </div>
                            {holders.length === 0 && (
                              <PanelNote>
                                Mount it into a box, write there, then destroy the box — the data stays. That is how a
                                volume gets its first contents.
                              </PanelNote>
                            )}
                            <div className="mt-[9px] flex flex-col gap-[7px]">
                              <CopyLine text={mountSnippet(volume.name)} label="mount snippet" />
                              <button
                                type="button"
                                onClick={() => navigate(RoutePath.BOXES, { state: { openCreateBox: true, mountVolume: volume.name } })}
                                className="self-start border border-border px-[13px] py-[7px] font-mono text-[11.5px] transition-colors hover:border-brand"
                              >
                                Create a box with this volume ▸
                              </button>
                            </div>
                          </div>
                        )}
                      </Panel>
                    </div>
                  )}
                </div>
              )
            })}

            {rows.length === 0 && (
              <div className="flex flex-col items-center gap-3 py-10 text-center font-mono text-[12px] text-muted-foreground">
                <span>
                  {filter.trim() ? `No volume matches “${filter}”` : 'No volume in this view'}
                  {view !== 'all' && !filter.trim() ? '.' : ''}
                </span>
                {view !== 'all' && (
                  <button
                    type="button"
                    onClick={() => setView('all')}
                    className="border border-border px-[13px] py-[6px] text-[11px] transition-colors hover:border-brand"
                  >
                    Show all volumes
                  </button>
                )}
              </div>
            )}
          </div>
        </>
      )}

      <Dialog open={createOpen} onOpenChange={setCreateOpen}>
        <DialogContent className="flex w-[calc(100vw-1rem)] flex-col gap-0 overflow-hidden p-0 sm:max-w-[460px]">
          <DialogHeader className="shrink-0 border-b border-border px-4 py-[18px] sm:px-6">
            <DialogTitle className="text-[18px] font-bold tracking-[-0.3px]">New volume</DialogTitle>
          </DialogHeader>
          <div className="flex flex-col gap-[9px] px-4 py-5 sm:px-6">
            <div className="font-mono text-[10px] uppercase tracking-[1.2px] text-muted-foreground">Name</div>
            <input
              value={newName}
              onChange={(e) => setNewName(e.target.value)}
              onKeyDown={(e) => e.key === 'Enter' && handleCreate()}
              placeholder="subtitle-models"
              aria-label="Volume name"
              aria-invalid={!nameValid}
              className="w-full border border-border bg-card px-[13px] py-[11px] font-mono text-[13px] text-foreground outline-none focus:border-brand aria-[invalid=true]:border-destructive"
            />
            {/* Name is the entire create payload — the API accepts nothing else
                — and a mount takes a name in place of an id, so this is the
                handle the user will type later. */}
            <PanelNote>Used to mount this volume into a box. It takes a few seconds to become ready.</PanelNote>
          </div>
          <div className="grid shrink-0 grid-cols-2 gap-[10px] border-t border-border px-4 py-4 sm:flex sm:justify-end sm:px-6">
            <button
              type="button"
              onClick={() => setCreateOpen(false)}
              className="border border-border px-[18px] py-[10px] text-[13px] font-medium transition-colors hover:bg-card"
            >
              Cancel
            </button>
            <button
              type="button"
              onClick={handleCreate}
              disabled={createVolume.isPending || !newName.trim() || !nameValid}
              className="bg-primary px-5 py-[10px] text-[13px] font-semibold text-primary-foreground transition-opacity hover:opacity-85 disabled:cursor-not-allowed disabled:opacity-50"
            >
              {createVolume.isPending ? 'Creating…' : 'Create'}
            </button>
          </div>
        </DialogContent>
      </Dialog>

      <AlertDialog open={!!pendingDelete} onOpenChange={(open) => !open && setPendingDelete(null)}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Delete “{pendingDelete?.name}”?</AlertDialogTitle>
            <AlertDialogDescription>
              The volume and everything in it are removed, and this cannot be undone. Reclaiming runs in the background,
              so the volume stays listed until it finishes.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>Cancel</AlertDialogCancel>
            <AlertDialogAction variant="destructive" onClick={() => pendingDelete && handleDelete(pendingDelete)}>
              Delete
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>

      {/* The server names one blocker; show every one of them. */}
      <AlertDialog open={!!conflict} onOpenChange={(open) => !open && setConflict(null)}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Cannot delete “{conflict?.volume.name}”</AlertDialogTitle>
            <AlertDialogDescription>
              {conflict?.boxes.length} box{(conflict?.boxes.length ?? 0) > 1 ? 'es are' : ' is'} still using it. Destroy
              them first — a box cannot release a volume while it exists.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <div className="flex flex-col gap-[6px] border border-dashed border-border bg-card px-[13px] py-[11px] font-mono text-[11.5px]">
            {conflict?.boxes.map((b) => (
              <button
                key={b.boxId}
                type="button"
                onClick={() => navigate(`${RoutePath.BOXES}/${b.boxId}`)}
                className="flex items-center gap-3 text-left transition-colors hover:text-brand"
              >
                <span className="w-[130px] shrink-0 truncate">{b.boxName}</span>
                <span className="text-muted-foreground">{b.mountPath}</span>
              </button>
            ))}
          </div>
          <AlertDialogFooter>
            <AlertDialogCancel>Close</AlertDialogCancel>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </div>
  )
}

// Most orgs land here with nothing. The copy answers the thing that sent them
// looking — a box took their data with it — instead of defining the noun.
function EmptyState({ canCreate, onCreate }: { canCreate: boolean; onCreate: () => void }) {
  return (
    <div className="flex flex-1 flex-col items-center justify-center gap-[16px] px-6 text-center">
      <span className="size-[10px]" style={{ background: 'hsl(var(--brand))' }} />
      <div className="font-mono text-[17px] font-semibold">No volumes yet</div>
      <p className="max-w-[420px] font-mono text-[12.5px] leading-relaxed text-muted-foreground">
        A box loses everything on its disk when it is destroyed. A volume does not — mount one into a box and the data
        outlives it.
      </p>
      {canCreate && (
        <button
          type="button"
          onClick={onCreate}
          className="mt-1 inline-flex items-center gap-[7px] bg-primary px-[15px] py-[9px] text-[12.5px] font-semibold text-primary-foreground transition-opacity hover:opacity-85"
        >
          <Plus className="size-3.5" strokeWidth={2.4} />
          New Volume
        </button>
      )}
    </div>
  )
}

export default Volumes
