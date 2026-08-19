/*
 * Copyright 2026 BoxLite AI
 * SPDX-License-Identifier: AGPL-3.0
 */

/**
 * The executor instance a job belongs to could not be addressed at all — no such
 * runner, or one with no API URL to call.
 *
 * Separate from the job's own failure, and from the call failing on the way: this
 * one never left the control plane, so nothing ran and nothing will until the
 * executor row is fixed. It carries the job id because the row is already
 * written by the time a push is attempted, so the caller is holding a job that
 * exists and needs to be able to say which.
 */
export class RatchetJQExecutorUnreachableError extends Error {
  constructor(
    readonly jobId: string,
    readonly executorId: string,
    reason: string,
  ) {
    super(`Cannot reach executor ${executorId} for RatchetJQ job ${jobId}: ${reason}`)
    this.name = 'RatchetJQExecutorUnreachableError'
  }
}
