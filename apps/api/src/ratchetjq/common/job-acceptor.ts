/*
 * Copyright 2026 BoxLite AI
 * SPDX-License-Identifier: AGPL-3.0
 */

import { RatchetJQJob } from '../entities/ratchetjq-job.entity'

/**
 * The accept segment's handler side: what decides, once an executor has handed a
 * job's outcome back, whether that outcome stands.
 *
 * An acceptor implements ISyncJobAcceptor, IAsyncJobAcceptor or both, and two
 * thin wrappers call into them — the same shape as the runner's job types and its
 * two executors (`apps/runner/pkg/ratchetjq/job.go:97`). Spelling the two halves
 * of one spec the same way is the point: the same job type name reaches both
 * sides, so whoever writes the pair for a job type reads one vocabulary.
 *
 * Both wrappers hand back a promise of a verdict. Nothing here writes to the job
 * table — acting on a verdict is RatchetJQAcceptFinalizer's job, and every caller
 * reaches it the same way, by chaining onto that promise.
 *
 * An accept round is retried like an execution round: it holds `attlSeconds` of
 * lease, and a round that neither completes the job nor rolls it back is retried
 * once that lease has lapsed. Every acceptor must therefore be idempotent — the
 * same outcome may be offered to it more than once, and accepting twice must land
 * the same state rather than a second side effect.
 *
 * Both forms take an AbortSignal, and honouring it is as much part of the
 * contract as idempotency. It is aborted the moment nothing is waiting for the
 * verdict any more — the caller's round having spent the accept budget being the
 * case that matters — and an acceptor that ignores it keeps its query, request or
 * timer alive with no one left to receive the answer. Since a round that gives up
 * does not stop taking the next batch, those abandoned accepts accumulate: the
 * ceiling on rows per round is not a ceiling on accepts in flight unless the
 * abandoned ones actually stop.
 *
 * What to do with it: pass it to whatever the accept waits on (`fetch`, a query
 * with a cancellation hook, a timer), and treat `signal.aborted` as a reason to
 * stop rather than to finish. Rejecting once aborted is correct and expected —
 * nothing is listening for that rejection.
 */

/**
 * What an acceptor decides about a reported outcome.
 *
 * Deliberately not a `RatchetJQJobStatus`. The status is the business result the
 * executor reported; this is the scheduling question of which terminal path the
 * job takes, and spec §2.4 keeps the two apart. The one place they meet is that a
 * rolled-back job completes as `REJECTED` — "a handler refused the job" — and
 * deriving that belongs to the finalizer, not to the acceptor.
 */
export enum RatchetJQAcceptVerdict {
  /** The outcome stands: the job completes as the executor reported it. */
  ACCEPTED = 'accepted',
  /** The outcome does not stand: the job completes through a rollback job. */
  ROLLBACK = 'rollback',
}

/**
 * What every acceptor provides: the job type it accepts for. Naming the type on
 * the implementation is what lets the registry key off it rather than off a
 * string passed at some registration call site, the same choice the runner's
 * `IJob.Type` makes (`apps/runner/pkg/ratchetjq/job.go:98`).
 *
 * On its own an acceptor cannot be called. It becomes callable by also
 * implementing ISyncJobAcceptor, IAsyncJobAcceptor, or both.
 *
 * One acceptor serves every job of its type, so an implementation must keep no
 * per-job state in fields: everything about the job in flight arrives as an
 * argument, which is what makes sharing it safe.
 */
export interface IJobAcceptor {
  readonly type: string
}

/**
 * An acceptor that can answer while a caller waits — the counterpart of the
 * runner's ISyncJob (`apps/runner/pkg/ratchetjq/job.go:111`).
 *
 * Returning a promise is normal and expected, since deciding usually means
 * reading the database. What "sync" commits to is not the shape of the return but
 * its timing: this form promises to settle inside one request, so it is the only
 * one a synchronous `Report` may call.
 */
export interface ISyncJobAcceptor extends IJobAcceptor {
  syncAccept(job: RatchetJQJob, signal: AbortSignal): Promise<RatchetJQAcceptVerdict>
}

/**
 * An acceptor that may take as long as it likes — waiting on an external
 * callback, a queue message, a human.
 *
 * The signature is identical to the inline form on purpose. In Go the two differ
 * because a function that returns a value has to block until it has one, so
 * IAsyncJob needs a callback; a promise already means "later", so nothing about
 * the shape is left to distinguish. What separates them is what each name commits
 * to, and that is worth a declaration of its own: an acceptor implementing only
 * this form is refused by SyncAcceptor rather than allowed to hold an executor's
 * request open for a wait it never promised to end.
 */
