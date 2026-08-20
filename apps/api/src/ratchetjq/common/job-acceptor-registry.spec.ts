/*
 * Copyright 2026 BoxLite AI
 * SPDX-License-Identifier: AGPL-3.0
 */

import { IAsyncJobAcceptor, ISyncJobAcceptor, RatchetJQAcceptVerdict } from './job-acceptor'
import { RatchetJQJobAcceptorRegistry } from './job-acceptor-registry'

class Inline implements ISyncJobAcceptor {
  constructor(readonly type: string) {}

  async syncAccept(): Promise<RatchetJQAcceptVerdict> {
    return RatchetJQAcceptVerdict.ACCEPTED
  }
}

class Deferred implements IAsyncJobAcceptor {
  readonly type = 'deferred'

  async asyncAccept(): Promise<RatchetJQAcceptVerdict> {
    return RatchetJQAcceptVerdict.ACCEPTED
  }
}

describe('RatchetJQJobAcceptorRegistry', () => {
  it('hands back the acceptor registered under a job type', () => {
    const inline = new Inline('box.delete')
    const registry = new RatchetJQJobAcceptorRegistry([inline, new Deferred()])

    expect(registry.acceptorFor('box.delete')).toBe(inline)
    expect(registry.acceptorFor('deferred')).toBeInstanceOf(Deferred)
  })

  // Undefined rather than a throw, because the Scanner has something to do about
  // it: leave the job to its lease.
  it('reports nothing for a type it does not have', () => {
    const registry = new RatchetJQJobAcceptorRegistry([new Inline('box.delete')])

    expect(registry.acceptorFor('box.create')).toBeUndefined()
  })

  it('refuses an acceptor with an empty type name', () => {
    expect(() => new RatchetJQJobAcceptorRegistry([new Inline('')])).toThrow('empty type name')
  })

  it('refuses an acceptor that implements neither form', () => {
    expect(() => new RatchetJQJobAcceptorRegistry([{ type: 'no-form' }])).toThrow('implements neither accept form')
  })

  // Two acceptors under one name would make dispatch depend on list order, so it
  // is refused at startup rather than resolved silently.
  it('refuses a second claim on a type already taken', () => {
    expect(() => new RatchetJQJobAcceptorRegistry([new Inline('box.delete'), new Inline('box.delete')])).toThrow(
      'claim the type "box.delete"',
    )
  })
})
