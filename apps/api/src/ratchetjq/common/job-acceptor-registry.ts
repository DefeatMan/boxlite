/*
 * Copyright 2026 BoxLite AI
 * SPDX-License-Identifier: AGPL-3.0
 */

import { Inject, Injectable } from '@nestjs/common'
import { IJobAcceptor } from './job-acceptor'

/**
 * The provider token carrying every acceptor this process can run, as one array.
 *
 * A token rather than a `register` call because it makes the list a declaration
 * in the module instead of a side effect timed against startup: acceptors are
 * constructed by the injector, with whatever repositories and services they
 * need, and the registry cannot be asked for an acceptor before the list that
 * built it exists. It is the same static list as the runner's `jobs.JobTypes()`
 * (`apps/runner/pkg/ratchetjq/jobs/registry.go:JobTypes`), reached through Nest
 * instead of a package variable.
 */
export const RATCHETJQ_JOB_ACCEPTORS = 'RATCHETJQ_JOB_ACCEPTORS'

/**
 * Maps a job type name to the acceptor that decides its outcome — the spec's
 * `CreateJobAcceptor`.
 *
 * It hands back the registered acceptor rather than a per-job instance, which is
 * where it parts company with the runner's JobFactory
 * (`apps/runner/pkg/ratchetjq/factory.go:JobFactory.Create`): that one calls `Attach` because a
 * Go job type embeds its entity, while an acceptor takes the job as an argument
 * and so has nothing to bind. The consequence is the contract on IJobAcceptor —
 * one acceptor serves every job of its type, so it must hold no per-job state.
 */
@Injectable()
export class RatchetJQJobAcceptorRegistry {
  private readonly acceptors = new Map<string, IJobAcceptor>()

  constructor(@Inject(RATCHETJQ_JOB_ACCEPTORS) acceptors: IJobAcceptor[]) {
    for (const acceptor of acceptors) {
      this.register(acceptor)
    }
  }

  /**
   * The acceptor for a job type, or undefined when this process cannot accept
   * that type at all.
   *
   * Undefined rather than a throw because the caller has something to do about
   * it: the Scanner leaves such a job to its lease, exactly as the runner's
   * poller does for a type it cannot build
   * (`apps/runner/pkg/ratchetjq/poller.go:dispatch`).
   */
  acceptorFor(type: string): IJobAcceptor | undefined {
    return this.acceptors.get(type)
  }

  /**
   * Adds one acceptor, keyed by the name its own `type` reports.
   *
   * Everything checkable once is checked here, at process start, rather than on
   * the first job that names the type: an empty name, a missing `accept`, and a
   * second claim on a name already taken. Private because the injected list is the
   * only way in — an acceptor registered later would be one the Scanner had
   * already turned away.
   *
   * `accept` is required by IJobAcceptor, so the compiler already refuses an
   * implementation without one; this catches the way in that the compiler cannot
   * see, a provider bound to the injection token by a factory whose return type
   * was widened or cast. Failing at boot beats failing on the first job of that
   * type, which is the moment the Scanner has an outcome in hand and nowhere to
   * take it.
   */
  private register(acceptor: IJobAcceptor): void {
    if (!acceptor.type) {
      throw new Error('A RatchetJQ job acceptor reported an empty type name')
    }
    if (typeof acceptor.accept !== 'function') {
      throw new Error(`RatchetJQ job acceptor for type "${acceptor.type}" has no accept`)
    }
    if (this.acceptors.has(acceptor.type)) {
      throw new Error(`Two RatchetJQ job acceptors claim the type "${acceptor.type}"`)
    }

    this.acceptors.set(acceptor.type, acceptor)
  }
}
