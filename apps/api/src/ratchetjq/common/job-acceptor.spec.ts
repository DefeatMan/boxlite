/*
 * Copyright 2026 BoxLite AI
 * SPDX-License-Identifier: AGPL-3.0
 */

import { RatchetJQJob } from '../entities/ratchetjq-job.entity'
import {
  AsyncAcceptor,
  IAsyncJobAcceptor,
  IJobAcceptor,
  ISyncJobAcceptor,
  RatchetJQAcceptVerdict,
  SyncAcceptor,
} from './job-acceptor'

const JOB = { id: 'job-1', type: 'demo' } as RatchetJQJob

/** A signal that never aborts, for the cases where nothing gives up on an accept. */
function liveSignal(): AbortSignal {
  return new AbortController().signal
}

/** Resolves after the event loop has turned, which is where the adaptation runs. */
function loopTurn(): Promise<void> {
  return new Promise((resolve) => setImmediate(resolve))
}

// --- fakes -------------------------------------------------------------------

/**
 * Implements only the inline form, so it is what exercises AsyncAcceptor's
 * adaptation. It decides without awaiting anything, which is the case that would
 * run on the caller's stack if the adaptation did not defer: an `async` body
 * reaching no `await` of its own runs to completion on the call.
 */
class InlineOnly implements ISyncJobAcceptor {
  readonly type = 'inline-only'
  calls = 0
  signals: AbortSignal[] = []

  constructor(
    private readonly outcome: RatchetJQAcceptVerdict | Error,
    private readonly trace: string[] = [],
  ) {}

  async syncAccept(_job: RatchetJQJob, signal: AbortSignal): Promise<RatchetJQAcceptVerdict> {
    this.calls += 1
    this.signals.push(signal)
    this.trace.push('accept')
    if (this.outcome instanceof Error) {
      throw this.outcome
    }
    return this.outcome
  }
}

/** Implements only the asynchronous form, so an inline accept has nothing to fall back on. */
class DeferredOnly implements IAsyncJobAcceptor {
  readonly type = 'deferred-only'
  calls = 0
  signals: AbortSignal[] = []

  constructor(private readonly verdict: RatchetJQAcceptVerdict) {}

  async asyncAccept(_job: RatchetJQJob, signal: AbortSignal): Promise<RatchetJQAcceptVerdict> {
    this.calls += 1
    this.signals.push(signal)
    return this.verdict
  }
}

/** Implements both forms, so each wrapper must reach its own. */
class BothForms implements ISyncJobAcceptor, IAsyncJobAcceptor {
  readonly type = 'both-forms'
  inlineCalls = 0
  deferredCalls = 0

  async syncAccept(): Promise<RatchetJQAcceptVerdict> {
    this.inlineCalls += 1
    return RatchetJQAcceptVerdict.ACCEPTED
  }

  async asyncAccept(): Promise<RatchetJQAcceptVerdict> {
    this.deferredCalls += 1
    return RatchetJQAcceptVerdict.ROLLBACK
  }
}

/** Implements neither form, so nothing could ever call it. */
const NO_FORM: IJobAcceptor = { type: 'no-form' }

// --- SyncAcceptor ------------------------------------------------------------

describe('SyncAcceptor', () => {
  it('returns the verdict the acceptor decided on', async () => {
    const acceptor = new InlineOnly(RatchetJQAcceptVerdict.ROLLBACK)

    await expect(SyncAcceptor.accept(acceptor, JOB, liveSignal())).resolves.toBe(RatchetJQAcceptVerdict.ROLLBACK)
    expect(acceptor.calls).toBe(1)
  })

  it('propagates the acceptor error to its caller', async () => {
    const acceptor = new InlineOnly(new Error('cannot reach the box'))

    await expect(SyncAcceptor.accept(acceptor, JOB, liveSignal())).rejects.toThrow('cannot reach the box')
  })

  it('refuses an acceptor that only has a deferred form', async () => {
    const acceptor = new DeferredOnly(RatchetJQAcceptVerdict.ACCEPTED)

    await expect(SyncAcceptor.accept(acceptor, JOB, liveSignal())).rejects.toThrow('has no inline form')
    expect(acceptor.calls).toBe(0)
  })

  it('refuses an acceptor with neither form', async () => {
    await expect(SyncAcceptor.accept(NO_FORM, JOB, liveSignal())).rejects.toThrow('has no inline form')
  })

  it("hands the caller's own signal to the acceptor", async () => {
    const acceptor = new InlineOnly(RatchetJQAcceptVerdict.ACCEPTED)
    const signal = liveSignal()

    await SyncAcceptor.accept(acceptor, JOB, signal)

    expect(acceptor.signals).toEqual([signal])
  })
})

