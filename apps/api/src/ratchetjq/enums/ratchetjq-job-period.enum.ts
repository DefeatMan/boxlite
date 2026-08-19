/*
 * Copyright 2026 BoxLite AI
 * SPDX-License-Identifier: AGPL-3.0
 */

/**
 * A RatchetJQ job's scheduling stage (spec §2.4).
 *
 * Only the scheduler advances it, and it only ever advances — a rollback is a
 * new forward job, never a backward edge — so every query filters on it and no
 * writer moves it back. COMPLETED is the single terminal stage; the business
 * result of getting there is `status`, not this.
 */
export enum RatchetJQJobPeriod {
  PENDING_RUN = 'pending_run',
  RUNNING = 'running',
  ACCEPTING = 'accepting',
  COMPLETED = 'completed',
}
