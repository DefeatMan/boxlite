/*
 * Copyright 2026 BoxLite AI
 * SPDX-License-Identifier: AGPL-3.0
 */

/**
 * A synchronous submission ran past the deadline its caller set, so the wait was
 * abandoned (spec §4).
 *
 * It is deliberately its own error, because it is the one failure of `execSync`
 * that says nothing about the job: the row is written, the side effect may well
 * have landed, and the accept segment goes on without the caller — the row stays
 * where it was, its lease lapses, and the Scanner takes the next round. A caller
 * that treats this like a failed submission and compensates would be undoing work
 * that is still in flight; the right reaction is to stop waiting and read the row
 * later.
 *
 * `stage` names which half of the chain was still running, since the two mean
 * different things to a caller: `run` means the executor had not answered yet, so
 * whether the side effect happened is unknown, while `accept` means it answered
 * and the outcome is already recorded — only the verdict is outstanding.
 */
export type RatchetJQSyncStage = 'run' | 'accept'

export class RatchetJQSyncTimeoutError extends Error {
  constructor(
    readonly jobId: string,
    readonly stage: RatchetJQSyncStage,
    readonly timeoutSeconds: number,
  ) {
    super(
      `RatchetJQ job ${jobId} did not finish its ${stage} segment within ${timeoutSeconds}s; ` +
        `it stays scheduled and the Scanner takes the next round`,
    )
    this.name = 'RatchetJQSyncTimeoutError'
  }
}
