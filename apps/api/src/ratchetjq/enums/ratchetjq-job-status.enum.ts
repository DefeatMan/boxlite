/*
 * Copyright 2026 BoxLite AI
 * SPDX-License-Identifier: AGPL-3.0
 */

/**
 * A RatchetJQ job's business result, written only on the way into
 * `period = completed` (spec §2.4).
 *
 * The spec leaves the full set open (§12-2) and requires at least these three
 * to be distinguishable: the side effect landed, a handler refused the job, and
 * the rounds ran out. Adding a value later is an `ALTER TYPE ... ADD VALUE`
 * migration, which is the cost of having the database reject a status the
 * application does not know.
 */
export enum RatchetJQJobStatus {
  /** The side effect landed and `outParams` holds its result. */
  OK = 'ok',
  /** A handler refused the job; retrying it would refuse it again. */
  REJECTED = 'rejected',
  /** The rounds allowed by `attempt` ran out before the job succeeded. */
  TIMEOUT = 'timeout',
}
