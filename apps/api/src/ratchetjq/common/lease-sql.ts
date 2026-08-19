/*
 * Copyright 2026 BoxLite AI
 * SPDX-License-Identifier: AGPL-3.0
 */

/**
 * The deadline arithmetic of spec §2.3, as SQL fragments.
 *
 * It lives here rather than beside one writer because both writers apply the
 * same rule to different stages: TRANSFER hands a `running` round its
 * `ttlSeconds`, the Scanner hands an `accepting` round its `attlSeconds`, and
 * the backoff curve is one policy shared by both. Duplicating it would mean a
 * change to that curve landing in one file and not the other.
 */

/**
 * Which stage's time budget a deadline is being written for. A union rather than
 * a free string because these fragments are interpolated into SQL, so the column
 * name must come from this file and never from a caller's data.
 */
export type RatchetJQLeaseBudget = 'ttlSeconds' | 'attlSeconds'

/** Seconds of backoff owed to a round, as SQL over an attempt expression. */
function backoffSeconds(attemptExpression: string): string {
  return `POW(${attemptExpression}, 4)`
}

/**
 * When a row taking `attemptExpression`'s round may be claimed again: the later
 * of the stage's own budget and that round's backoff, so one column answers both
 * questions (spec §2.3).
 */
export function claimableAgainAt(budget: RatchetJQLeaseBudget, attemptExpression: string): string {
  return `now() + GREATEST("${budget}", ${backoffSeconds(attemptExpression)}) * interval '1 second'`
}

/** When that round's backoff alone elapses (spec §2.3). */
export function backoffElapsesAt(attemptExpression: string): string {
  return `now() + ${backoffSeconds(attemptExpression)} * interval '1 second'`
}
