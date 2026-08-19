/*
 * Copyright 2026 BoxLite AI
 * SPDX-License-Identifier: AGPL-3.0
 */

import { setTimeout as sleep } from 'timers/promises'
import { RatchetJQJob } from '../entities/ratchetjq-job.entity'
import { RatchetJQJobPeriod } from '../enums/ratchetjq-job-period.enum'
import { RatchetJQAcceptRound } from './accept-round'
import { IJobAcceptor, RatchetJQAcceptVerdict } from './job-acceptor'

/**
 * An accept budget of 0.2s, which puts the heartbeat at its 100ms floor and the
 * unattended form's budget within a test's patience. A submission cannot carry a
 * fractional budget; this is the row a test needs, not the row a submitter writes.
 */
const ATTL_SECONDS = 0.2
const HEARTBEAT_MS = 100

function acceptingJob(type: string): RatchetJQJob {
  return { id: 'job-1', type, attlSeconds: ATTL_SECONDS, period: RatchetJQJobPeriod.ACCEPTING } as RatchetJQJob
}

/** An acceptor whose verdict is decided by the test, after it has been entered. */
class GatedAcceptor implements IJobAcceptor {
  readonly type = 'gated'
  signals: AbortSignal[] = []

  private announceEntered: () => void = () => undefined
  /** Resolves once the acceptor has actually been called, so a test never races it. */
  readonly entered = new Promise<void>((resolve) => {
    this.announceEntered = resolve
  })

  private settle: (verdict: RatchetJQAcceptVerdict) => void = () => undefined
  private fail: (error: Error) => void = () => undefined

  accept(_job: RatchetJQJob, signal: AbortSignal): Promise<RatchetJQAcceptVerdict> {
    this.signals.push(signal)
    const decided = new Promise<RatchetJQAcceptVerdict>((resolve, reject) => {
      this.settle = resolve
      this.fail = reject
    })
    this.announceEntered()

    return decided
  }

  /** Releases the gate with an ACCEPTED verdict. Named apart from the contract's
   * own `accept`, which is what the round calls. */
  release(): void {
    this.settle(RatchetJQAcceptVerdict.ACCEPTED)
  }

  refuse(error: Error): void {
    this.fail(error)
  }
}

/** An acceptor that never settles and ignores its signal: the worst case a bound exists for. */
class SilentAcceptor implements IJobAcceptor {
  readonly type = 'silent'
  signals: AbortSignal[] = []

  accept(_job: RatchetJQJob, signal: AbortSignal): Promise<RatchetJQAcceptVerdict> {
    this.signals.push(signal)
    return new Promise<RatchetJQAcceptVerdict>(() => undefined)
  }
}

function makeRound(acceptors: IJobAcceptor[], options: { rowsRenewed?: number } = {}) {
  const query = jest.fn(async () => (options.rowsRenewed === 0 ? [] : [{ id: 'job-1' }]))
  const registry = {
    acceptorFor: jest.fn((type: string) => acceptors.find((acceptor) => acceptor.type === type)),
  }
  const finalizer = { finalize: jest.fn(async () => undefined) }
  const round = new RatchetJQAcceptRound({ query } as never, registry as never, finalizer as never)

  return { round, query, registry, finalizer }
}

/** Polls a condition on real timers, which is what the heartbeat and the budget run on. */
async function until(condition: () => boolean, what: string): Promise<void> {
  for (let waited = 0; waited < 2_000; waited += 10) {
    if (condition()) {
      return
    }
    await sleep(10)
  }

  throw new Error(`timed out waiting for ${what}`)
}

