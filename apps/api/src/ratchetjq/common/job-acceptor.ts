/*
 * Copyright 2026 BoxLite AI
 * SPDX-License-Identifier: AGPL-3.0
 */

import { RatchetJQJob } from '../entities/ratchetjq-job.entity'

/**
 * The accept segment's handler side: what decides, once an executor has handed a
 * job's outcome back, whether that outcome stands.
 *
 * There is one accept form, not two. The spec gives the segment a strict inline
 * driver and an accommodating deferred one (§4, §9.4), mirroring the runner's
 * ISyncJob / IAsyncJob pair — but that pair exists because Go has no way to say
 * "later": a function returning a value must block until it has one, so the
 * asynchronous side needs a callback and a second interface to carry it. A
 * promise already means later, which leaves the two forms identical in
 * signature and distinguished only by a claim about timing that nothing can
 * check. One interface, one driver.
 *
 * What the spec's strict driver bought was refusing to hold a REST caller on an
 * accept that never promised to settle inline. That bound is now the caller's to
 * set and not the type system's: a synchronous submission carries its own
 * deadline (`ratchetjq-proposer.service.ts:execSync`), and whatever the acceptor
 * promised, the wait ends when that deadline fires.
 *
 * Nothing here writes to the job table — acting on a verdict is
 * RatchetJQAcceptFinalizer's job, and every caller reaches it the same way, by
 * chaining onto the promise this hands back.
 *
 * An accept round is retried like an execution round: it holds `attlSeconds` of
 * lease, and a round that neither completes the job nor rolls it back is retried
 * once that lease has lapsed. Every acceptor must therefore be idempotent — the
 * same outcome may be offered to it more than once, and accepting twice must land
 * the same state rather than a second side effect.
 *
 * `accept` takes an AbortSignal, and honouring it is as much part of the contract
 * as idempotency. It is aborted the moment nothing is waiting for the verdict any
 * more — the caller's round having spent the accept budget being the case that
 * matters — and an acceptor that ignores it keeps its query, request or timer
 * alive with no one left to receive the answer. Since a round that gives up does
 * not stop taking the next batch, those abandoned accepts accumulate: the ceiling
 * on rows per round is not a ceiling on accepts in flight unless the abandoned
 * ones actually stop.
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
 * What every acceptor provides: the job type it accepts for, and the decision.
 *
 * Naming the type on the implementation is what lets the registry key off it
 * rather than off a string passed at some registration call site, the same choice
 * the runner's `IJob.Type` makes (`apps/runner/pkg/ratchetjq/job.go:IJob.Type`).
 *
 * One acceptor serves every job of its type, so an implementation must keep no
 * per-job state in fields: everything about the job in flight arrives as an
 * argument, which is what makes sharing it safe.
 *
 * Returning a promise says nothing about how long the decision takes, and no
 * caller assumes otherwise — an acceptor may answer on the next tick or wait on a
 * queue message, a human, a retry. What bounds the wait is the round: the accept
 * budget for a detached one, the submitter's deadline for one someone is holding.
 *
 * `accept` is called directly, with nothing in between, and two obligations
 * follow from that:
 *
 * - **Yield before doing work.** An `async` body runs synchronously up to its
 *   first `await`, so everything an acceptor does before it waits runs on the
 *   stack of whoever started the round — for a detached round, a `Report` that is
 *   trying to answer its executor. Deciding by waiting on something (a query, a
 *   request) satisfies this for free; real work ahead of that first `await` does
 *   not, and CPU-bound work never will, since nothing preempts it once started.
 *   Off-loop work needs a thread, the way this repo's own native bindings get one
 *   (`sdks/node/src/exec.rs:next`).
 * - **Check the signal on entry.** A round can be abandoned before its acceptor
 *   is reached, so `signal.aborted` may already be true on the very first line.
 *   Starting anyway is work nobody can receive.
 */
export interface IJobAcceptor {
  readonly type: string

  accept(job: RatchetJQJob, signal: AbortSignal): Promise<RatchetJQAcceptVerdict>
}
