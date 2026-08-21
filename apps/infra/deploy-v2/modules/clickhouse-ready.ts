// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (c) 2026 BoxLite AI

/// <reference path="../../.sst/platform/config.d.ts" />

import type { StackModule } from '../pipeline/module.js'
import type { StackContext } from '../stack-context.js'

/*
 * What the Api waits on before it writes telemetry: a smoke check against a ClickHouse that is
 * actually reachable, the collector itself when the backend is managed, and nothing at all when
 * the backend is disabled.
 *
 * Its own job rather than a tail of `clickhouse` because it needs the collector, and the collector
 * needs the backend — a gate that depends on both ends of the edge it guards.
 */
const loadClickHouse = () => import('../../stack/clickhouse.js')

export const clickhouseReady: StackModule<StackContext, Awaited<ReturnType<typeof loadClickHouse>>> = {
  id: 'clickhouse-ready',
  resolve: loadClickHouse,

  declare(context, { buildClickHouseWriterReady }) {
    return {
      clickHouseReadyDependency: buildClickHouseWriterReady({
        region: context.region,
        resources: context.clickHouseResources,
        otelCollector: context.otelCollector,
        otelCollectorOtlpHttpUrl: context.otelCollectorOtlpHttpUrl,
      }),
    }
  },
}
