/*
 * Copyright 2026 BoxLite AI
 * SPDX-License-Identifier: AGPL-3.0
 */

import { IJobAcceptor, RatchetJQAcceptVerdict } from './job-acceptor'
import { RatchetJQJobAcceptorRegistry } from './job-acceptor-registry'

class Accepting implements IJobAcceptor {
  constructor(readonly type: string) {}

  async accept(): Promise<RatchetJQAcceptVerdict> {
    return RatchetJQAcceptVerdict.ACCEPTED
  }
}

describe('RatchetJQJobAcceptorRegistry', () => {
  it('hands back the acceptor registered under a job type', () => {
    const acceptor = new Accepting('box.delete')
    const registry = new RatchetJQJobAcceptorRegistry([acceptor, new Accepting('box.create')])

    expect(registry.acceptorFor('box.delete')).toBe(acceptor)
    expect(registry.acceptorFor('box.create')).toBeInstanceOf(Accepting)
  })

  // Undefined rather than a throw, because the Scanner has something to do about
  // it: leave the job to its lease.
  it('reports nothing for a type it does not have', () => {
    const registry = new RatchetJQJobAcceptorRegistry([new Accepting('box.delete')])

    expect(registry.acceptorFor('box.create')).toBeUndefined()
  })

  it('refuses an acceptor with an empty type name', () => {
    expect(() => new RatchetJQJobAcceptorRegistry([new Accepting('')])).toThrow('empty type name')
  })

  // The compiler already refuses an implementation without `accept`; what this
  // covers is the way in it cannot see — a provider bound to the injection token
  // by a factory whose return type was widened or cast.
  it('refuses an acceptor with no accept at all', () => {
    expect(() => new RatchetJQJobAcceptorRegistry([{ type: 'no-form' } as IJobAcceptor])).toThrow('has no accept')
  })

  // Two acceptors under one name would make dispatch depend on list order, so it
  // is refused at startup rather than resolved silently.
  it('refuses a second claim on a type already taken', () => {
    expect(() => new RatchetJQJobAcceptorRegistry([new Accepting('box.delete'), new Accepting('box.delete')])).toThrow(
      'claim the type "box.delete"',
    )
  })
})
