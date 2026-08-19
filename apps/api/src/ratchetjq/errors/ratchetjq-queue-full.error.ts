/*
 * Copyright 2026 BoxLite AI
 * SPDX-License-Identifier: AGPL-3.0
 */

/** What one executor instance's queue looked like when a submission was refused. */
export interface RatchetJQQueueDepth {
  executor: string
  executorId: string
  /** Rows for that instance in any stage but `completed`, as counted before the insert. */
  unfinished: number
  /** The ceiling that count met or passed. */
  limit: number
}

/**
 * A submission refused because the executor instance it names already has as much
 * unfinished work as it is allowed to hold.
 *
 * Its own type, like the dedup refusal, because a caller can act on this one and
 * the action is the opposite of that one's: a duplicate means the work is already
 * scheduled and carrying on is usually right, where a full queue means the work
 * was *not* scheduled and something upstream has to shed load, back off, or pick
 * another executor instance. Telling them apart from a generic failure is what
 * makes either response possible.
 *
 * It carries the depth and the limit rather than just saying "full", because the
 * two together are what a caller needs to decide how long to back off for — and
 * because a limit that is being hit constantly is a tuning signal, not an
 * incident, which is only visible if the numbers travel.
 */
export class RatchetJQQueueFullError extends Error {
  constructor(readonly depth: RatchetJQQueueDepth) {
    super(
      `RatchetJQ executor ${depth.executor}/${depth.executorId} already holds ${depth.unfinished} ` +
        `unfinished jobs, at its limit of ${depth.limit}`,
    )
    this.name = 'RatchetJQQueueFullError'
  }
}
