// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (c) 2026 BoxLite AI

/// <reference path="../../.sst/platform/config.d.ts" />

import { PRODUCTION_STAGE } from '../../stack/settings.js'
import type { StackModule } from '../pipeline/module.js'
import type { StackContext } from '../stack-context.js'

/*
 * Resolve what this deploy is: which region and account, which stage's domains and version, which
 * issuer, which runners. Everything downstream reads its configuration from here rather than from
 * process.env, so there is one place the stage's inputs are validated.
 *
 * The only resolve phase in the manifest that talks to the cloud. sts:GetCallerIdentity answers
 * from a regional endpoint that can be cold or throttled, and every job behind this one is waiting
 * on it, so its retry policy is the widest in pipeline.yml.
 *
 * Loaded dynamically for the reason sst.config.ts does the same: deployment/sst.ts composes the
 * deploy environment, and importing these at module scope would read process.env before that
 * composition has necessarily finished.
 */
async function resolveConfig() {
  const {
    optionalPublicOidcIssuer,
    readWorkspaceVersion,
    requireOidcIssuer,
    resolveAwsRegion,
    resolvePublicDeploymentConfig,
  } = await import('../../deployment/environment.js')
  // eslint-disable-next-line @nx/enforce-module-boundaries -- Stack synthesis shares the policy host's CommonJS Runner model.
  const { resolveRunnerInventory } = await import('../../runner/model/inventory.js')

  const region = resolveAwsRegion()
  const { accountId } = await aws.getCallerIdentity()
  const workspaceVersion = readWorkspaceVersion()

  return {
    region,
    accountId,
    deployment: resolvePublicDeploymentConfig(process.env, workspaceVersion),
    runnerInventory: resolveRunnerInventory(process.env),
    oidcIssuer: requireOidcIssuer(),
    publicOidcIssuer: optionalPublicOidcIssuer(),
  }
}

export const config: StackModule<StackContext, Awaited<ReturnType<typeof resolveConfig>>> = {
  id: 'config',
  resolve: resolveConfig,

  declare(_context, resolved) {
    const { stackDomain, proxyDomain, proxyProtocol, proxyTemplateUrl, releaseVersion } = resolved.deployment

    // HTTPS everywhere: the Router CloudFront Function deletes customOriginConfig for http origins
    // and CF then falls back to match-viewer (→ tries HTTPS on a port-80-only ALB → 502). We
    // side-step that by giving the Api and Dex ALBs HTTPS listeners with a wildcard ACM cert, so
    // Router routes to https:// origins and the non-buggy branch runs.
    const cloudflareDns = sst.cloudflare.dns()

    return {
      region: resolved.region,
      accountId: resolved.accountId,
      // Durable state survives accidental teardown: `removal: 'retain'` (stack/app.ts) keeps prod
      // resources on `sst remove`, but does NOT stop a targeted destroy, a replace-on-immutable-
      // change, or an AWS-console delete — so prod also gets RDS deletion-protection and a final
      // snapshot, both keyed off this flag in the foundation job.
      isProd: $app.stage === PRODUCTION_STAGE,
      stackDomain,
      proxyDomain,
      proxyProtocol,
      proxyTemplateUrl,
      releaseVersion,
      oidcIssuer: resolved.oidcIssuer,
      publicOidcIssuer: resolved.publicOidcIssuer,
      runnerInventory: resolved.runnerInventory,
      defaultRunnerConfig: resolved.runnerInventory[0],
      cloudflareDns,
      serviceDomain: (name: string) => ({ name: `${name}.${stackDomain}`, dns: cloudflareDns }),
      // Strip trailing slash from service.url so path concat produces clean URLs
      // (api.url = "https://api.dev.boxlite.ai/" → apiBase = "https://api.dev.boxlite.ai").
      stripTrailingSlash: (url: $util.Output<string>) => url.apply((u) => (u.endsWith('/') ? u.slice(0, -1) : u)),
      randomKey: (name: string, length = 32) => new random.RandomPassword(name, { length, special: false }),
    }
  },
}
