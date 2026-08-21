// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (c) 2026 BoxLite AI

/// <reference path="../../.sst/platform/config.d.ts" />

import type { StackModule } from '../pipeline/module.js'
import type { StackContext } from '../stack-context.js'

/*
 * The box proxy and the operator-facing edge services, all of which hang off the router and point
 * at the Api. Declares resources and returns nothing, so no job depends on it.
 */
const loadEdge = () => import('../../stack/edge.js')

export const edge: StackModule<StackContext, Awaited<ReturnType<typeof loadEdge>>> = {
  id: 'edge',
  resolve: loadEdge,

  declare(context, { buildEdge }) {
    buildEdge({
      foundation: context.foundation,
      api: context.api,
      router: context.router,
      proxyDomain: context.proxyDomain,
      proxyProtocol: context.proxyProtocol,
      cloudflareDns: context.cloudflareDns,
      proxyApiKey: context.proxyApiKey,
      oidcClientId: context.oidcClientId,
      oidcIssuer: context.oidcIssuer,
      publicOidcIssuer: context.publicOidcIssuer,
      otelCollectorOtlpHttpUrl: context.otelCollectorOtlpHttpUrl,
      pgAdminPassword: context.pgAdminPassword,
      stripTrailingSlash: context.stripTrailingSlash,
    })

    return {}
  },
}
