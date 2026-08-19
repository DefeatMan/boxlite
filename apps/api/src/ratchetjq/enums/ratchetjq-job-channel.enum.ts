/*
 * Copyright 2026 BoxLite AI
 * SPDX-License-Identifier: AGPL-3.0
 */

/**
 * A RatchetJQ job's deduplication channel (spec §2.1, §2.6).
 *
 * The channel is how "the same kind of job" is expressed: two submissions that
 * share a channel, an executor instance and a resource collide on the partial
 * unique index, so a second start for one box cannot be queued while the first
 * is in flight, and jobs that must not run concurrently on one resource (a
 * box's start and its destroy) are put in the same channel to make that
 * impossible.
 *
 * NONE is the opt-out and the reason this is numeric with a zero: the unique
 * index is predicated on `channel <> 0`, so a job that should never be
 * deduplicated simply leaves the column at its default. Concrete channels
 * belong to the job types that claim them, so none are defined here.
 */
export enum RatchetJQJobChannel {
  NONE = 0,
}
