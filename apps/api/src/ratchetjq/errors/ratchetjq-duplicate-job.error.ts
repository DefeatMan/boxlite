/*
 * Copyright 2026 BoxLite AI
 * SPDX-License-Identifier: AGPL-3.0
 */

/** The dedup key a duplicate submission collided on (spec §2.6). */
export interface RatchetJQDedupKey {
  /** NONE, or a channel one of the job types owns. */
  channel: number
  executor: string
  executorId: string
  resourceId: string
}

/**
 * A submission refused because an unfinished job already holds its dedup key.
 *
 * Its own type rather than a generic failure, because a caller has something to
 * do about this one and nothing to do about the rest: the work it wanted is
 * already scheduled, so the sensible response is usually to carry on rather than
 * to retry. It carries the whole key, since which part collided — the channel,
 * the executor instance, the resource — is what tells a caller whether it is
 * looking at its own earlier submission or somebody else's.
 */
export class RatchetJQDuplicateJobError extends Error {
  constructor(readonly key: RatchetJQDedupKey) {
    super(
      `An unfinished RatchetJQ job already holds channel ${key.channel} for resource ${key.resourceId} ` +
        `on ${key.executor}/${key.executorId}`,
    )
    this.name = 'RatchetJQDuplicateJobError'
  }
}