export interface IAsyncJobAcceptor extends IJobAcceptor {
  asyncAccept(job: RatchetJQJob, signal: AbortSignal): Promise<RatchetJQAcceptVerdict>
}

/**
 * TypeScript erases interfaces, so which forms an acceptor implements can only be
 * asked of the object itself. These two are the type assertions the runner writes
 * as `job.(ISyncJob)` (`apps/runner/pkg/ratchetjq/executor.go:46`).
 */
export function isSyncJobAcceptor(acceptor: IJobAcceptor): acceptor is ISyncJobAcceptor {
  return typeof (acceptor as ISyncJobAcceptor).syncAccept === 'function'
}

export function isAsyncJobAcceptor(acceptor: IJobAcceptor): acceptor is IAsyncJobAcceptor {
  return typeof (acceptor as IAsyncJobAcceptor).asyncAccept === 'function'
}

/**
 * Accepts a job inline, for a caller that is waiting on the answer.
 *
 * It is the strict half of the pair: only an acceptor with an inline form can
 * serve an inline accept, and one without is refused rather than served by
 * waiting on its asynchronous form. Adapting that direction would leave the
 * reporting executor's request timeout as the only bound on a wait the acceptor
 * never promised to end.
 *
 * The acceptor's own failure rejects. The caller is a synchronous `Report`
 * holding the executor's request open, so the executor learning that the accept
 * failed beats it learning nothing and waiting out the lease.
 */
export class SyncAcceptor {
  static async accept(acceptor: IJobAcceptor, job: RatchetJQJob, signal: AbortSignal): Promise<RatchetJQAcceptVerdict> {
    if (!isSyncJobAcceptor(acceptor)) {
      throw new Error(`RatchetJQ job acceptor for type "${acceptor.type}" has no inline form`)
    }

    return acceptor.syncAccept(job, signal)
  }
}

/**
 * Starts an accept for a caller that must not be held, and promises the verdict.
 *
 * It is the accommodating half of the pair: it prefers an acceptor's own
 * asynchronous form and adapts the inline one otherwise, which is what lets an
 * acceptor implement only the inline side and still serve a caller that cannot
 * wait.
 *
 * Calling it never runs an inline acceptor on the caller's stack, and that needs
 * saying because the obvious version does not manage it. An `async` function body
 * runs synchronously up to its first `await`, so calling an inline acceptor and
 * handing back its promise still runs everything that acceptor does before its
 * own first `await` — for one that decides without waiting, all of it. The
 * adaptation therefore hands the call to `setImmediate` first.
 *
 * `setImmediate` and not a microtask: `queueMicrotask` and
 * `Promise.resolve().then` — which is all rxjs's own "Immediate" shim is
 * (rxjs@7.8.2/src/internal/util/Immediate.ts:22) — drain before the event loop
 * turns, so deferring that way returns to the caller but still runs the acceptor
 * ahead of the I/O already pending on this turn. A `setImmediate` runs in the
 * check phase, behind that I/O.
 *
 * What no promise buys is the thing the runner's goroutine does: once an inline
 * acceptor starts, nothing preempts it, so one that burns CPU stalls the whole
 * process for as long as it runs. Off-loop work needs a thread, the way this
 * repo's own native bindings get one (`sdks/node/src/exec.rs:50`). An acceptor
 * with work of that shape should implement IAsyncJobAcceptor and own its
 * offloading.
 *
 * Nothing is swallowed here. A failed accept rejects, and what to do about it —
 * log it and leave the row to its lease — belongs to the caller that knows which
 * row it was.
 */
export class AsyncAcceptor {
  static async accept(acceptor: IJobAcceptor, job: RatchetJQJob, signal: AbortSignal): Promise<RatchetJQAcceptVerdict> {
    if (isAsyncJobAcceptor(acceptor)) {
      // Called straight through: this form manages its own timing, and delaying
      // it by a turn could mean arming a listener after the event it waits for.
      return acceptor.asyncAccept(job, signal)
    }
    if (!isSyncJobAcceptor(acceptor)) {
      throw new Error(`RatchetJQ job acceptor for type "${acceptor.type}" implements neither accept form`)
    }

    const inline = acceptor

    return new Promise<RatchetJQAcceptVerdict>((resolve, reject) => {
      setImmediate(() => {
        // A turn passed between the caller asking and this running, which is
        // long enough for the caller to have stopped waiting. Starting the
        // acceptor then would be work nobody can receive — the one thing the
        // signal exists to prevent — so this is the deferral paying its own way.
        if (signal.aborted) {
          reject(signal.reason)
          return
        }

        inline.syncAccept(job, signal).then(resolve, reject)
      })
    })
  }
}
