/*
 * Copyright 2026 BoxLite AI
 * SPDX-License-Identifier: AGPL-3.0
 */

/**
 * The kinds of executor that can run a RatchetJQ job (spec §2.1, `executor`).
 *
 * Deliberately not a Postgres enum: `ratchetjq_job.executor` is a varchar, so
 * adding a kind here is a code change and never a migration. What this type
 * gives is one vocabulary shared by the claim predicates and the dedup key,
 * which both lead with the column.
 *
 * The runner is the only kind today. A second one is added here and in
 * `resolveExecutorIdentity`, and nowhere else.
 */
export enum RatchetJQExecutor {
  RUNNER = 'runner',
}
