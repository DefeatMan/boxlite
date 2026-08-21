// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (c) 2026 BoxLite AI

/// <reference path="../../.sst/platform/config.d.ts" />

import type { StackModule } from '../pipeline/module.js'
import type { StackContext } from '../stack-context.js'

/*
 * Boots Ubuntu EC2 hosts that run the prebuilt runner binary under systemd, with nested KVM
 * enabled for box VMs.
 *
 * Where that binary comes from is the mirror of the Api's choice. `release` — the default, and all
 * this stack could do before — installs the published GitHub Release asset for a version. `build`
 * installs a binary produced from the deployed commit and staged in the artifacts bucket, which is
 * what makes an unreleased Runner change testable at all.
 *
 * Both install paths (user-data at first boot, SSM for a live host) take the same URL + checksum
 * pair, so the source only changes where the two URLs point and which command fetches them — see
 * artifacts/runner.ts.
 *
 * The stage bootstrap template owns that private bucket for the same ordering reason it owns the
 * API repository: CI stages the object before this stack can consume it. The name is derived in
 * one helper shared with the preflight and the staging command.
 *
 * Durable state survives accidental teardown the way the foundation's does.
 */
const loadRunners = () => import('../../stack/runners.js')

export const runners: StackModule<StackContext, Awaited<ReturnType<typeof loadRunners>>> = {
  id: 'runners',
  resolve: loadRunners,

  async declare(context, { buildRunners }) {
    await buildRunners({
      foundation: context.foundation,
      api: context.api,
      otelCollectorOtlpHttpUrl: context.otelCollectorOtlpHttpUrl,
      region: context.region,
      accountId: context.accountId,
      runnerInventory: context.runnerInventory,
      defaultRunnerConfig: context.defaultRunnerConfig,
      defaultRunnerApiKey: context.defaultRunnerApiKey,
      adminApiKey: context.adminApiKey,
      randomKey: context.randomKey,
    })

    return {}
  },
}
