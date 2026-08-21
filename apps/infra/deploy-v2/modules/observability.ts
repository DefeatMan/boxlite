// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (c) 2026 BoxLite AI

/// <reference path="../../.sst/platform/config.d.ts" />

import type { StackModule } from '../pipeline/module.js'
import type { StackContext } from '../stack-context.js'

/*
 * Ingest, created before the Api so API, runner, host, and box can all emit OTLP to the same
 * Collector. ECS stdout/stderr remains in CloudWatch.
 *
 * Jaeger is VPC-internal only: the trace UI exposes every span (URLs, headers, IDs, SQL, error
 * bodies) with no auth over plain HTTP, and its OTLP ingest is equally unauthenticated — reach the
 * UI via VPN / bastion / `aws ssm start-session`. JAEGER_PUBLIC is rejected (fail loud) like
 * MAILDEV_PUBLIC: no auth gate or TLS story makes public exposure safe.
 */
const loadObservability = () => import('../../stack/observability.js')

export const observability: StackModule<StackContext, Awaited<ReturnType<typeof loadObservability>>> = {
  id: 'observability',
  resolve: loadObservability,

  declare(context, { buildObservability }) {
    const { otelCollector, otelCollectorOtlpHttpUrl } = buildObservability({
      cluster: context.foundation.cluster,
      stackDomain: context.stackDomain,
      adminApiKey: context.adminApiKey,
      clickHouseResources: context.clickHouseResources,
      collectorExporters: context.collectorExporters,
      collectorTraceExporters: context.collectorTraceExporters,
      stripTrailingSlash: context.stripTrailingSlash,
    })

    return { otelCollector, otelCollectorOtlpHttpUrl }
  },
}