// --- AsyncAcceptor ----------------------------------------------------------

describe('AsyncAcceptor', () => {
  it("prefers the acceptor's own deferred form", async () => {
    const acceptor = new DeferredOnly(RatchetJQAcceptVerdict.ROLLBACK)

    await expect(AsyncAcceptor.accept(acceptor, JOB, liveSignal())).resolves.toBe(RatchetJQAcceptVerdict.ROLLBACK)
    expect(acceptor.calls).toBe(1)
  })

  it('adapts an inline-only acceptor and resolves with its verdict', async () => {
    const acceptor = new InlineOnly(RatchetJQAcceptVerdict.ACCEPTED)

    await expect(AsyncAcceptor.accept(acceptor, JOB, liveSignal())).resolves.toBe(RatchetJQAcceptVerdict.ACCEPTED)
    expect(acceptor.calls).toBe(1)
  })

  it('returns before an inline acceptor has run at all', async () => {
    const acceptor = new InlineOnly(RatchetJQAcceptVerdict.ACCEPTED)

    const pending = AsyncAcceptor.accept(acceptor, JOB, liveSignal())

    // Nothing ran on this stack, and nothing runs when the microtask queue
    // drains either — a microtask-based defer would already have decided by here.
    expect(acceptor.calls).toBe(0)
    await Promise.resolve()
    expect(acceptor.calls).toBe(0)

    await expect(pending).resolves.toBe(RatchetJQAcceptVerdict.ACCEPTED)
  })

  it('lets work already queued on the loop run before the adapted accept', async () => {
    const order: string[] = []
    const acceptor = new InlineOnly(RatchetJQAcceptVerdict.ACCEPTED, order)
    setImmediate(() => order.push('pending-io'))

    await AsyncAcceptor.accept(acceptor, JOB, liveSignal())
    await loopTurn()

    expect(order).toEqual(['pending-io', 'accept'])
  })

  // Nothing is swallowed: the caller that knows which row this was decides to log
  // it and leave the row to its lease.
  it('rejects with the failure of an adapted acceptor', async () => {
    const acceptor = new InlineOnly(new Error('cannot reach the box'))

    await expect(AsyncAcceptor.accept(acceptor, JOB, liveSignal())).rejects.toThrow('cannot reach the box')
    expect(acceptor.calls).toBe(1)
  })

  it('refuses an acceptor with neither form', async () => {
    await expect(AsyncAcceptor.accept(NO_FORM, JOB, liveSignal())).rejects.toThrow('implements neither accept form')
  })

  it("hands the caller's own signal to a deferred acceptor", async () => {
    const acceptor = new DeferredOnly(RatchetJQAcceptVerdict.ACCEPTED)
    const signal = liveSignal()

    await AsyncAcceptor.accept(acceptor, JOB, signal)

    expect(acceptor.signals).toEqual([signal])
  })

  it("hands the caller's own signal to an adapted inline acceptor", async () => {
    const acceptor = new InlineOnly(RatchetJQAcceptVerdict.ACCEPTED)
    const signal = liveSignal()

    await AsyncAcceptor.accept(acceptor, JOB, signal)

    expect(acceptor.signals).toEqual([signal])
  })

  // The deferral is what makes this reachable: a turn passes between the caller
  // asking and the acceptor running, and that is long enough for the caller to
  // have given up. Starting the acceptor then would be exactly the abandoned work
  // the signal exists to prevent.
  it('never starts an inline acceptor abandoned during the turn it waited', async () => {
    const acceptor = new InlineOnly(RatchetJQAcceptVerdict.ACCEPTED)
    const controller = new AbortController()
    const reason = new Error('nobody is waiting for this verdict')

    const pending = AsyncAcceptor.accept(acceptor, JOB, controller.signal)
    controller.abort(reason)

    await expect(pending).rejects.toBe(reason)
    await loopTurn()
    expect(acceptor.calls).toBe(0)
  })
})

// --- both forms -------------------------------------------------------------

describe('an acceptor with both forms', () => {
  it('is reached through the form each wrapper is for', async () => {
    const acceptor = new BothForms()

    await expect(SyncAcceptor.accept(acceptor, JOB, liveSignal())).resolves.toBe(RatchetJQAcceptVerdict.ACCEPTED)
    await expect(AsyncAcceptor.accept(acceptor, JOB, liveSignal())).resolves.toBe(RatchetJQAcceptVerdict.ROLLBACK)

    expect(acceptor.inlineCalls).toBe(1)
    expect(acceptor.deferredCalls).toBe(1)
  })
})