describe('RatchetJQAcceptRound inline', () => {
  it('hands the verdict its acceptor decided to the finalizer', async () => {
    const acceptor = new GatedAcceptor()
    const { round, finalizer } = makeRound([acceptor])

    const inline = round.runInline(acceptingJob('gated'))
    await acceptor.entered
    acceptor.release()
    await inline

    expect(finalizer.finalize).toHaveBeenCalledWith(
      expect.objectContaining({ id: 'job-1' }),
      RatchetJQAcceptVerdict.ACCEPTED,
    )
  })

  // The point of the heartbeat: a Scanner must not retry an accept that is merely
  // slow, so the lease is pushed back out while the acceptor is still deciding.
  it('holds the accept lease while the acceptor is deciding, and stops when it has', async () => {
    const acceptor = new GatedAcceptor()
    const { round, query } = makeRound([acceptor])

    const inline = round.runInline(acceptingJob('gated'))
    await acceptor.entered
    await until(() => query.mock.calls.length >= 2, 'two heartbeat renewals')

    const [sql, parameters] = query.mock.calls[0] as unknown as [string, unknown[]]
    // Monotonic: a row already retried holds MAX(attlSeconds, attempt⁴), and a
    // flat write would shorten the very lease this exists to hold.
    expect(sql).toContain('GREATEST("leaseExpiresAt", now() + "attlSeconds" * interval \'1 second\')')
    expect(parameters).toEqual(['job-1', RatchetJQJobPeriod.ACCEPTING])

    acceptor.release()
    await inline

    const renewalsAtExit = query.mock.calls.length
    await sleep(HEARTBEAT_MS * 3)
    expect(query.mock.calls.length).toBe(renewalsAtExit)
  })

  // A row that left `accepting` has no lease to hold, and renewing it forever
  // would be a statement per interval for the rest of the round.
  it('stops renewing once the row has left accepting', async () => {
    const acceptor = new GatedAcceptor()
    const { round, query } = makeRound([acceptor], { rowsRenewed: 0 })

    const inline = round.runInline(acceptingJob('gated'))
    await acceptor.entered
    await until(() => query.mock.calls.length >= 1, 'the first heartbeat renewal')
    await sleep(HEARTBEAT_MS * 3)

    expect(query).toHaveBeenCalledTimes(1)

    acceptor.release()
    await inline
  })

  // Strict, because the caller is holding a REST request open: it has to learn
  // that no accept happened rather than be told one did.
  it('refuses a job type no acceptor claims', async () => {
    const { round, finalizer } = makeRound([])

    await expect(round.runInline(acceptingJob('unregistered'))).rejects.toThrow('No RatchetJQ acceptor')
    expect(finalizer.finalize).not.toHaveBeenCalled()
  })

  // The spec's throw path: no terminal state at all, the heartbeat stopped, and
  // the row left `accepting` for lease expiry plus the Scanner.
  it('writes no terminal state when the acceptor fails, and stops the heartbeat', async () => {
    const acceptor = new GatedAcceptor()
    const { round, query, finalizer } = makeRound([acceptor])

    const inline = round.runInline(acceptingJob('gated'))
    await acceptor.entered
    acceptor.refuse(new Error('the acceptor could not reach the object store'))

    await expect(inline).rejects.toThrow('could not reach the object store')
    expect(finalizer.finalize).not.toHaveBeenCalled()

    const renewalsAtExit = query.mock.calls.length
    await sleep(HEARTBEAT_MS * 3)
    expect(query.mock.calls.length).toBe(renewalsAtExit)
  })

  // Nothing else bounds an inline accept, so without this a hung acceptor would
  // renew the lease forever and the row would never become retryable at all.
  it('ends the round when its reporter hangs up, and tells the acceptor', async () => {
    const acceptor = new SilentAcceptor()
    const { round, query, finalizer } = makeRound([acceptor])
    const reporter = new AbortController()

    const inline = round.runInline(acceptingJob('silent'), reporter.signal)
    await until(() => acceptor.signals.length === 1, 'the acceptor to be entered')
    reporter.abort(new Error('the reporting executor disconnected'))

    await expect(inline).rejects.toThrow('nothing is waiting for the accept')
    expect(finalizer.finalize).not.toHaveBeenCalled()
    // Ending the wait is not enough: this acceptor ignores its signal, so what is
    // asserted is that the round aborted it rather than that the work stopped.
    expect(acceptor.signals[0].aborted).toBe(true)

    const renewalsAtExit = query.mock.calls.length
    await sleep(HEARTBEAT_MS * 3)
    expect(query.mock.calls.length).toBe(renewalsAtExit)
  })

  // The acceptor is called directly, so a round whose reporter had already gone
  // still enters it — with a signal that is already aborted, which the contract
  // asks it to check on entry. What protects the round either way is the race: it
  // rejects without waiting on an acceptor nobody is listening to.
  it('refuses a round whose reporter had already hung up, handing on the dead signal', async () => {
    const acceptor = new SilentAcceptor()
    const { round } = makeRound([acceptor])

    await expect(round.runInline(acceptingJob('silent'), AbortSignal.abort())).rejects.toThrow(
      'nothing is waiting for the accept',
    )
    expect(acceptor.signals).toHaveLength(1)
    expect(acceptor.signals[0].aborted).toBe(true)
  })
})

describe('RatchetJQAcceptRound unattended', () => {
  it('accepts through the accommodating driver and finalizes the verdict', async () => {
    const acceptor = new GatedAcceptor()
    const { round, finalizer } = makeRound([acceptor])

    const unattended = round.runUnattended(acceptingJob('gated'))
    await acceptor.entered
    acceptor.release()
    await unattended

    expect(finalizer.finalize).toHaveBeenCalledWith(
      expect.objectContaining({ id: 'job-1' }),
      RatchetJQAcceptVerdict.ACCEPTED,
    )
  })

  // No heartbeat here, so the accept budget is the whole of the bound: an accept
  // that outlives it is dropped and the row is left to the Scanner.
  it('gives up once the accept budget lapses, and aborts the acceptor', async () => {
    const acceptor = new SilentAcceptor()
    const { round, finalizer } = makeRound([acceptor])

    await round.runUnattended(acceptingJob('silent'))

    expect(finalizer.finalize).not.toHaveBeenCalled()
    expect(acceptor.signals[0].aborted).toBe(true)
  })

  // It is called without being awaited, so a rejection would have no caller and
  // would surface as an unhandled one.
  it('never rejects, whatever the round does', async () => {
    const acceptor = new GatedAcceptor()
    const { round, finalizer } = makeRound([acceptor])
    finalizer.finalize.mockRejectedValueOnce(new Error('deadlock detected') as never)

    const unattended = round.runUnattended(acceptingJob('gated'))
    await acceptor.entered
    acceptor.release()

    await expect(unattended).resolves.toBeUndefined()
  })

  it('leaves a job whose type no acceptor claims to its lease', async () => {
    const { round, finalizer, query } = makeRound([])

    await round.runUnattended(acceptingJob('unregistered'))

    expect(finalizer.finalize).not.toHaveBeenCalled()
    // Not even a renewal: an unattended round holds no lease of its own.
    expect(query).not.toHaveBeenCalled()
  })
})
