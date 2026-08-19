/*
 * Copyright 2026 BoxLite AI
 * SPDX-License-Identifier: AGPL-3.0
 */

/**
 * A RatchetJQ job's business result (spec §2.4).
 *
 * The spec leaves the full set open (§12-2) and requires at least the first
 * three to be distinguishable: the side effect landed, a handler refused the
 * job, and the rounds ran out. Adding a value later is an enum migration, which
 * is the cost of having the database reject a status the application does not
 * know.
 *
 * Those three are terminal, written on the way into `period = completed`.
 * FAILED is the exception and the reason the set is no longer only terminal
 * values: it is what an executor reports for a round that raised rather than
 * produced, so it is written on the way into `accepting`, and the accept
 * segment then decides whether the job completes still carrying it or through a
 * rollback.
 */
export enum RatchetJQJobStatus {
  /** The side effect landed and `outParams` holds its result. */
  OK = 'ok',
  /** A handler refused the job; retrying it would refuse it again. */
  REJECTED = 'rejected',
  /** The rounds allowed by `attempt` ran out before the job succeeded. */
  TIMEOUT = 'timeout',
  /**
   * The executor's run raised instead of producing an outcome, and `errMsg`
   * carries what it said.
   *
   * Deliberately distinct from REJECTED: that one is the control plane refusing
   * an outcome the executor did produce, and the two want opposite things from
   * whoever reads them — a rejection points at the accept rule that refused it,
   * a failure at the executor that raised.
   */
  FAILED = 'failed',
}
